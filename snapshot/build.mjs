/**
 * Builds the static Fanfares Index site: the explorer UI from public/ plus a
 * precomputed JSON API under /api/v1/, from a crawled archive.
 *
 *   node --no-warnings snapshot/build.mjs [--db data/fanfares.sqlite] [--out dist]
 *
 * Every response the explorer needs is computed here, once per build, with
 * the same model and query code the Worker API uses (worker/src/model.js and
 * worker/src/queries.js), so the numbers match the live API. The browser
 * (public/js/static-api.js) only filters, sorts and pages these files.
 * Nothing at request time runs code or touches a database.
 *
 * Layout of dist/api/v1/ (documented in README.md):
 *   meta.json                        build time, last crawl, sync history, event counts
 *   overview.json, overview.test.json
 *   activity.json, activity.test.json            newest 100 items
 *   insights/{7d,30d,90d,365d,all}[.test].json   trends and breakdowns per rolling window (snapshot/insights.mjs)
 *   insights.json, insights.test.json            the 30d window
 *   releases/{all,today,week,month,year}.json    every listed release, stats in that window
 *   release/{key}.json               one release; key = first 32 hex of sha256(address)
 *   release/ids.json                 revision event id -> key
 *   creators/{period}[.test].json, supporters/{period}[.test].json
 *   people/{pubkey}.json             one person (test releases included, flagged isTest; `_p` = has a profile)
 *   events/manifest.json, events/{role}/{n}.json  raw signed events, newest first
 *   archive/verified.json            worker-verified purchases (lets CI re-seed an archive)
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildModel } from '../worker/src/model.js';
import * as Q from '../worker/src/queries.js';
import { DEFAULT_INSIGHT_PERIOD, insightsByPeriod } from './insights.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    db: { type: 'string', default: path.join(ROOT, 'data', 'fanfares.sqlite') },
    out: { type: 'string', default: path.join(ROOT, 'dist') },
    'interval-min': { type: 'string', default: process.env.SNAPSHOT_INTERVAL_MIN || '60' }
  }
});

/** Raw-event shards are cut at about this many bytes of JSON. */
const SHARD_BYTES = 256 * 1024;
/** Items kept in the activity files; the API caps `limit` at 100. */
const ACTIVITY_ITEMS = 100;
const PERIODS = ['all', ...Object.keys(Q.PERIODS)];
const ALL = Number.MAX_SAFE_INTEGER;

/** File key of a release: first 32 hex chars of sha256(address). Mirrored in public/js/static-api.js. */
export const releaseKey = (address) => createHash('sha256').update(address).digest('hex').slice(0, 32);

// Freeze the clock so every "rolling window" in this build starts at the same instant.
const NOW = Date.now();
Date.now = () => NOW;
const builtAt = Math.floor(NOW / 1000);

const t0 = performance.now();
const db = new DatabaseSync(args.db, { readOnly: true });
const model = buildModel(
  // Id order, as the Durable Object reads its WITHOUT ROWID table: ties sort the same on every build.
  db.prepare('SELECT id, kind, pubkey, created_at, role, address, json FROM events ORDER BY id').all(),
  db.prepare('SELECT address, buyer, amount_msats, purchased_at FROM verified_purchases').all()
);

const out = path.resolve(args.out);
const api = path.join(out, 'api', 'v1');
rmSync(out, { recursive: true, force: true });
cpSync(path.join(ROOT, 'public'), out, { recursive: true });
let files = 0;
let bytes = 0;
/** Writes one JSON file under dist/api/v1/. */
function put(rel, body) {
  const file = path.join(api, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(body);
  writeFileSync(file, text);
  files++;
  bytes += text.length;
}
const lower = (...parts) => parts.flat().filter(Boolean).join('\n').toLowerCase();
const suffix = (includeTest) => (includeTest ? '.test' : '');
const periodArg = (p) => (p === 'all' ? '' : p);

// Overview and activity: one variant with and one without test releases.
for (const includeTest of [false, true]) {
  put(`overview${suffix(includeTest)}.json`, Q.overview(model, { includeTest }));
  put(`activity${suffix(includeTest)}.json`, Q.activity(model, { limit: ACTIVITY_ITEMS, includeTest }));
}

// Insights page: trends and breakdowns, with and without test releases.
for (const includeTest of [false, true]) {
  const byPeriod = insightsByPeriod(model, { includeTest, now: builtAt });
  for (const [period, body] of Object.entries(byPeriod)) put(`insights/${period}${suffix(includeTest)}.json`, body);
  // Unversioned alias of the default window, kept for links to the first release of this file.
  put(`insights${suffix(includeTest)}.json`, byPeriod[DEFAULT_INSIGHT_PERIOD]);
}

// Release listings: every listed release (test ones flagged isTest), with
// stats for the window. `_s` is the search haystack and `_e` the window's
// earnings in msats (the exact `earned` sort key); the client strips both.
for (const p of PERIODS) {
  const period = periodArg(p);
  const since = Q.periodStart(period);
  const base = { q: '', period, limit: ALL, offset: 0, includeTest: true };
  // A windowed listing keeps releases sold in the window (sales sorts) or
  // published in it (other sorts); the union carries everything a client needs.
  const byAddress = new Map();
  for (const sort of period ? ['sales', 'newest'] : ['newest']) {
    for (const card of Q.listReleases(model, { ...base, sort }).items) byAddress.set(card.address, card);
  }
  const items = [...byAddress.values()].map((card) => {
    const c = model.contents.get(card.address);
    const author = model.profiles.get(c.pubkey);
    const bought = (model.purchasesByAddress.get(c.address) || []).filter((x) => !since || x.at >= since);
    return {
      ...card,
      _s: lower(c.meta.title, c.meta.summary, c.meta.kindLabel, c.meta.topics, author?.name, author?.displayName, author?.nip05),
      _e: bought.reduce((acc, x) => acc + x.msats, 0)
    };
  });
  put(`releases/${p}.json`, { builtAt, period, since, items });
}

// Creator and supporter rankings, already in their default order.
for (const includeTest of [false, true]) {
  for (const p of PERIODS) {
    const period = periodArg(p);
    const creators = Q.listCreators(model, { q: '', sort: '', period, limit: ALL, offset: 0, includeTest }).items.map((r) => {
      const prof = model.profiles.get(r.pubkey);
      return { ...r, _s: lower(prof?.name, prof?.displayName, prof?.nip05) };
    });
    put(`creators/${p}${suffix(includeTest)}.json`, { builtAt, period, items: creators });
    put(`supporters/${p}${suffix(includeTest)}.json`, { builtAt, period, items: Q.listSupporters(model, { period, limit: ALL, offset: 0, includeTest }).items });
  }
}

// One file per release, plus revision id -> key for lookups by event id.
for (const address of model.contents.keys()) put(`release/${releaseKey(address)}.json`, Q.getRelease(model, address));
put('release/ids.json', Object.fromEntries([...model.idToAddress].map(([id, address]) => [id, releaseKey(address)])));

// One file per person the archive knows anything about.
const pubkeys = new Set([...model.participants, ...model.profiles.keys()]);
let people = 0;
for (const pk of pubkeys) {
  if (!/^[0-9a-f]{64}$/.test(pk)) continue;
  const found = Q.getPerson(model, pk, { includeTest: true });
  // `_p`: whether a profile exists, which decides a 404 once the client hides test releases.
  if (found) { put(`people/${pk}.json`, { ...found, _p: model.profiles.has(pk) }); people++; }
}

// Raw signed events per role, newest first, cut into ~256 KB shards.
const manifest = { builtAt, shardBytes: SHARD_BYTES, roles: {} };
for (const { role } of db.prepare('SELECT DISTINCT role FROM events ORDER BY role').all()) {
  const shards = [];
  let shard = [];
  let size = 0;
  let count = 0;
  const flush = () => {
    if (!shard.length) return;
    put(`events/${role}/${shards.length}.json`, shard.map((s) => JSON.parse(s)));
    shards.push({ file: `events/${role}/${shards.length}.json`, count: shard.length, newest: JSON.parse(shard[0]).created_at, oldest: JSON.parse(shard.at(-1)).created_at });
    shard = [];
    size = 0;
  };
  for (const { json } of db.prepare('SELECT json FROM events WHERE role = ? ORDER BY created_at DESC, id').iterate(role)) {
    if (size + json.length > SHARD_BYTES) flush();
    shard.push(json);
    size += json.length;
    count++;
  }
  flush();
  manifest.roles[role] = { count, shards };
}
put('events/manifest.json', manifest);
put('archive/verified.json', db.prepare('SELECT address, buyer, amount_msats, purchased_at FROM verified_purchases ORDER BY address, buyer').all());

// Build metadata, also what the Live page and header pill read.
const state = (key) => {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
};
const runs = db.prepare('SELECT id, started_at, finished_at, status, summary_json FROM sync_runs ORDER BY id DESC LIMIT 15').all()
  .map(({ summary_json: s, ...r }) => ({ ...r, summary: s ? JSON.parse(s) : null }));
const lastRun = runs.find((r) => r.status === 'ok');
put('meta.json', {
  version: 1,
  builtAt,
  lastSyncAt: lastRun?.finished_at || state('last_sync_at'),
  lastSyncStartedAt: state('last_sync_at'),
  intervalMin: Number(args['interval-min']),
  events: model.index.length,
  releases: model.contents.size,
  people,
  roles: Q.roleCounts(model),
  runs
});

// Response headers for the static API: open CORS, short browser caching.
writeFileSync(path.join(out, '_headers'), `/api/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=120
`);

console.log(`snapshot: ${model.index.length} events -> ${files} files, ${(bytes / 1e6).toFixed(1)} MB of JSON in ${Math.round(performance.now() - t0)} ms (${out})`);
