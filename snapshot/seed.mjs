/**
 * Rebuilds a crawl archive from a published static snapshot, so CI never has
 * to re-crawl full history from relays when its cached archive is gone.
 *
 *   node --no-warnings snapshot/seed.mjs https://<site> [--db data/fanfares.sqlite]
 *
 * Downloads every raw-event shard listed in /api/v1/events/manifest.json and
 * the worker-verified purchases, stores them with the crawler's own ingest
 * (lib/db.js), and restores the incremental cursor, so the next `node sync.js`
 * only reads what changed since that snapshot's crawl.
 *
 * Exit codes: 0 seeded, 2 no snapshot at that URL (caller should run a full
 * crawl instead), 1 anything else.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ingest, openDb, rebuildDerived, setState } from '../lib/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { db: { type: 'string', default: path.join(ROOT, 'data', 'fanfares.sqlite') } }
});
const site = (positionals[0] || process.env.SNAPSHOT_URL || '').replace(/\/+$/, '');
if (!site) { console.error('usage: seed.mjs <site url>'); process.exit(2); }
if (existsSync(args.db)) { console.error(`refusing to seed over an existing archive: ${args.db}`); process.exit(1); }

/** GETs a JSON file of the published static API. */
async function get(rel) {
  const res = await fetch(`${site}/api/v1/${rel}`);
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw Object.assign(new Error(`${rel}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

let meta;
let manifest;
try {
  [meta, manifest] = await Promise.all([get('meta.json'), get('events/manifest.json')]);
} catch (err) {
  console.error(`no snapshot at ${site}: ${err.message}`);
  process.exit(2);
}

const shards = Object.values(manifest.roles).flatMap((r) => r.shards.map((s) => s.file));
const events = [];
for (let i = 0; i < shards.length; i += 8) {
  for (const batch of await Promise.all(shards.slice(i, i + 8).map(get))) events.push(...batch);
}
const verified = await get('archive/verified.json');

mkdirSync(path.dirname(path.resolve(args.db)), { recursive: true });
const db = openDb(args.db);
const added = ingest(db, events);
const insert = db.prepare('INSERT OR IGNORE INTO verified_purchases(address, buyer, amount_msats, purchased_at) VALUES(?, ?, ?, ?)');
for (const v of verified) insert.run(v.address, v.buyer, v.amount_msats, v.purchased_at);
// The legacy feed tables are not in a seeded archive; mark that import done.
setState(db, 'legacy_imported', { at: Date.now(), seededFrom: site, builtAt: meta.builtAt });
if (meta.lastSyncStartedAt) setState(db, 'last_sync_at', meta.lastSyncStartedAt);
rebuildDerived(db);
db.close();

const stored = Object.values(added).reduce((a, n) => a + n, 0);
console.log(`seeded ${stored}/${events.length} events and ${verified.length} verified purchases from ${site} (snapshot built ${new Date(meta.builtAt * 1000).toISOString()})`);
if (stored < events.length * 0.99) { console.error('too many events were not stored; refusing to continue on a partial archive'); process.exit(1); }
