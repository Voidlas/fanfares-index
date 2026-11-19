/**
 * Storage layer for the Fanfares Network archive.
 *
 * Every raw event the crawler sees lands once in `events` (source of truth,
 * signed JSON kept verbatim). Everything the API reads — `content`,
 * `payments`, `purchases`, `profiles`, `wallets`, `follows` — is derived from
 * `events` by {@link rebuildDerived}, so the derived tables can always be
 * dropped and rebuilt. The legacy `feed_*` tables copied from the
 * fanfares-workers feed Durable Object are left untouched and imported once.
 */
import { DatabaseSync } from 'node:sqlite';
import { classify, REPLACEABLE_ROLES } from './classify.js';
import {
  contentAddress, isFanfaresContent, parseContent, parseNutzap, parseProfile, parseZapReceipt
} from './parse.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, kind INTEGER NOT NULL, pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL, role TEXT NOT NULL, address TEXT,
  json TEXT NOT NULL, first_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_role ON events(role, created_at DESC);
CREATE INDEX IF NOT EXISTS events_pubkey ON events(pubkey, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS events_address ON events(address);

CREATE TABLE IF NOT EXISTS event_refs (
  event_id TEXT NOT NULL, tag TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(event_id, tag, value)
);
CREATE INDEX IF NOT EXISTS event_refs_value ON event_refs(tag, value);

CREATE TABLE IF NOT EXISTS content (
  address TEXT PRIMARY KEY, event_id TEXT NOT NULL, kind INTEGER NOT NULL,
  pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, first_published INTEGER NOT NULL,
  revisions INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, price_sats INTEGER NOT NULL, env TEXT NOT NULL,
  is_test INTEGER NOT NULL, meta_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS content_pubkey ON content(pubkey);
CREATE INDEX IF NOT EXISTS content_time ON content(first_published DESC);

CREATE TABLE IF NOT EXISTS payments (
  event_id TEXT PRIMARY KEY, rail TEXT NOT NULL, address TEXT, sender TEXT,
  recipient TEXT, amount_msats INTEGER NOT NULL, created_at INTEGER NOT NULL,
  comment TEXT, mint TEXT
);
CREATE INDEX IF NOT EXISTS payments_address ON payments(address);
CREATE INDEX IF NOT EXISTS payments_sender ON payments(sender);
CREATE INDEX IF NOT EXISTS payments_recipient ON payments(recipient);

CREATE TABLE IF NOT EXISTS verified_purchases (
  address TEXT NOT NULL, buyer TEXT NOT NULL, amount_msats INTEGER NOT NULL,
  purchased_at INTEGER NOT NULL, PRIMARY KEY(address, buyer)
);
CREATE TABLE IF NOT EXISTS purchases (
  address TEXT NOT NULL, buyer TEXT NOT NULL, source TEXT NOT NULL,
  amount_msats INTEGER NOT NULL, purchased_at INTEGER NOT NULL,
  rail TEXT NOT NULL, PRIMARY KEY(address, buyer)
);
CREATE INDEX IF NOT EXISTS purchases_buyer ON purchases(buyer);
CREATE INDEX IF NOT EXISTS purchases_time ON purchases(purchased_at DESC);

CREATE TABLE IF NOT EXISTS profiles (
  pubkey TEXT PRIMARY KEY, created_at INTEGER NOT NULL, name TEXT, display_name TEXT,
  picture TEXT, banner TEXT, about TEXT, nip05 TEXT, lud16 TEXT, website TEXT
);
CREATE TABLE IF NOT EXISTS wallets (
  pubkey TEXT PRIMARY KEY, created_at INTEGER NOT NULL, mints_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  follower TEXT NOT NULL, followee TEXT NOT NULL, PRIMARY KEY(follower, followee)
);
CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee);

CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL,
  finished_at INTEGER, status TEXT NOT NULL, summary_json TEXT
);
`;

/** Tags indexed into `event_refs` so engagement and payments can be joined. */
const INDEXED_TAGS = new Set(['a', 'e', 'p', 'P', 'A', 'E', 'K', 'k']);

/**
 * Opens (and migrates) the archive database. Called once by server.js and by
 * the standalone sync CLI.
 * @param {string} path Absolute path to data/fanfares.sqlite.
 */
export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Reads a sync_state value, or `fallback`. */
export function getState(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

/** Writes a sync_state value. */
export function setState(db, key, value) {
  db.prepare('INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

/**
 * Inserts raw events, skipping ones already stored or not worth keeping.
 * Replaceable user events (0/3/10002/10019) keep only the newest per author.
 * @param {DatabaseSync} db Open archive.
 * @param {object[]} events Raw events from relays.
 * @returns {Record<string, number>} New events stored, per role.
 */
export function ingest(db, events) {
  const known = knownTargets(db);
  // Content first so payments in the same batch can resolve against it.
  const sorted = [...events].sort((a, b) => (isFanfaresContent(b) ? 1 : 0) - (isFanfaresContent(a) ? 1 : 0));
  const insert = db.prepare(`INSERT OR IGNORE INTO events(id, kind, pubkey, created_at, role, address, json, first_seen)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertRef = db.prepare('INSERT OR IGNORE INTO event_refs(event_id, tag, value) VALUES(?, ?, ?)');
  const newerReplaceable = db.prepare('SELECT 1 FROM events WHERE pubkey = ? AND kind = ? AND created_at >= ? LIMIT 1');
  const dropOlder = db.prepare('DELETE FROM events WHERE pubkey = ? AND kind = ? AND created_at < ?');
  const now = Math.floor(Date.now() / 1000);
  const added = {};
  db.exec('BEGIN');
  try {
    for (const ev of sorted) {
      if (!ev?.id || !ev.pubkey || typeof ev.kind !== 'number') continue;
      const role = classify(ev, known);
      if (!role) continue;
      const replaceable = REPLACEABLE_ROLES.has(role);
      if (replaceable) {
        if (newerReplaceable.get(ev.pubkey, ev.kind, ev.created_at)) continue;
        dropOlder.run(ev.pubkey, ev.kind, ev.created_at);
      }
      const address = role === 'content' ? contentAddress(ev) : null;
      const res = insert.run(ev.id, ev.kind, ev.pubkey, ev.created_at, role, address, JSON.stringify(ev), now);
      if (!res.changes) continue;
      added[role] = (added[role] || 0) + 1;
      if (role === 'content') { known.add(address); known.add(ev.id); }
      if (role !== 'follows') {
        for (const t of ev.tags || []) {
          if (INDEXED_TAGS.has(t[0]) && typeof t[1] === 'string' && t[1]) insertRef.run(ev.id, t[0], t[1]);
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return added;
}

/** Every content address and revision id currently stored. */
export function knownTargets(db) {
  const set = new Set();
  for (const r of db.prepare("SELECT id, address FROM events WHERE role = 'content'").all()) {
    set.add(r.id);
    set.add(r.address);
  }
  return set;
}

/**
 * Imports the legacy fanfares-workers tables (content, receipts, profiles and
 * worker-verified purchases) into the new store. Runs once per database.
 * @param {DatabaseSync} db Open archive that still contains the feed_* tables.
 */
export function importLegacy(db) {
  if (getState(db, 'legacy_imported')) return null;
  const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const raw = [];
  for (const table of ['feed_content', 'feed_snapshot_events', 'feed_legacy_receipts', 'feed_author_profiles']) {
    if (!has(table)) continue;
    for (const r of db.prepare(`SELECT event_json AS j FROM ${table}`).all()) {
      try { raw.push(JSON.parse(r.j)); } catch { /* skip corrupt row */ }
    }
  }
  const added = ingest(db, raw);
  let verified = 0;
  if (has('feed_purchases') && has('feed_purchase_candidates')) {
    const rows = db.prepare(`SELECT p.address, c.buyer_pubkey AS buyer, p.purchased_at AS at, COALESCE(a.amount_msats, 0) AS msats
      FROM feed_purchases p JOIN feed_purchase_candidates c USING(purchase_key)
      LEFT JOIN feed_purchase_amounts a USING(purchase_key) WHERE p.source = 'verified'`).all();
    const ins = db.prepare('INSERT OR IGNORE INTO verified_purchases(address, buyer, amount_msats, purchased_at) VALUES(?, ?, ?, ?)');
    // The worker stored purchase times in milliseconds; everything else here is unix seconds.
    const seconds = (t) => (t > 1e12 ? Math.floor(t / 1000) : t || 0);
    for (const r of rows) verified += ins.run(r.address, r.buyer, r.msats, seconds(r.at)).changes;
  }
  setState(db, 'legacy_imported', { at: Date.now(), added, verified });
  return { added, verified };
}

/**
 * Recomputes every derived table from `events`. Cheap at archive scale
 * (thousands of rows), so it runs after every sync instead of tracking deltas.
 * @param {DatabaseSync} db Open archive.
 */
export function rebuildDerived(db) {
  db.exec('BEGIN');
  try {
    rebuildContent(db);
    rebuildPayments(db);
    rebuildPurchases(db);
    backdateFirstPublished(db);
    rebuildProfiles(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Latest revision per address, first-published time, deletion flags. */
function rebuildContent(db) {
  db.exec('DELETE FROM content');
  const rows = db.prepare("SELECT id, json, address, created_at FROM events WHERE role = 'content' ORDER BY created_at ASC").all();
  const byAddress = new Map();
  for (const r of rows) {
    const prev = byAddress.get(r.address);
    byAddress.set(r.address, {
      latest: r,
      first: prev ? prev.first : r.created_at,
      revisions: (prev?.revisions || 0) + 1
    });
  }
  const deletions = db.prepare("SELECT pubkey, json FROM events WHERE role = 'deletion'").all();
  const deleted = new Set();
  for (const d of deletions) {
    const ev = JSON.parse(d.json);
    for (const t of ev.tags || []) if ((t[0] === 'a' || t[0] === 'e') && t[1]) deleted.add(`${d.pubkey}|${t[1]}`);
  }
  const ins = db.prepare(`INSERT INTO content(address, event_id, kind, pubkey, created_at, first_published, revisions,
    deleted, title, price_sats, env, is_test, meta_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [address, v] of byAddress) {
    const ev = JSON.parse(v.latest.json);
    const meta = parseContent(ev);
    const isDeleted = deleted.has(`${ev.pubkey}|${address}`) || deleted.has(`${ev.pubkey}|${ev.id}`);
    const first = meta.publishedAt && meta.publishedAt < v.first ? meta.publishedAt : v.first;
    ins.run(address, ev.id, ev.kind, ev.pubkey, ev.created_at, first, v.revisions, isDeleted ? 1 : 0,
      meta.title, meta.priceSats, meta.env, meta.isTest ? 1 : 0, JSON.stringify(meta));
  }
}

/** One row per zap receipt / nutzap, resolved to a content address. */
function rebuildPayments(db) {
  db.exec('DELETE FROM payments');
  const idToAddress = new Map(db.prepare("SELECT id, address FROM events WHERE role = 'content'").all().map((r) => [r.id, r.address]));
  const ins = db.prepare(`INSERT OR IGNORE INTO payments(event_id, rail, address, sender, recipient, amount_msats, created_at, comment, mint)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of db.prepare("SELECT json, role FROM events WHERE role IN ('zap', 'nutzap')").all()) {
    const ev = JSON.parse(r.json);
    const leg = r.role === 'zap' ? parseZapReceipt(ev) : parseNutzap(ev);
    const address = leg.targetAddress || idToAddress.get(leg.targetEventId) || leg.targetEventId || null;
    ins.run(leg.eventId, leg.rail, address, leg.sender || null, leg.recipient || null, leg.amountMsats, leg.createdAt, leg.comment, leg.mint);
  }
}

/**
 * Purchases = worker-verified purchases (authoritative, imported from the
 * fanfares-workers feed) plus receipt-derived ones: a buyer whose payments
 * to an item's recipients add up to at least its price. Derived rows are
 * labelled so the UI never presents them as worker-verified.
 */
function rebuildPurchases(db) {
  db.exec('DELETE FROM purchases');
  db.exec('UPDATE verified_purchases SET purchased_at = purchased_at / 1000 WHERE purchased_at > 1000000000000');
  db.exec(`INSERT INTO purchases(address, buyer, source, amount_msats, purchased_at, rail)
    SELECT address, buyer, 'verified', amount_msats, purchased_at, 'lightning' FROM verified_purchases`);
  const verifiedTimes = db.prepare('UPDATE purchases SET purchased_at = ?, rail = ? WHERE address = ? AND buyer = ? AND purchased_at = 0');
  const ins = db.prepare(`INSERT OR IGNORE INTO purchases(address, buyer, source, amount_msats, purchased_at, rail)
    VALUES(?, ?, 'receipts', ?, ?, ?)`);
  const groups = db.prepare(`SELECT p.address, p.sender, SUM(p.amount_msats) AS msats, MAX(p.created_at) AS at,
      GROUP_CONCAT(DISTINCT p.rail) AS rails, c.price_sats
    FROM payments p JOIN content c ON c.address = p.address
    WHERE p.sender IS NOT NULL AND p.sender != c.pubkey GROUP BY p.address, p.sender`).all();
  for (const g of groups) {
    const rail = g.rails.includes(',') ? 'mixed' : g.rails;
    verifiedTimes.run(g.at, rail, g.address, g.sender);
    if (g.price_sats > 0 && g.msats >= g.price_sats * 1000) ins.run(g.address, g.sender, g.msats, g.at, rail);
  }
}

/**
 * Relays keep only the newest revision of an addressable event, so the
 * oldest revision we hold can post-date the release. A payment or purchase
 * for it proves it existed by then; use the earliest of those.
 */
function backdateFirstPublished(db) {
  db.exec(`UPDATE content SET first_published = MIN(first_published,
      COALESCE((SELECT MIN(created_at) FROM payments p WHERE p.address = content.address), first_published),
      COALESCE((SELECT MIN(purchased_at) FROM purchases p WHERE p.address = content.address AND p.purchased_at > 0), first_published))`);
}

/** Profiles, cashu wallet info and follow edges among known participants. */
function rebuildProfiles(db) {
  db.exec('DELETE FROM profiles; DELETE FROM wallets; DELETE FROM follows;');
  const insP = db.prepare(`INSERT OR REPLACE INTO profiles(pubkey, created_at, name, display_name, picture, banner, about, nip05, lud16, website)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of db.prepare("SELECT json FROM events WHERE role = 'profile'").all()) {
    const ev = JSON.parse(r.json);
    const p = parseProfile(ev);
    insP.run(ev.pubkey, ev.created_at, p.name, p.displayName, p.picture, p.banner, p.about, p.nip05, p.lud16, p.website);
  }
  const insW = db.prepare('INSERT OR REPLACE INTO wallets(pubkey, created_at, mints_json) VALUES(?, ?, ?)');
  for (const r of db.prepare("SELECT json FROM events WHERE role = 'wallet'").all()) {
    const ev = JSON.parse(r.json);
    const mints = (ev.tags || []).filter((t) => t[0] === 'mint' && t[1]).map((t) => t[1]);
    insW.run(ev.pubkey, ev.created_at, JSON.stringify(mints));
  }
  const participants = new Set(participantPubkeys(db));
  const insF = db.prepare('INSERT OR IGNORE INTO follows(follower, followee) VALUES(?, ?)');
  for (const r of db.prepare("SELECT json FROM events WHERE role = 'follows'").all()) {
    const ev = JSON.parse(r.json);
    for (const t of ev.tags || []) if (t[0] === 'p' && participants.has(t[1]) && t[1] !== ev.pubkey) insF.run(ev.pubkey, t[1]);
  }
}

/**
 * Every pubkey that took part in Fanfares: creators, split recipients,
 * buyers, payers and commenters. Used to decide whose profiles to crawl.
 */
export function participantPubkeys(db) {
  const rows = db.prepare(`
    SELECT pubkey AS k FROM events WHERE role IN ('content', 'comment', 'reaction', 'repost', 'nutzap')
    UNION SELECT sender FROM payments WHERE sender IS NOT NULL
    UNION SELECT recipient FROM payments WHERE recipient IS NOT NULL
    UNION SELECT buyer FROM purchases
    UNION SELECT value FROM event_refs r JOIN events e ON e.id = r.event_id AND e.role = 'content' WHERE r.tag = 'p'
  `).all();
  const zapSplits = db.prepare("SELECT json FROM events WHERE role = 'content'").all()
    .flatMap((r) => JSON.parse(r.json).tags.filter((t) => t[0] === 'zap').map((t) => t[1]));
  return [...new Set([...rows.map((r) => r.k), ...zapSplits])].filter((k) => /^[0-9a-f]{64}$/.test(k || ''));
}
