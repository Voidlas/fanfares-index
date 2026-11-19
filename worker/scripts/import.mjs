/**
 * One-time import of the Node archive (data/fanfares.sqlite) into the
 * Cloudflare Archive Durable Object, then seeds its sync cursors so the first
 * pass on Cloudflare only reads what is new instead of re-crawling history.
 *
 *   node --no-warnings worker/scripts/import.mjs https://fanfares-network.<you>.workers.dev
 *
 * Reads the admin token from ADMIN_TOKEN or worker/.admin-token (the same
 * value uploaded with `wrangler secret put ADMIN_TOKEN`). Safe to re-run:
 * events already stored are skipped and cost no writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CONTENT_RELAYS, PROFILE_RELAYS } from '../../lib/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) { console.error('usage: import.mjs <worker base url>'); process.exit(1); }
const token = process.env.ADMIN_TOKEN || fs.readFileSync(path.join(here, '..', '.admin-token'), 'utf8').trim();
const db = new DatabaseSync(path.join(here, '..', '..', 'data', 'fanfares.sqlite'), { readOnly: true });

/** POSTs JSON to an admin endpoint and returns the parsed reply. */
async function post(endpoint, body) {
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${endpoint} → ${res.status} ${JSON.stringify(reply)}`);
  return reply;
}

// Content first, so every later batch's payments and comments classify against it.
const rows = db.prepare("SELECT json FROM events ORDER BY role != 'content', created_at").all();
const verified = db.prepare('SELECT address, buyer, amount_msats AS msats, purchased_at AS at FROM verified_purchases').all()
  .map((r) => ({ ...r, at: r.at > 1e12 ? Math.floor(r.at / 1000) : r.at }));
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
let batch = [];
let bytes = 0;
const totals = {};
const flush = async () => {
  if (!batch.length) return;
  const reply = await post('/api/admin/import', { events: batch.map((j) => JSON.parse(j)) });
  for (const [k, v] of Object.entries(reply.added)) totals[k] = (totals[k] || 0) + v;
  console.log(`  ${batch.length} events → ${JSON.stringify(reply.added)} · rows written today ${reply.usage.rowsWritten}`);
  batch = []; bytes = 0;
};
console.log(`Importing ${rows.length} events and ${verified.length} verified purchases into ${base}`);
for (const { json } of rows) {
  if (bytes + json.length > MAX_BATCH_BYTES) await flush();
  batch.push(json); bytes += json.length;
}
await flush();
const v = await post('/api/admin/import', { verified });
console.log(`  verified purchases stored: ${v.verified}`);

const lastSync = JSON.parse(db.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_at'").get()?.value || '0');
const relaySince = Object.fromEntries([...new Set([...CONTENT_RELAYS, ...PROFILE_RELAYS])].map((r) => [r, lastSync]));
const cursors = await post('/api/admin/cursors', { relaySince, lastPass: { quick: lastSync, full: lastSync } });
console.log('Added per role:', totals);
console.log('Sync cursors seeded at', new Date(lastSync * 1000).toISOString(), cursors.lastPass);
