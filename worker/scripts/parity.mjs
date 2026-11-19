/**
 * Parity check: runs every API query through the Node SQL layer
 * (lib/queries.js over data/fanfares.sqlite) and through the Worker's
 * in-memory layer (worker/src/model.js + queries.js over the same events),
 * and reports any response that differs. Run before deploying a change to
 * either layer: `node --no-warnings worker/scripts/parity.mjs`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { openDb } from '../../lib/db.js';
import * as SQL from '../../lib/queries.js';
import { buildModel } from '../src/model.js';
import * as MEM from '../src/queries.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const db = openDb(path.join(root, 'data', 'fanfares.sqlite'));
const t0 = performance.now();
const model = buildModel(
  db.prepare('SELECT id, kind, pubkey, created_at, role, address, json FROM events').all(),
  db.prepare('SELECT address, buyer, amount_msats, purchased_at FROM verified_purchases').all()
);
console.log(`model built in ${Math.round(performance.now() - t0)} ms from ${model.index.length} events`);

/** Finds the first differing path between two JSON values. */
function diff(a, b, at = '$') {
  if (isDeepStrictEqual(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return `${at}: sql=${JSON.stringify(a)?.slice(0, 120)} mem=${JSON.stringify(b)?.slice(0, 120)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = diff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

const list = { q: '', sort: '', limit: 100, offset: 0 };
const top = SQL.listReleases(db, { ...list, sort: 'sales', includeTest: false }).items.slice(0, 15).map((r) => r.address);
const people = SQL.listSupporters(db, { ...list, includeTest: false }).items.slice(0, 10).map((p) => p.pubkey)
  .concat(SQL.listCreators(db, { ...list, includeTest: false }).items.slice(0, 10).map((p) => p.pubkey));
const cases = [];
for (const includeTest of [false, true]) {
  cases.push([`overview test=${includeTest}`, () => SQL.overview(db, { includeTest }), () => MEM.overview(model, { includeTest })]);
  for (const sort of ['newest', 'oldest', 'sales', 'earned', 'price']) {
    cases.push([`releases sort=${sort} test=${includeTest}`, () => SQL.listReleases(db, { ...list, sort, includeTest }), () => MEM.listReleases(model, { ...list, sort, includeTest })]);
  }
  for (const kind of [1, 31338, 31339]) {
    cases.push([`releases kind=${kind}`, () => SQL.listReleases(db, { ...list, kind, includeTest }), () => MEM.listReleases(model, { ...list, kind, includeTest })]);
  }
  for (const sort of ['', 'releases', 'buyers', 'newest']) {
    cases.push([`creators sort=${sort} test=${includeTest}`, () => SQL.listCreators(db, { ...list, sort, includeTest }), () => MEM.listCreators(model, { ...list, sort, includeTest })]);
  }
  cases.push([`supporters test=${includeTest}`, () => SQL.listSupporters(db, { ...list, includeTest }), () => MEM.listSupporters(model, { ...list, includeTest })]);
}
for (const a of top) cases.push([`release ${a.slice(0, 24)}`, () => SQL.getRelease(db, a), () => MEM.getRelease(model, a)]);
for (const pk of people) cases.push([`person ${pk.slice(0, 12)}`, () => SQL.getPerson(db, pk, { includeTest: false }), () => MEM.getPerson(model, pk, { includeTest: false })]);

let failures = 0;
for (const [name, sql, mem] of cases) {
  const d = diff(sql(), mem());
  if (d) { failures++; console.log(`✗ ${name}\n    ${d}`); }
}
console.log(`${cases.length - failures}/${cases.length} responses identical`);
process.exit(failures ? 1 : 0);
