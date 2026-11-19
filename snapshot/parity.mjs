/**
 * Parity check for the static site: answers every API call the explorer can
 * make through public/js/static-api.js over a built dist/, and through the
 * dynamic API (worker/src/routes.js over the same archive), and reports any
 * response that differs. Run after snapshot/build.mjs:
 *
 *   node --no-warnings snapshot/parity.mjs [--db data/fanfares.sqlite] [--out dist]
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    db: { type: 'string', default: path.join(ROOT, 'data', 'fanfares.sqlite') },
    out: { type: 'string', default: path.join(ROOT, 'dist') }
  }
});
const dist = path.resolve(args.out);
const meta = JSON.parse(readFileSync(path.join(dist, 'api/v1/meta.json'), 'utf8'));
// Rolling windows must start where the build's did.
Date.now = () => meta.builtAt * 1000;
globalThis.fetch = async (url) => {
  const file = path.join(dist, String(url).split('?')[0]);
  if (!existsSync(file)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(readFileSync(file), { headers: { 'content-type': 'application/json' } });
};
const { buildModel } = await import('../worker/src/model.js');
const { readRoute } = await import('../worker/src/routes.js');
const { staticGet } = await import('../public/js/static-api.js');

const db = new DatabaseSync(args.db, { readOnly: true });
const model = buildModel(
  db.prepare('SELECT id, kind, pubkey, created_at, role, address, json FROM events ORDER BY id').all(),
  db.prepare('SELECT address, buyer, amount_msats, purchased_at FROM verified_purchases').all()
);

async function dynamic(p, params) {
  const url = new URL(`http://local${p}`);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined) url.searchParams.set(k, v);
  const res = readRoute(url, model, null);
  return { status: res.status, body: await res.json() };
}
async function fromStatic(p, params) {
  try { return { status: 200, body: await staticGet(p, params) }; } catch (err) { return { status: err.status, body: null }; }
}

const cases = [];
for (const test of ['', '1']) {
  cases.push(['/api/overview', { test }]);
  for (const limit of [8, 30, 100, 500]) cases.push(['/api/activity', { limit, test }]);
  for (const period of ['', 'today', 'week', 'month', 'year', 'bogus']) {
    for (const sort of ['', 'newest', 'oldest', 'sales', 'earned', 'price']) {
      for (const offset of [0, 24, 100]) cases.push(['/api/releases', { sort, period, offset, limit: 24, test }]);
    }
    for (const kind of [1, 30023, 31337, 31338, 31339, 36787]) cases.push(['/api/releases', { kind, period, test, limit: 100 }]);
    for (const sort of ['', 'releases', 'buyers', 'newest']) {
      for (const offset of [0, 24]) cases.push(['/api/creators', { sort, period, offset, test, limit: 24 }]);
    }
    for (const offset of [0, 50]) cases.push(['/api/supporters', { period, limit: 50, offset, test }]);
  }
  for (const q of ['a', 'music', 'podcast', 'bitcoin', 'NOSTR', 'zz-no-match']) {
    cases.push(['/api/releases', { q, test }], ['/api/creators', { q, test }]);
  }
}
const creator = [...model.contents.values()][0]?.pubkey;
if (creator) cases.push(['/api/releases', { creator, limit: 100 }], ['/api/creators', { q: creator }]);
for (const address of model.contents.keys()) cases.push([`/api/releases/${encodeURIComponent(address)}`, {}]);
for (const [id] of [...model.idToAddress].slice(0, 50)) cases.push([`/api/releases/${id}`, {}]);
cases.push(['/api/releases/nope:nope', {}], ['/api/releases/abc', {}], [`/api/people/${'0'.repeat(64)}`, {}]);
for (const pk of new Set([...model.participants, ...model.profiles.keys()])) {
  for (const test of ['', '1']) cases.push([`/api/people/${pk}`, { test }]);
}

let failures = 0;
for (const [p, params] of cases) {
  const [a, b] = await Promise.all([dynamic(p, params), fromStatic(p, params)]);
  if (a.status === b.status && (a.status !== 200 || isDeepStrictEqual(a.body, b.body))) continue;
  if (++failures <= 10) console.log(`✗ ${p} ${JSON.stringify(params)}: dynamic ${a.status}, static ${b.status}`);
}
console.log(`${cases.length - failures}/${cases.length} responses identical`);
process.exit(failures ? 1 : 0);
