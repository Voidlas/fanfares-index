/**
 * Answers the explorer's API calls from the prebuilt static API under
 * /api/v1/ (written by snapshot/build.mjs), so the static site needs no
 * server code. Takes the same paths and parameters as the dynamic API
 * (worker/src/routes.js) and returns the same JSON: the files hold every
 * row precomputed, and this module only filters, sorts and pages them,
 * with the same rules as worker/src/queries.js.
 */
const BASE = '/api/v1';
const PERIODS = new Set(['today', 'week', 'month', 'year']);
const files = new Map();

/** Fetches (once per page load) and parses a JSON file under /api/v1/. */
function load(rel) {
  if (!files.has(rel)) {
    files.set(rel, fetch(`${BASE}/${rel}`).then(async (res) => {
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) {
        throw Object.assign(new Error(res.status === 404 ? 'not found' : `Request failed (${res.status})`), { status: res.status });
      }
      return res.json();
    }).catch((err) => { files.delete(rel); throw err; }));
  }
  return files.get(rel);
}

/** Whether this deployment serves the static API; resolves to its meta.json or null. */
export const probe = () => load('meta.json').catch(() => null);

/** Integer param clamped to [min, max], or the fallback (as worker/src/routes.js). */
function int(params, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(params[name], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

/** Shared list parameters, validated like the dynamic API. */
function listParams(p) {
  return {
    q: String(p.q || '').trim().slice(0, 120),
    sort: p.sort || '',
    limit: int(p, 'limit', 24, 1, 100),
    offset: int(p, 'offset', 0, 0),
    period: PERIODS.has(p.period) ? p.period : '',
    includeTest: p.test === '1' || p.test === 1
  };
}

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const page = (rows, { limit, offset }) => ({ total: rows.length, items: rows.slice(offset, offset + limit).map(strip) });
/** Drops the build's private sort/search fields (`_s`, `_e`). */
function strip(row) {
  const out = {};
  for (const k in row) if (k[0] !== '_') out[k] = row[k];
  return out;
}
const file = (dir, period, includeTest) => `${dir}/${period || 'all'}${includeTest ? '.test' : ''}.json`;

/** Release order comparators; ties fall back to newest first, then address. */
function releaseOrder(sort) {
  const newest = (a, b) => b.publishedAt - a.publishedAt || byKey(a.address, b.address);
  return {
    oldest: (a, b) => a.publishedAt - b.publishedAt || byKey(a.address, b.address),
    sales: (a, b) => b.stats.sales - a.stats.sales || newest(a, b),
    earned: (a, b) => b._e - a._e || newest(a, b),
    price: (a, b) => b.priceSats - a.priceSats || newest(a, b)
  }[sort] || newest;
}

async function releases(p) {
  const o = listParams(p);
  const kind = int(p, 'kind', undefined);
  const creator = /^[0-9a-f]{64}$/.test(p.creator || '') ? p.creator : undefined;
  const { since, items } = await load(file('releases', o.period, false));
  const bySales = o.sort === 'sales' || o.sort === 'earned';
  const q = o.q.toLowerCase();
  const rows = items.filter((r) => (o.includeTest || !r.isTest) && (!kind || r.kind === kind) && (!creator || r.author.pubkey === creator)
    && (!q || r._s.includes(q)) && (!since || (bySales ? r.stats.sales > 0 : r.publishedAt >= since)))
    .sort(releaseOrder(o.sort));
  return page(rows, o);
}

/** SHA-256 hex prefix naming a release file (as releaseKey in snapshot/build.mjs). */
async function releaseKey(address) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function release(ref) {
  try {
    if (ref.includes(':')) return await load(`release/${await releaseKey(ref)}.json`);
  } catch (err) { if (err.status !== 404) throw err; }
  const key = (await load('release/ids.json'))[ref];
  if (!key) throw Object.assign(new Error('release not found'), { status: 404 });
  return load(`release/${key}.json`);
}

async function creators(p) {
  const o = listParams(p);
  const { items } = await load(file('creators', o.period, o.includeTest));
  const q = o.q.toLowerCase();
  const order = {
    releases: (a, b) => b.releases - a.releases,
    newest: (a, b) => b.latestRelease - a.latestRelease,
    buyers: (a, b) => b.buyers - a.buyers
  }[o.sort] || ((a, b) => b.earnedSats - a.earnedSats || b.releases - a.releases);
  const rows = items.filter((r) => !q || r.pubkey === o.q || r._s.includes(q))
    .sort((a, b) => order(a, b) || b.latestRelease - a.latestRelease || byKey(a.pubkey, b.pubkey));
  return page(rows, o);
}

async function person(pubkey, p) {
  const found = await load(`people/${pubkey}.json`).catch((err) => {
    throw err.status === 404 ? Object.assign(new Error('person not found'), { status: 404 }) : err;
  });
  if (listParams(p).includeTest) return strip(found);
  const releases = found.releases.filter((r) => !r.isTest);
  // Someone known only for test releases does not exist while those are hidden.
  if (!found._p && !releases.length && !found.purchases.length && !found.stats.paymentsReceived) {
    throw Object.assign(new Error('person not found'), { status: 404 });
  }
  return strip({ ...found, releases, stats: { ...found.stats, releases: releases.length } });
}

async function supporters(p) {
  const o = listParams(p);
  return page((await load(file('supporters', o.period, o.includeTest))).items, o);
}

async function activity(p) {
  const rows = await load(`activity${listParams(p).includeTest ? '.test' : ''}.json`);
  return rows.slice(0, int(p, 'limit', 30, 1, 100));
}

/** The dynamic API's /api/sync shape, from the build metadata. `manual: false` hides "Sync now". */
async function sync() {
  // Always re-read meta.json; a new build drops every cached file so views pick it up.
  const res = await fetch(`${BASE}/meta.json`, { cache: 'no-cache' });
  if (!res.ok) throw Object.assign(new Error(`Request failed (${res.status})`), { status: res.status });
  const meta = await res.json();
  const known = await files.get('meta.json')?.catch(() => null);
  if (known && known.builtAt !== meta.builtAt) files.clear();
  files.set('meta.json', Promise.resolve(meta));
  return {
    lastSyncAt: meta.lastSyncAt, builtAt: meta.builtAt, running: false, manual: false, intervalMin: meta.intervalMin,
    pass: null, log: [], runs: meta.runs, roles: meta.roles
  };
}

/**
 * Answers one dynamic-API GET from the static files.
 * @param {string} path e.g. '/api/releases' or '/api/people/<hex>'
 * @param {Record<string, string|number>} params Query parameters (already including `test`).
 */
export async function staticGet(path, params) {
  let m;
  if (path === '/api/overview') return load(`overview${listParams(params).includeTest ? '.test' : ''}.json`);
  if (path === '/api/releases') return releases(params);
  if ((m = path.match(/^\/api\/releases\/(.+)$/))) return release(decodeURIComponent(m[1]));
  if (path === '/api/creators') return creators(params);
  if ((m = path.match(/^\/api\/people\/([0-9a-f]{64})$/))) return person(m[1], params);
  if (path === '/api/supporters') return supporters(params);
  if (path === '/api/activity') return activity(params);
  if (path === '/api/insights') return load(`insights${listParams(params).includeTest ? '.test' : ''}.json`);
  if (path === '/api/sync') return sync();
  throw Object.assign(new Error('unknown endpoint'), { status: 404 });
}
