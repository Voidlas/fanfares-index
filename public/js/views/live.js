/**
 * Live page (activity feed, relay health, sync history, live crawl log) and
 * the API reference page.
 */
import { get, isStatic } from '../api.js';
import { ago, esc, num, toast } from '../ui.js';
import { feedItems } from './feed.js';
import { onSyncEvent } from '../sync-status.js';

const ROLE_LABELS = {
  content: 'Releases (all revisions)', zap: 'Lightning zap receipts', nutzap: 'Cashu nutzaps', profile: 'Profiles',
  relays: 'Relay lists', follows: 'Follow lists', reaction: 'Reactions', comment: 'Comments', wallet: 'Ecash wallets (10019)',
  repost: 'Reposts', deletion: 'Deletion requests'
};

/** Formats one crawl log entry as a terminal line. */
function logLine(e) {
  const t = new Date(e.at || Date.now()).toLocaleTimeString('en-US', { hour12: false });
  if (e.type === 'relay') {
    return `<div><span class="muted">${t}</span> <span class="${e.ok ? 'ok' : 'warn'}">${e.ok ? '✓' : '!'}</span> ${esc(e.phase)} · ${esc(e.relay.replace('wss://', ''))} · ${num(e.count)} events</div>`;
  }
  if (e.type === 'complete') {
    const added = Object.entries(e.summary.added).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new';
    return `<div><span class="muted">${t}</span> <span class="ok">Done in ${e.summary.durationSec}s:</span> ${esc(added)}</div>`;
  }
  if (e.type === 'error') return `<div><span class="muted">${t}</span> <span class="err">Error: ${esc(e.message)}</span></div>`;
  if (!e.message) return '';
  return `<div><span class="muted">${t}</span> ${esc(e.message)}</div>`;
}

/** Renders the Live page and subscribes to crawl progress while open. */
export async function renderLive(main) {
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Live</div><h1>Happening on Fanfares</h1>
      <p id="live-intro">The archive keeps itself current by re-reading Fanfares activity from Nostr relays on a schedule. You can also start a sync and watch it run.</p></div>
    <div class="grid-2 live-grid">
      <div><div class="panel" style="padding:6px 18px" id="feed"><div class="skeleton" style="height:400px;margin:12px 0"></div></div></div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div><h3>Relay sync</h3><div class="panel-sub" id="sync-sub" style="margin:0">…</div></div>
            <button class="btn primary" id="sync-btn">Sync now</button>
          </div>
          <div class="log" id="log" style="margin-top:16px" aria-live="polite"></div>
        </div>
        <div class="panel"><h3>Relays</h3><div class="panel-sub">Result of the last completed sync</div><div id="relays"></div></div>
        <div class="panel"><h3>What the archive holds</h3><div class="panel-sub">Signed events by type</div><div id="roles"></div></div>
      </div>
    </div>`;

  const log = main.querySelector('#log');
  const btn = main.querySelector('#sync-btn');
  const refreshStatus = async () => {
    const s = await get('/api/sync');
    btn.disabled = s.running;
    btn.textContent = s.running ? 'Syncing…' : 'Sync now';
    // The static snapshot is rebuilt on a schedule by CI: no manual sync, no live log.
    if (s.manual === false) {
      btn.style.display = 'none';
      main.querySelector('#live-intro').textContent = 'The index is rebuilt on a schedule: each run re-reads Fanfares activity from Nostr relays and publishes a fresh snapshot of this site and its API.';
    }
    main.querySelector('#sync-sub').textContent = `${s.lastSyncAt ? `Last synced ${ago(s.lastSyncAt)}` : 'Never synced'} · automatic every ${s.intervalMin} min`
      + (s.builtAt ? ` · snapshot built ${ago(s.builtAt)}` : '');
    const last = s.runs.find((r) => r.status === 'ok');
    const relays = last?.summary?.relays || {};
    main.querySelector('#relays').innerHTML = Object.entries(relays).map(([url, phases]) => {
      const ok = Object.values(phases).every((p) => p.ok);
      const count = Object.values(phases).reduce((a, p) => a + p.count, 0);
      return `<div class="relay-row"><span><span class="status-dot${ok ? '' : ' bad'}"></span>${esc(url.replace('wss://', ''))}</span>
        <span class="muted num">${num(count)} events${ok ? '' : ' · partial'}</span></div>`;
    }).join('') || '<div class="muted">No completed sync yet.</div>';
    main.querySelector('#roles').innerHTML = s.roles.map((r) => `<div class="relay-row"><span>${esc(ROLE_LABELS[r.role] || r.role)}</span>
      <span class="num">${num(r.n)}</span></div>`).join('');
    if (!log.childElementCount) {
      log.innerHTML = s.runs.slice(0, 8).map((r) => `<div><span class="muted">${new Date(r.started_at * 1000).toLocaleString('en-US')}</span>
        <span class="${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'err' : 'warn'}">${esc(r.status)}</span>
        ${r.summary?.added ? esc(Object.entries(r.summary.added).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new') : ''}</div>`).join('');
    }
  };

  const unsubscribe = onSyncEvent((e) => {
    if (!main.isConnected) { unsubscribe(); return; }
    if (e.type === 'start') log.innerHTML = '';
    const lines = (e.backlog || [e]).map(logLine).join('');
    if (lines) { log.insertAdjacentHTML('beforeend', lines); log.scrollTop = log.scrollHeight; }
    if (e.type === 'start' || e.type === 'running') { btn.disabled = true; btn.textContent = 'Syncing…'; }
    if (e.type === 'idle') refreshStatus().then(loadFeed);
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const res = await fetch('/api/sync', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { toast(body.reason || 'Could not start a sync'); btn.disabled = false; }
  });

  const loadFeed = async () => { main.querySelector('#feed').innerHTML = feedItems(await get('/api/activity', { limit: 40 })); };
  await Promise.all([refreshStatus(), loadFeed()]);
}

const ENDPOINTS = [
  ['GET', '/api/overview', 'Index totals: releases, creators, purchases, sats, monthly series and counts by type.'],
  ['GET', '/api/releases?q=&kind=&creator=&sort=newest&period=&limit=24&offset=0', 'Search and page through releases. <code>sort</code>: newest, oldest, sales, earned, price. <code>kind</code>: 1, 30023, 31337, 31338, 31339, 36787. <code>period</code>: today, week, month, year (rolling windows; sales rankings count only purchases in the window).'],
  ['GET', '/api/releases/{address}', 'One release by <code>kind:pubkey:d</code> address or event id, with buyers, payment legs, comments and the raw signed event.'],
  ['GET', '/api/creators?q=&sort=&period=&limit=24&offset=0', 'Creators ranked by earnings. <code>sort</code>: releases, buyers, newest. <code>period</code>: today, week, month, year.'],
  ['GET', '/api/people/{hex pubkey}', 'Profile, releases, purchases, cashu wallet mints and follower counts for anyone in the archive.'],
  ['GET', '/api/supporters?period=&limit=50&offset=0', 'Buyers ranked by sats spent. <code>period</code>: today, week, month, year.'],
  ['GET', '/api/activity?limit=30', 'Most recent sales, releases and comments.'],
  ['GET', '/api/events?role=&kind=&author=&since=&until=&limit=100', 'Raw signed Nostr events straight from the store. <code>role</code>: content, zap, nutzap, comment, reaction, repost, deletion, profile, follows, relays, wallet.'],
  ['GET', '/api/sync', 'Sync history, live progress, relay results, archive composition and daily quota use.'],
  ['POST', '/api/sync', 'Start a sync now (one at a time, rate limited).']
];

const STATIC_ENDPOINTS = [
  ['GET', '/api/v1/meta.json', 'Build time, last crawl, recent sync runs with per-relay results, and event counts by type.'],
  ['GET', '/api/v1/overview.json', 'Index totals: releases, creators, purchases, sats, monthly series and counts by type. <code>overview.test.json</code> includes staging and test releases.'],
  ['GET', '/api/v1/releases/all.json', 'Every listed release as a card with sales and engagement stats; filter, sort and page it yourself. <code>today</code>, <code>week</code>, <code>month</code> and <code>year</code> files hold the same cards with stats counted only in that rolling window. Test releases are included with <code>isTest: true</code>.'],
  ['GET', '/api/v1/release/{key}.json', 'One release with buyers, payment legs, comments and the raw signed event. <code>key</code> is the first 32 hex characters of sha256 of its <code>kind:pubkey:d</code> address; <code>release/ids.json</code> maps revision event ids to keys.'],
  ['GET', '/api/v1/creators/all.json', 'Creators ranked by earnings (also <code>today</code>, <code>week</code>, <code>month</code>, <code>year</code>; add <code>.test</code> before <code>.json</code> to count test releases).'],
  ['GET', '/api/v1/people/{hex pubkey}.json', 'Profile, releases, purchases, cashu wallet mints and follower counts for anyone in the archive.'],
  ['GET', '/api/v1/supporters/all.json', 'Buyers ranked by sats spent, with the same period and <code>.test</code> variants.'],
  ['GET', '/api/v1/activity.json', 'The 100 most recent sales, releases and comments.'],
  ['GET', '/api/v1/events/manifest.json', 'Index of every raw signed Nostr event in the archive, by role, split into newest-first shards at <code>events/{role}/{n}.json</code>.']
];

/** Renders the API reference. */
export async function renderApi(main) {
  const origin = new URL('.', location.href).href.replace(/\/$/, '');
  const isStaticSite = await isStatic();
  const endpoints = isStaticSite ? STATIC_ENDPOINTS : ENDPOINTS;
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">For developers</div><h1>Open API</h1>
      <p>${isStaticSite
        ? 'Everything on this site comes from these static JSON files, rebuilt from Nostr on a schedule and open to anyone. There is no rate limit and no query language: download a file and filter it yourself.'
        : 'Everything on this site comes from these JSON endpoints, and they\'re open to anyone. Add <code>test=1</code> to any list endpoint to include staging and test releases.'}</p></div>
    <div class="panel" style="margin-bottom:24px"><h3>How the data is collected</h3>
      <p class="summary" style="font-size:14.5px;margin:8px 0 0">On every scheduled run the crawler reads every event carrying the Fanfares NIP-89 handler tag from
      fanfares.nostr1.com, relay.primal.net, nos.lol and relay.damus.io, paging through each relay's history. It then collects the zap receipts (kind 9735),
      nutzaps (9321), comments (1111), reactions (7), reposts (6, 16) and deletions (5) that point at those releases, and finally the profiles (0),
      follow lists (3), relay lists (10002) and ecash wallets (10019) of every creator, buyer and commenter. Purchases marked <b>Verified</b> were
      confirmed by the Fanfares key server; purchases marked <b>Receipts</b> are matched from public payment receipts adding up to the price.</p></div>
    ${endpoints.map(([m, p, d]) => `<div class="endpoint"><div class="path"><span class="m${m === 'POST' ? ' post' : ''}">${m}</span>${esc(p)}</div><p>${d}</p>
      ${m === 'GET' && !p.includes('{') && !p.includes('stream') ? `<a class="try" href="${esc(p.split('?')[0])}" target="_blank" rel="noopener">Try it →</a>` : ''}</div>`).join('')}
    <div class="panel"><h3>Example</h3><details class="raw" open><summary>curl</summary><pre>${isStaticSite ? `curl '${esc(origin)}/api/v1/releases/all.json'` : `curl '${esc(origin)}/api/releases?sort=sales&amp;limit=3'`}</pre></details></div>`;
}
