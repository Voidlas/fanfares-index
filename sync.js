/**
 * Fanfares Network crawler. Pulls everything public about Fanfares from
 * Nostr relays into the archive in three phases:
 *
 *   1. content     every event tagged with the Fanfares NIP-89 handler
 *   2. activity    zap receipts, nutzaps, comments, reactions, reposts and
 *                  deletions that point at that content
 *   3. people      profiles, follow lists, relay lists and cashu wallet info
 *                  (10019) for every creator, buyer, payer and commenter
 *
 * Runs on a timer inside server.js, from `POST /api/sync`, or from the CLI:
 * `node sync.js [--full]`. Incremental runs re-read a 3-day overlap before
 * the last successful run so late-propagating events are not missed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_KINDS, CONTENT_KINDS, CONTENT_RELAYS, FANFARES_APP_REF, PEOPLE_KINDS, PROFILE_RELAYS
} from './lib/constants.js';
import { getState, importLegacy, ingest, knownTargets, openDb, participantPubkeys, rebuildDerived, setState } from './lib/db.js';
import { paginate, paginateChunked } from './lib/relay.js';

const OVERLAP_SECONDS = 3 * 24 * 3600;

/** Adds per-role counts from `b` into `a`. */
function addCounts(a, b) {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] || 0) + v;
  return a;
}

/**
 * Runs one crawl against the archive.
 * @param {import('node:sqlite').DatabaseSync} db Archive opened with openDb.
 * @param {object} [opts]
 * @param {boolean} [opts.full] Ignore the incremental cursor and re-read everything.
 * @param {(entry: object) => void} [opts.log] Receives progress entries (streamed to the UI).
 * @returns {Promise<object>} Summary of what was added.
 */
export async function runSync(db, { full = false, log = () => {} } = {}) {
  const startedAt = Math.floor(Date.now() / 1000);
  const runId = db.prepare("INSERT INTO sync_runs(started_at, status) VALUES(?, 'running')").run(startedAt).lastInsertRowid;
  const lastRun = full ? null : getState(db, 'last_sync_at');
  const since = lastRun ? lastRun - OVERLAP_SECONDS : undefined;
  const added = {};
  const relays = {};
  const note = (relay, phase, count, ok) => {
    relays[relay] = { ...(relays[relay] || {}), [phase]: { count, ok } };
    log({ type: 'relay', relay, phase, count, ok });
  };

  try {
    const legacy = importLegacy(db);
    if (legacy) {
      log({ type: 'info', message: `Imported legacy feed tables (${legacy.verified} worker-verified purchases)` });
      rebuildDerived(db);
    }
    log({ type: 'info', message: since ? `Incremental sync from ${new Date(since * 1000).toISOString().slice(0, 10)}` : 'Full sync' });

    log({ type: 'phase', phase: 'content', message: 'Reading Fanfares releases' });
    const content = await Promise.all(CONTENT_RELAYS.map(async (relay) => {
      const res = await paginate(relay, { kinds: CONTENT_KINDS, '#a': [FANFARES_APP_REF], limit: 500 }, { since });
      note(relay, 'content', res.events.length, res.ok);
      return res.events;
    }));
    addCounts(added, ingest(db, content.flat()));
    rebuildDerived(db);

    const targets = [...knownTargets(db)];
    const addresses = targets.filter((t) => t.includes(':'));
    const ids = targets.filter((t) => !t.includes(':'));
    log({ type: 'phase', phase: 'activity', message: `Reading payments and engagement for ${addresses.length} releases` });
    const activity = await Promise.all(CONTENT_RELAYS.map(async (relay) => {
      const base = { kinds: ACTIVITY_KINDS, limit: 500 };
      const byA = await paginateChunked(relay, base, '#a', addresses, 100, { since });
      const byE = byA.abandoned ? { events: [], failures: 1 } : await paginateChunked(relay, base, '#e', ids, 100, { since });
      note(relay, 'activity', byA.events.length + byE.events.length, byA.failures + byE.failures === 0);
      return [...byA.events, ...byE.events];
    }));
    addCounts(added, ingest(db, activity.flat()));
    rebuildDerived(db);

    const people = participantPubkeys(db);
    // People we already hold a profile or relay list for; everyone else is new.
    const known = new Set(since ? db.prepare("SELECT DISTINCT pubkey FROM events WHERE role IN ('profile', 'relays')").all().map((r) => r.pubkey) : []);
    log({ type: 'phase', phase: 'people', message: `Reading profiles and wallets for ${people.length} people` });
    const peopleEvents = await Promise.all(PROFILE_RELAYS.map(async (relay) => {
      // Profiles, follows, relay lists and wallets are replaceable: anything
      // changed since the last run is newer than `since`, so incremental runs
      // only fetch updates. New participants get their full history once.
      const fresh = people.filter((pk) => !known.has(pk));
      const res = await paginateChunked(relay, { kinds: PEOPLE_KINDS, limit: 500 }, 'authors', people.filter((pk) => known.has(pk)), 100, { since });
      const add = fresh.length ? await paginateChunked(relay, { kinds: PEOPLE_KINDS, limit: 500 }, 'authors', fresh, 100) : { events: [], failures: 0 };
      res.events.push(...add.events);
      res.failures += add.failures;
      note(relay, 'people', res.events.length, res.failures === 0);
      return res.events;
    }));
    addCounts(added, ingest(db, peopleEvents.flat()));
    rebuildDerived(db);

    setState(db, 'last_sync_at', startedAt);
    const summary = { added, relays, durationSec: Math.floor(Date.now() / 1000) - startedAt };
    db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'ok', summary_json = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), JSON.stringify(summary), runId);
    log({ type: 'complete', summary });
    return summary;
  } catch (err) {
    db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'error', summary_json = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), JSON.stringify({ error: err.message, added }), runId);
    log({ type: 'error', message: err.message });
    throw err;
  }
}

// CLI entry point: node sync.js [--full]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const db = openDb(path.join(dir, 'data', 'fanfares.sqlite'));
  runSync(db, {
    full: process.argv.includes('--full'),
    log: (e) => console.log(`[${e.type}]`, e.message || '', e.relay || '', e.phase && e.relay ? e.phase : '', e.count ?? '', e.summary ? JSON.stringify(e.summary) : '')
  }).then(() => process.exit(0), () => process.exit(1));
}
