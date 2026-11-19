/**
 * Fanfares Network: HTTP API + static explorer UI over the archive.
 *
 * Read API (all GET, JSON, CORS-open):
 *   /api/overview                      archive-wide totals and monthly series
 *   /api/releases?q&kind&creator&sort&limit&offset
 *   /api/releases/:address             one release with buyers, payments, comments, raw event
 *   /api/creators?q&sort&limit&offset
 *   /api/people/:pubkey                profile, releases, purchases, wallet
 *   /api/supporters?limit&offset
 *   /api/activity?limit
 *   /api/events?role&kind&author&since&until&limit   raw signed events
 *   /api/sync                          sync history and archive composition
 * Every list endpoint accepts `test=1` to include staging/test releases.
 *
 * Sync:
 *   POST /api/sync                     start a crawl (rate limited, one at a time)
 *   GET  /api/sync/stream              server-sent events with live crawl progress
 * The server also crawls on its own every SYNC_INTERVAL_MIN minutes.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import * as Q from './lib/queries.js';
import { runSync } from './sync.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(DIR, 'public');
const PORT = Number(process.env.PORT) || 3333;
const SYNC_INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MIN) || 15;
const MIN_MANUAL_GAP_MS = 2 * 60 * 1000;

const db = openDb(path.join(DIR, 'data', 'fanfares.sqlite'));
// A run still marked 'running' was cut off by a restart; record it honestly.
db.prepare("UPDATE sync_runs SET status = 'interrupted', finished_at = started_at WHERE status = 'running'").run();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

/* ---------- sync orchestration ---------- */

const sync = { running: false, lastStartedMs: 0, log: [], listeners: new Set() };

/** Fans a crawl progress entry out to every open SSE stream. */
function broadcast(entry) {
  const line = { ...entry, at: Date.now() };
  sync.log.push(line);
  if (sync.log.length > 200) sync.log.shift();
  for (const res of sync.listeners) res.write(`data: ${JSON.stringify(line)}\n\n`);
}

/**
 * Starts a crawl unless one is running. Called by the interval timer and by
 * POST /api/sync.
 * @param {string} reason 'schedule' | 'manual' | 'startup', shown in the log.
 * @returns {boolean} Whether a crawl was started.
 */
function startSync(reason) {
  if (sync.running) return false;
  sync.running = true;
  sync.lastStartedMs = Date.now();
  sync.log = [];
  broadcast({ type: 'start', message: `Sync started (${reason})` });
  runSync(db, { log: broadcast })
    .catch((err) => console.error('sync failed:', err.message))
    .finally(() => {
      sync.running = false;
      broadcast({ type: 'idle' });
    });
  return true;
}

/* ---------- request helpers ---------- */

/** Sends a JSON response, with short public caching for read endpoints. */
function json(res, status, body, cacheSeconds = 0) {
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store'
  });
  res.end(JSON.stringify(body));
}

/** Integer query param clamped to [min, max], or the fallback. */
function int(params, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(params.get(name), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

/** Hex pubkey query param, or undefined when absent/malformed. */
function hex64(value) {
  return /^[0-9a-f]{64}$/.test(value || '') ? value : undefined;
}

/** Common list parameters shared by every paged endpoint. */
function listParams(p) {
  return {
    q: (p.get('q') || '').trim().slice(0, 120),
    sort: p.get('sort') || '',
    limit: int(p, 'limit', 24, 1, 100),
    offset: int(p, 'offset', 0, 0),
    includeTest: p.get('test') === '1'
  };
}

/* ---------- routes ---------- */

const routes = [
  ['GET', /^\/api\/overview$/, (p) => [200, Q.overview(db, listParams(p)), 30]],
  ['GET', /^\/api\/releases$/, (p) => [200, Q.listReleases(db, {
    ...listParams(p), kind: int(p, 'kind', undefined), creator: hex64(p.get('creator'))
  }), 30]],
  ['GET', /^\/api\/releases\/(.+)$/, (p, m) => {
    const release = Q.getRelease(db, decodeURIComponent(m[1]));
    return release ? [200, release, 30] : [404, { error: 'release not found' }];
  }],
  ['GET', /^\/api\/creators$/, (p) => [200, Q.listCreators(db, listParams(p)), 30]],
  ['GET', /^\/api\/people\/([0-9a-f]{64})$/, (p, m) => {
    const found = Q.getPerson(db, m[1], listParams(p));
    return found ? [200, found, 30] : [404, { error: 'person not found' }];
  }],
  ['GET', /^\/api\/supporters$/, (p) => [200, Q.listSupporters(db, listParams(p)), 30]],
  ['GET', /^\/api\/activity$/, (p) => [200, Q.activity(db, { limit: int(p, 'limit', 30, 1, 100), includeTest: p.get('test') === '1' }), 15]],
  ['GET', /^\/api\/events$/, (p) => [200, Q.rawEvents(db, {
    role: p.get('role') || undefined, kind: int(p, 'kind', undefined), author: hex64(p.get('author')),
    since: int(p, 'since', undefined), until: int(p, 'until', undefined), limit: int(p, 'limit', 100, 1, 1000)
  })]],
  ['GET', /^\/api\/sync$/, () => [200, { ...Q.syncStatus(db), running: sync.running, intervalMin: SYNC_INTERVAL_MIN }]],
  ['POST', /^\/api\/sync$/, () => {
    if (sync.running) return [409, { started: false, reason: 'A sync is already running' }];
    if (Date.now() - sync.lastStartedMs < MIN_MANUAL_GAP_MS) return [429, { started: false, reason: 'Synced moments ago; try again in a couple of minutes' }];
    return [202, { started: startSync('manual') }];
  }]
];

/** Streams live crawl progress (and the current run's log so far) as SSE. */
function streamSync(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: sync.running ? 'running' : 'idle', backlog: sync.log })}\n\n`);
  sync.listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); sync.listeners.delete(res); });
}

/** Serves files from public/, falling back to index.html for client routes. */
function serveStatic(pathname, res) {
  let file = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) file = path.join(PUBLIC_DIR, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(file);
    fs.readFile(file, (readErr, buf) => {
      if (readErr) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/api/sync/stream') { streamSync(req, res); return; }
  if (url.pathname.startsWith('/api/')) {
    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) { json(res, 404, { error: 'unknown endpoint' }); return; }
    try {
      const [status, body, cache] = route[2](url.searchParams, url.pathname.match(route[1]));
      json(res, status, body, cache);
    } catch (err) {
      console.error(req.url, err);
      json(res, 500, { error: 'internal error' });
    }
    return;
  }
  try { serveStatic(url.pathname, res); } catch { res.writeHead(400); res.end(); }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fanfares Network running at http://127.0.0.1:${PORT} (auto-sync every ${SYNC_INTERVAL_MIN} min)`);
  setTimeout(() => startSync('startup'), 3000);
  setInterval(() => startSync('schedule'), SYNC_INTERVAL_MIN * 60 * 1000).unref();
});
