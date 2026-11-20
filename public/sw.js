/**
 * Service worker: makes the Fanfares Index installable and usable offline.
 *
 * Everything same-origin is network first, so a fresh snapshot or code
 * change is picked up on the next load; the last good copy is served when
 * the network is down. The app shell is cached on install so the first
 * offline visit still opens. Cross-origin requests (cover art, fonts,
 * relays) are left to the browser.
 */
const CACHE = 'fanfares-index-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'img/logo.png', 'img/icon-192.png',
  'js/app.js', 'js/api.js', 'js/static-api.js', 'js/ui.js', 'js/nostr.js', 'js/player.js', 'js/charts.js',
  'js/insights-ui.js', 'js/sync-status.js', 'js/live-relays.js',
  'js/views/home.js', 'js/views/events.js', 'js/views/people.js', 'js/views/insights.js', 'js/views/live.js',
  'js/views/feed.js', 'js/views/leaderboards.js', 'js/views/search.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // The dynamic API's live endpoints (server.js) must never come from a cache.
  if (/\/api\/(sync|events)\b/.test(url.pathname) && !url.pathname.includes('/api/v1/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
