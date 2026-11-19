/**
 * Public read API of the archive, served from the in-memory model. Same
 * paths, parameters and JSON as the Node server (server.js), so the
 * explorer UI and any API consumer work against either backend.
 */
import * as Q from './queries.js';

/** JSON response with optional browser caching for read endpoints. */
export function json(status, body, cacheSeconds = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store'
    }
  });
}

/** Integer query param clamped to [min, max], or the fallback. */
function int(params, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(params.get(name), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

/** Hex pubkey query param, or undefined when absent or malformed. */
const hex64 = (value) => (/^[0-9a-f]{64}$/.test(value || '') ? value : undefined);

/** Parameters shared by every paged endpoint. */
function listParams(p) {
  return {
    q: (p.get('q') || '').trim().slice(0, 120),
    sort: p.get('sort') || '',
    limit: int(p, 'limit', 24, 1, 100),
    offset: int(p, 'offset', 0, 0),
    period: Q.PERIODS[p.get('period')] ? p.get('period') : '',
    includeTest: p.get('test') === '1'
  };
}

/** [pattern, handler(params, match, model, store)] for GET /api/*. */
const ROUTES = [
  [/^\/api\/overview$/, (p, m, model) => json(200, Q.overview(model, listParams(p)), 30)],
  [/^\/api\/releases$/, (p, m, model) => json(200, Q.listReleases(model, {
    ...listParams(p), kind: int(p, 'kind', undefined), creator: hex64(p.get('creator'))
  }), 30)],
  [/^\/api\/releases\/(.+)$/, (p, m, model) => {
    const release = Q.getRelease(model, decodeURIComponent(m[1]));
    return release ? json(200, release, 30) : json(404, { error: 'release not found' });
  }],
  [/^\/api\/creators$/, (p, m, model) => json(200, Q.listCreators(model, listParams(p)), 30)],
  [/^\/api\/people\/([0-9a-f]{64})$/, (p, m, model) => {
    const found = Q.getPerson(model, m[1], listParams(p));
    return found ? json(200, found, 30) : json(404, { error: 'person not found' });
  }],
  [/^\/api\/supporters$/, (p, m, model) => json(200, Q.listSupporters(model, listParams(p)), 30)],
  [/^\/api\/activity$/, (p, m, model) => json(200, Q.activity(model, { limit: int(p, 'limit', 30, 1, 100), includeTest: p.get('test') === '1' }), 15)],
  [/^\/api\/events$/, (p, m, model, store) => json(200, store.eventsById(Q.rawEventIds(model, {
    role: p.get('role') || undefined, kind: int(p, 'kind', undefined), author: hex64(p.get('author')),
    since: int(p, 'since', undefined), until: int(p, 'until', undefined), limit: int(p, 'limit', 100, 1, 500)
  })), 30)]
];

/**
 * Answers a GET under /api/, or null when no read route matches.
 * @param {URL} url Request URL.
 * @param {object} model Current read model.
 * @param {import('./store.js').Store} store For raw event lookups by id.
 */
export function readRoute(url, model, store) {
  for (const [re, handler] of ROUTES) {
    const m = url.pathname.match(re);
    if (m) return handler(url.searchParams, m, model, store);
  }
  return null;
}
