/**
 * SQLite storage inside the Archive Durable Object.
 *
 * Laid out for the Workers free plan (100k rows written, 5M rows read per
 * day): `events` is the only growing table, keyed WITHOUT ROWID on the event
 * id with no secondary indexes, so each new event costs exactly one row
 * write and re-reading an already stored event costs nothing. Every lookup
 * other than by id goes through the in-memory model (model.js).
 *
 * Every statement goes through {@link Store#exec}, which meters rows read and
 * written per UTC day so /api/sync can show how much of the quota is used.
 */
import { classify, REPLACEABLE_ROLES } from '../../lib/classify.js';
import { contentAddress, isFanfaresContent } from '../../lib/parse.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, kind INTEGER NOT NULL, pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL, role TEXT NOT NULL, address TEXT, json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS verified_purchases (
  address TEXT NOT NULL, buyer TEXT NOT NULL, amount_msats INTEGER NOT NULL,
  purchased_at INTEGER NOT NULL, PRIMARY KEY(address, buyer)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
  kind TEXT NOT NULL, status TEXT NOT NULL, summary_json TEXT
);
DROP TABLE IF EXISTS probe_events;
DROP TABLE IF EXISTS probe_runs;
`;

/** Sync history rows kept for the Live page; older runs are pruned. */
const KEEP_RUNS = 200;

export class Store {
  /**
   * @param {SqlStorage} sql `ctx.storage.sql` of the Archive Durable Object.
   */
  constructor(sql) {
    this.sql = sql;
    this.usage = { day: '', rowsRead: 0, rowsWritten: 0 };
    this.exec(SCHEMA);
    // A run still marked running was cut off by an eviction or deploy.
    this.exec("UPDATE sync_runs SET status = 'interrupted', finished_at = started_at WHERE status = 'running'");
  }

  /**
   * Runs one statement, returns its rows and adds its cost to today's meter.
   * @param {string} query SQL with `?` placeholders.
   * @param {...any} bindings Values for the placeholders.
   * @returns {object[]}
   */
  exec(query, ...bindings) {
    const cursor = this.sql.exec(query, ...bindings);
    const rows = cursor.toArray();
    this.meter(cursor.rowsRead, cursor.rowsWritten);
    return rows;
  }

  /** Adds rows read/written to the meter, resetting it at 00:00 UTC like the quota. */
  meter(read, written) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.usage.day !== day) this.usage = { day, rowsRead: 0, rowsWritten: 0 };
    this.usage.rowsRead += read;
    this.usage.rowsWritten += written;
  }

  /**
   * Streams every event row into `fn` without materialising them all at once.
   * Used only by the model rebuild.
   * @param {(row: object) => void} fn
   */
  eachEvent(fn) {
    const cursor = this.sql.exec('SELECT id, kind, pubkey, created_at, role, address, json FROM events');
    for (const row of cursor) fn(row);
    this.meter(cursor.rowsRead, cursor.rowsWritten);
  }

  /** Every worker-verified purchase imported from the legacy feed. */
  verifiedPurchases() {
    return this.exec('SELECT address, buyer, amount_msats, purchased_at FROM verified_purchases');
  }

  /** Signed JSON of the given event ids, in the same order, by primary key. */
  eventsById(ids) {
    return ids.map((id) => this.exec('SELECT json FROM events WHERE id = ?', id)[0]).filter(Boolean).map((r) => JSON.parse(r.json));
  }

  /** Reads a JSON value from the state table, or `fallback`. */
  getState(key, fallback = null) {
    const row = this.exec('SELECT value FROM state WHERE key = ?', key)[0];
    return row ? JSON.parse(row.value) : fallback;
  }

  /** Writes a JSON value to the state table. */
  setState(key, value) {
    this.exec('INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  /**
   * Stores raw relay events the archive keeps, skipping known ones.
   * Replaceable user events (0/3/10002/10019) keep only the newest per
   * author and kind. `ctx` is the live model: its `targets` and
   * `replaceable` maps are updated in place so later events in the same
   * sync (a zap for a release found minutes ago) classify correctly.
   * @param {object[]} events Raw events from relays or the one-time import.
   * @param {{targets: Set<string>, replaceable: Map<string, {id: string, createdAt: number}>}} ctx
   * @returns {Record<string, number>} New events stored, per role.
   */
  ingest(events, ctx) {
    const added = {};
    // Content first so payments in the same batch resolve against it.
    const sorted = [...events].sort((a, b) => Number(isFanfaresContent(b)) - Number(isFanfaresContent(a)));
    for (const ev of sorted) {
      if (typeof ev?.id !== 'string' || typeof ev.pubkey !== 'string' || typeof ev.kind !== 'number' || !Array.isArray(ev.tags)) continue;
      const role = classify(ev, ctx.targets);
      if (!role) continue;
      const key = `${ev.pubkey}:${ev.kind}`;
      const current = REPLACEABLE_ROLES.has(role) ? ctx.replaceable.get(key) : null;
      if (current && current.createdAt >= ev.created_at) continue;
      const address = role === 'content' ? contentAddress(ev) : null;
      const cursor = this.sql.exec('INSERT OR IGNORE INTO events(id, kind, pubkey, created_at, role, address, json) VALUES(?, ?, ?, ?, ?, ?, ?)',
        ev.id, ev.kind, ev.pubkey, ev.created_at, role, address, JSON.stringify(ev));
      this.meter(cursor.rowsRead, cursor.rowsWritten);
      if (!cursor.rowsWritten) continue;
      added[role] = (added[role] || 0) + 1;
      if (current) this.exec('DELETE FROM events WHERE id = ?', current.id);
      if (REPLACEABLE_ROLES.has(role)) ctx.replaceable.set(key, { id: ev.id, createdAt: ev.created_at });
      if (role === 'content') { ctx.targets.add(address); ctx.targets.add(ev.id); }
    }
    return added;
  }

  /**
   * Stores worker-verified purchases from the legacy fanfares-workers feed.
   * @param {{address: string, buyer: string, msats: number, at: number}[]} rows
   * @returns {number} Rows newly stored.
   */
  importVerified(rows) {
    let n = 0;
    for (const r of rows) {
      const cursor = this.sql.exec('INSERT OR IGNORE INTO verified_purchases(address, buyer, amount_msats, purchased_at) VALUES(?, ?, ?, ?)',
        r.address, r.buyer, r.msats, r.at);
      this.meter(cursor.rowsRead, cursor.rowsWritten);
      n += cursor.rowsWritten;
    }
    return n;
  }

  /** Records the start of a sync pass; returns its run id. */
  startRun(kind, startedAt) {
    this.exec('DELETE FROM sync_runs WHERE id <= (SELECT MAX(id) FROM sync_runs) - ?', KEEP_RUNS);
    return this.exec("INSERT INTO sync_runs(started_at, kind, status) VALUES(?, ?, 'running') RETURNING id", startedAt, kind)[0].id;
  }

  /** Records how a sync pass ended. */
  finishRun(id, status, summary) {
    this.exec('UPDATE sync_runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?',
      Math.floor(Date.now() / 1000), status, JSON.stringify(summary), id);
  }

  /** The most recent sync runs, newest first, shaped for /api/sync. */
  recentRuns(limit = 15) {
    return this.exec('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?', limit)
      .map(({ summary_json: s, ...r }) => ({ ...r, summary: s ? JSON.parse(s) : null }));
  }
}
