/**
 * Live: what is happening on Fanfares right now (the snapshot's activity
 * plus a real-time stream from Nostr relays), connection and crawl health,
 * and what the archive holds. Also the developer API page.
 */
import { get, isStatic } from '../api.js';
import { hbars } from '../charts.js';
import { liveStatus, subscribeLive } from '../live-relays.js';
import { ago, esc, num, satsShort, segmented, toast } from '../ui.js';
import { onSyncEvent } from '../sync-status.js';
import { liveFeed } from './feed.js';

const ROLE_LABELS = {
  content: 'Published events (all revisions)', zap: 'Lightning zap receipts', nutzap: 'Cashu nutzaps', profile: 'Profiles',
  relays: 'Relay lists', follows: 'Follow lists', reaction: 'Reactions', comment: 'Comments', wallet: 'Ecash wallets',
  repost: 'Reposts', deletion: 'Deletion requests'
};
const FILTERS = [['all', 'Everything'], ['money', 'Sales & zaps'], ['release', 'Published'], ['talk', 'Comments & reactions']];
const MATCH = {
  all: () => true,
  money: (e) => e.type === 'sale' || e.type === 'zap',
  release: (e) => e.type === 'release',
  talk: (e) => e.type === 'comment' || e.type === 'reaction' || e.type === 'repost'
};
const STATE_LABEL = { live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting', failed: 'Unreachable' };

/** "LIVE" badge used in headings. */
export const liveBadge = '<span class="live-badge"><i></i>Live</span>';

/** Renders the Live page. */
export async function renderLive(main) {
  document.title = 'Live · Fanfares Index';
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Live</div><h1 class="with-badge">What’s happening on Fanfares ${liveBadge}</h1>
      <p>Purchases, zaps, new events and conversations as they land on Nostr relays, streamed into your browser in real time on top of the hourly snapshot.</p></div>
    <div class="live-layout">
      <div>
        <div class="tally-head">Last 7 days</div>
        <div class="tally" id="tally"></div>
        <div class="live-tools"><div id="filter"></div><span class="muted live-status" id="live-count"></span></div>
        <div class="panel feed-panel" id="feed"><div class="skeleton" style="height:420px;margin:16px 0"></div></div>
      </div>
      <aside class="live-side">
        <div class="panel">
          <div class="side-head"><h3>Real-time stream</h3><span class="muted" id="conn-sum"></span></div>
          <div id="conn"></div>
          <div class="side-note" id="conn-note"></div>
        </div>
        <div class="panel">
          <div class="side-head"><h3>Snapshot</h3><span class="muted" id="snap-age"></span></div>
          <div class="snap-meter"><i id="snap-bar"></i></div>
          <div class="side-note" id="snap-note"></div>
          <div id="sync-dyn"></div>
          <div id="crawl"></div>
        </div>
        <div class="panel"><h3>What the archive holds</h3><div class="panel-sub" id="roles-sub">Signed events by type</div><div id="roles"></div></div>
      </aside>
    </div>`;
  const $ = (sel) => main.querySelector(sel);

  const tally = (all) => {
    const from = Date.now() / 1000 - 7 * 86400;
    const wk = all.filter((e) => e.at >= from);
    const count = (f) => wk.filter(f).length;
    const salesSats = wk.filter((e) => e.type === 'sale').reduce((n, e) => n + (e.sats || 0), 0);
    $('#tally').innerHTML = [
      ['Purchases', num(count((e) => e.type === 'sale')), `${satsShort(salesSats)} sats`],
      ['Zaps & nutzaps', num(count((e) => e.type === 'zap')), 'since the snapshot'],
      ['Published', num(count((e) => e.type === 'release')), 'new events'],
      ['Conversation', num(count((e) => ['comment', 'reaction', 'repost'].includes(e.type))), 'comments, reactions, reposts']
    ].map(([l, v, h]) => `<div><span class="label">${l}</span><b>${v}</b><span class="hint">${h}</span></div>`).join('');
  };
  const feed = await liveFeed($('#feed'), { limit: 40, pin: true, status: $('#live-count'), onPaint: tally });
  segmented($('#filter'), FILTERS, 'all', (v) => feed.refilter(MATCH[v]), 'Show');

  const paintConn = () => {
    if (!main.isConnected) return;
    const s = liveStatus();
    $('#conn-sum').textContent = `${s.connected} of ${s.relays.length} connected`;
    $('#conn').innerHTML = s.relays.map(([url, st]) => `<div class="relay-row"><span><span class="status-dot ${st}"></span>${esc(url.replace('wss://', ''))}</span>
      <span class="muted">${STATE_LABEL[st] || st}</span></div>`).join('');
    $('#conn-note').textContent = s.since ? `${num(s.received)} relay events checked since ${new Date(s.since * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.` : 'Opening connections…';
  };
  const unsub = subscribeLive((m) => { if (!main.isConnected) { unsub(); return; } if (m.type !== 'profile') paintConn(); });
  paintConn();

  const s = await get('/api/sync');
  const age = Math.max(0, Date.now() / 1000 - (s.builtAt || s.lastSyncAt || 0));
  const interval = (s.intervalMin || 60) * 60;
  $('#snap-age').textContent = s.lastSyncAt ? `crawled ${ago(s.lastSyncAt)}` : 'never crawled';
  $('#snap-bar').style.width = `${Math.min(100, (age / interval) * 100)}%`;
  $('#snap-note').textContent = age > interval * 1.5
    ? `The scheduled rebuild is overdue (every ${s.intervalMin} min). The real-time stream above still shows everything since.`
    : `Rebuilt every ${s.intervalMin} minutes from relays. Next one in about ${Math.max(1, Math.round((interval - age) / 60))} min.`;
  const last = s.runs.find((r) => r.status === 'ok');
  const relays = Object.entries(last?.summary?.relays || {});
  $('#crawl').innerHTML = relays.length ? `<div class="side-sub">Last crawl, by relay</div>${relays.map(([url, phases]) => {
    const ok = Object.values(phases).every((p) => p.ok);
    const count = Object.values(phases).reduce((a, p) => a + p.count, 0);
    return `<div class="relay-row"><span><span class="status-dot ${ok ? 'live' : 'reconnecting'}"></span>${esc(url.replace('wss://', ''))}</span>
      <span class="muted num">${num(count)}${ok ? '' : ' · partial'}</span></div>`;
  }).join('')}` : '';
  const total = s.roles.reduce((n, r) => n + r.n, 0);
  $('#roles-sub').textContent = `${num(total)} signed events by type`;
  $('#roles').innerHTML = hbars(s.roles.map((r) => ({ label: ROLE_LABELS[r.role] || r.role, count: r.n })));

  // Self-hosted deployments (server.js) can start a crawl and stream its log.
  if (s.manual !== false) {
    $('#sync-dyn').innerHTML = '<button class="btn" id="sync-btn" style="margin-top:14px">Sync now</button><div class="log" id="log" aria-live="polite"></div>';
    const btn = $('#sync-btn');
    const log = $('#log');
    btn.disabled = s.running;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await fetch('/api/sync', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast(body.reason || 'Could not start a sync'); btn.disabled = false; }
    });
    const off = onSyncEvent((e) => {
      if (!main.isConnected) { off(); return; }
      if (e.type === 'start') log.innerHTML = '';
      for (const x of e.backlog || [e]) if (x.message) log.insertAdjacentHTML('beforeend', `<div>${esc(x.message)}</div>`);
      btn.disabled = e.type !== 'idle';
    });
  }
}

/** Static API files: [path, what it holds, group]. */
const STATIC_ENDPOINTS = [
  ['meta.json', 'Build time, last crawl, sync history with per-relay results, and event counts by type.', 'Index'],
  ['overview.json', 'Totals: published events, creators, purchases, sats, monthly series and counts by format.', 'Index'],
  ['insights/{7d|30d|90d|365d|all}.json', 'Growth for a rolling window against the one before: price bands, payment rails, loyalty, concentration, top lists.', 'Index'],
  ['activity.json', 'The 100 most recent purchases, published events and comments.', 'Index'],
  ['releases/{all|today|week|month|year}.json', 'Every published event as a card with sales and engagement stats, counted in that window. Filter and sort it yourself.', 'Events'],
  ['release/{key}.json', 'One published event: buyers, payment legs, revenue split, comments and the raw signed event. key = first 32 hex of sha256(kind:pubkey:d).', 'Events'],
  ['creators/{period}.json', 'Creators ranked by earnings, with sales, supporters, events and followers.', 'People'],
  ['supporters/{period}.json', 'Buyers ranked by sats spent, with purchases and creators backed.', 'People'],
  ['people/{hex pubkey}.json', 'Anyone in the archive: profile, published events, purchases, ecash mints, followers.', 'People'],
  ['events/manifest.json', 'Every raw signed Nostr event in the archive, by role, in newest-first shards.', 'Raw data']
];

const DYNAMIC_ENDPOINTS = [
  ['GET /api/overview', 'Totals: published events, creators, purchases, sats, monthly series and counts by format.', 'Index'],
  ['GET /api/activity?limit=30', 'Most recent purchases, published events and comments.', 'Index'],
  ['GET /api/releases?q=&kind=&sort=&period=', 'Search and page through published events. sort: newest, sales, earned, price, oldest.', 'Events'],
  ['GET /api/releases/{address}', 'One published event with buyers, payment legs, comments and the raw signed event.', 'Events'],
  ['GET /api/creators?q=&sort=&period=', 'Creators ranked by earnings.', 'People'],
  ['GET /api/supporters?period=', 'Buyers ranked by sats spent.', 'People'],
  ['GET /api/people/{hex pubkey}', 'Profile, published events, purchases and ecash mints for anyone in the archive.', 'People'],
  ['GET /api/events?role=&kind=&author=', 'Raw signed Nostr events straight from the store.', 'Raw data'],
  ['GET /api/sync', 'Sync history, live progress and relay results.', 'Raw data']
];

const FEATURES = [
  ['Every sale, verified', 'Purchases matched from zap receipts and nutzaps, plus sales confirmed by the Fanfares key server, each with its payment legs.'],
  ['Creator & supporter graphs', 'Earnings, supporters, followers and ecash mints for every creator, and what every buyer has collected.'],
  ['Growth insights', 'Rolling windows from 7 days to all time, compared with the period before: price points, rails, loyalty, concentration.'],
  ['Raw, signed and verifiable', 'Every number traces back to a signed Nostr event you can download and check against any relay.'],
  ['Static and free', 'Plain JSON files on a CDN. No keys, no rate limits, no SDK: fetch, filter, ship.'],
  ['Fresh every hour', 'Rebuilt from relays on a schedule, with the raw events published alongside so anyone can rebuild it.']
];

/** Renders the developer page. */
export async function renderApi(main) {
  document.title = 'API · Fanfares Index';
  const base = new URL('.', location.href).href.replace(/\/$/, '');
  const isStaticSite = await isStatic();
  const ov = await get('/api/overview').catch(() => null);
  const root = isStaticSite ? `${base}/api/v1` : `${base}/api`;
  const endpoints = isStaticSite ? STATIC_ENDPOINTS.map(([p, d, g]) => [`/api/v1/${p}`, d, g]) : DYNAMIC_ENDPOINTS;
  const groups = [...new Set(endpoints.map(([, , g]) => g))];
  const curl = isStaticSite ? `curl ${root}/creators/all.json` : `curl '${root}/creators?limit=5'`;
  const js = isStaticSite
    ? `const res = await fetch('${root}/releases/month.json');\nconst { items } = await res.json();\n\n// Best sellers of the last 30 days\nconst top = items\n  .filter((e) => !e.isTest && e.stats.sales)\n  .sort((a, b) => b.stats.earnedSats - a.stats.earnedSats)\n  .slice(0, 10);`
    : `const res = await fetch('${root}/releases?sort=sales&period=month&limit=10');\nconst { items } = await res.json();`;
  main.innerHTML = `
    <section class="api-hero">
      <div class="eyebrow">Open API</div>
      <h1>The Fanfares economy, <span class="accent">as open data.</span></h1>
      <p>Everything on this site is built on a public API you can use too: every published event, sale, creator and supporter on Fanfares,
        read from Nostr and served as plain JSON. No key, no sign-up, no rate limit.</p>
      <div class="api-base"><span class="muted">Base URL</span><code id="base">${esc(root)}</code><button class="btn sm" id="copy-base">Copy</button></div>
      ${ov ? `<div class="api-facts"><div><b>${num(ov.releases)}</b><span>published events</span></div><div><b>${num(ov.sales)}</b><span>purchases</span></div>
        <div><b>${num(ov.buyers)}</b><span>supporters</span></div><div><b>${num(ov.archive.events)}</b><span>signed events</span></div></div>` : ''}
    </section>

    <section class="section">
      <div class="section-head"><h2>What you can build with it</h2></div>
      <div class="feature-grid">${FEATURES.map(([t, d]) => `<div class="feature"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Quick start</h2></div>
      <div class="code-tabs" id="code-tabs"></div>
      <pre class="code" id="code"></pre>
    </section>

    <section class="section">
      <div class="section-head"><h2>Endpoints</h2><span class="muted">${isStaticSite ? 'Add <code>.test</code> before <code>.json</code> to include test events' : 'Add <code>test=1</code> to include test events'}</span></div>
      ${groups.map((g) => `<div class="ep-group"><div class="ep-group-name">${esc(g)}</div>${endpoints.filter((e) => e[2] === g).map(([p, d]) => {
        const tryable = !p.includes('{') && !p.startsWith('POST');
        const href = p.replace(/^GET /, '').split('?')[0].replace(/^\//, '');
        return `<div class="ep"><code class="ep-path">${esc(p)}</code><p>${esc(d)}</p>${tryable ? `<a class="ep-try" href="${esc(href)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div>`;
      }).join('')}</div>`).join('')}
    </section>

    <section class="section grid-2">
      <div class="panel"><h3>How the data is collected</h3>
        <p class="summary api-copy">Each run reads every event carrying the Fanfares NIP-89 handler tag from fanfares.nostr1.com, relay.primal.net, nos.lol and relay.damus.io,
        then the zap receipts (9735), nutzaps (9321), comments (1111), reactions (7), reposts (6, 16) and deletions (5) pointing at them, and finally the profiles (0),
        follow lists (3), relay lists (10002) and ecash wallets (10019) of everyone involved.</p></div>
      <div class="panel"><h3>How purchases are counted</h3>
        <p class="summary api-copy"><b>Verified</b> purchases were confirmed by the Fanfares key server. <b>Receipts</b> purchases are matched from public
        payment receipts that add up to the price. Revenue splits follow the zap-split tags on each event.</p></div>
    </section>`;

  const samples = [['curl', curl], ['JavaScript', js], ['Python', isStaticSite
    ? `import requests\n\ncreators = requests.get('${root}/creators/all.json').json()['items']\nfor c in creators[:5]:\n    print(c['name'], c['earnedSats'])`
    : `import requests\n\ncreators = requests.get('${root}/creators', params={'limit': 5}).json()['items']`]];
  const code = main.querySelector('#code');
  segmented(main.querySelector('#code-tabs'), samples.map(([l]) => [l, l]), 'curl', (v) => { code.textContent = samples.find(([l]) => l === v)[1]; }, 'Language');
  code.textContent = curl;
  main.querySelector('#copy-base').addEventListener('click', () => navigator.clipboard?.writeText(root).then(() => toast('Base URL copied')));
}
