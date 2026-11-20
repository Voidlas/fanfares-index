/**
 * Overview: the public face of the Fanfares Index.
 *
 *   hero          what the index is, and the all-time sats paid to creators
 *   pulse         a period switch (7 days to all time) over four headline
 *                 numbers; each tile picks the monthly trend chart below it
 *   top           releases, creators and supporters of that period
 *   inside        four insight cards: price points, concentration, loyalty, rails
 *   shelves       all-time best sellers and just released, with artwork
 *   now           the live activity feed, formats and what the archive holds
 *
 * The pulse, top lists and insight cards come from /api/insights (static
 * snapshot only); other deployments fall back to the period leaderboards.
 */
import { get, isStatic } from '../api.js';
import { hbars, monthlyBars } from '../charts.js';
import {
  buyerRows, change, creatorRows, listPeriod, monthYear, pct, releaseRows, savedWindow, windowName, windowSwitch
} from '../insights-ui.js';
import { compact, cover, esc, gridSkeleton, num, plural, releaseGrid, releaseHref } from '../ui.js';
import { feedItems } from './feed.js';
import { renderLeaderboards } from './leaderboards.js';

/** Pulse tiles: [key in insights.current, label, monthly series key, chart label, value formatter]. */
const TILES = [
  ['sats', 'Sats paid', 'sats', 'Sats paid to creators', (v) => `${num(v)} sats`],
  ['sales', 'Purchases', 'sales', 'Purchases', (v) => plural(v, 'purchase')],
  ['newBuyers', 'New buyers', 'newBuyers', 'New buyers', (v) => plural(v, 'new buyer')],
  ['releases', 'New releases', 'releases', 'New releases', (v) => plural(v, 'release')]
];

const skeleton = (h) => `<div class="skeleton" style="height:${h}px"></div>`;

/** Renders the overview into `main`. */
export async function renderHome(main) {
  main.innerHTML = `
    <section class="home-hero">
      <div class="hero">
        <span class="live-dot">Live from Nostr · updated every hour</span>
        <h1>Everything that has ever happened<span class="accent"> on Fanfares.</span></h1>
        <p class="lede">Every release, creator and buyer, and the zap receipts behind every purchase, indexed from Nostr
          and open through one API.</p>
        <div class="hero-actions">
          <a class="btn primary" href="#/releases">Search the archive</a>
          <a class="btn" href="#/insights">Explore insights</a>
        </div>
      </div>
      <div class="hero-card" id="headline">${skeleton(220)}</div>
    </section>

    <section class="section pulse" id="pulse">
      <div class="section-head wrap"><h2>The pulse</h2><div id="pulse-window"></div></div>
      <div class="panel">
        <div class="pulse-tiles" id="pulse-tiles">${TILES.map(() => `<div class="pulse-tile">${skeleton(64)}</div>`).join('')}</div>
        <div id="pulse-chart">${skeleton(240)}</div>
        <div class="pulse-foot"><span id="pulse-note"></span><a class="more" href="#/insights">All insights →</a></div>
      </div>
    </section>

    <section class="section" id="top">
      <div class="section-head"><h2 id="top-title">Top of the period</h2></div>
      <div class="boards">
        <div><h3 class="board-title">Releases <a class="more" id="more-releases">View all</a></h3><div class="rows" id="top-releases">${skeleton(260)}</div></div>
        <div><h3 class="board-title">Creators <a class="more" id="more-creators">View all</a></h3><div class="rows" id="top-creators">${skeleton(260)}</div></div>
        <div><h3 class="board-title">Supporters <a class="more" id="more-supporters">View all</a></h3><div class="rows" id="top-buyers">${skeleton(260)}</div></div>
      </div>
    </section>

    <section class="section" id="inside">
      <div class="section-head"><h2>Inside the numbers</h2><a class="more" href="#/insights">All insights</a></div>
      <div class="ins-grid" id="inside-cards">${Array.from({ length: 4 }, () => `<div class="panel">${skeleton(180)}</div>`).join('')}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>All-time best sellers</h2><a class="more" href="#/releases?sort=sales">View all</a></div>
      <div id="best" class="shelf">${gridSkeleton(6)}</div>
    </section>

    <section class="section grid-2">
      <div>
        <div class="section-head"><h2>Happening now</h2><a class="more" href="#/live">View all</a></div>
        <div id="feed"></div>
      </div>
      <div class="panel">
        <h3>What's published</h3>
        <div class="panel-sub">Releases by type</div>
        <div id="kinds"></div>
        <h3 style="margin-top:32px">On the record</h3>
        <div class="panel-sub">Signed events in the archive</div>
        <div id="archive"></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Just released</h2><a class="more" href="#/releases">View all</a></div>
      <div id="newest" class="shelf">${gridSkeleton(6)}</div>
    </section>`;

  const $ = (sel) => main.querySelector(sel);
  const staticSite = await isStatic();
  if (staticSite) renderPulse(main);
  else {
    // No insights on this deployment: period leaderboards replace pulse, top and inside.
    $('#pulse').remove();
    $('#inside').remove();
    renderLeaderboards($('#top'));
  }

  const [ov, best, newest, feed] = await Promise.all([
    get('/api/overview'),
    get('/api/releases', { sort: 'sales', limit: 12 }),
    get('/api/releases', { sort: 'newest', limit: 6 }),
    get('/api/activity', { limit: 8 })
  ]);
  if (!$('#headline')) return;

  // One artwork per creator, best sellers first, so the strip shows the breadth of the catalog.
  const seen = new Set();
  const covers = [...best.items, ...newest.items]
    .filter((r) => r.cover && !seen.has(r.author.pubkey) && seen.add(r.author.pubkey)).slice(0, 4);
  const firstMonth = ov.monthly.find((m) => m.month)?.month;
  $('#headline').innerHTML = `
    <div class="eyebrow">Paid to creators on Fanfares</div>
    <div class="big">${num(ov.salesSats)}<small>sats</small></div>
    <div class="sub">${num(ov.sales)} purchases by ${num(ov.buyers)} people${firstMonth ? ` since ${monthYear(Date.parse(`${firstMonth}-01T00:00:00Z`) / 1000)}` : ''},
      settled peer to peer</div>
    <div class="hero-facts">
      <div><b>${num(ov.releases)}</b><span>releases</span></div>
      <div><b>${num(ov.creators)}</b><span>creators</span></div>
      <div><b>${num(ov.verifiedSales)}</b><span>verified sales</span></div>
    </div>
    <div class="hero-covers">${covers.map((r) => `<a href="${releaseHref(r.address)}" title="${esc(r.title)}">${cover(r, { eager: true })}</a>`).join('')}</div>`;

  $('#best').innerHTML = releaseGrid(best.items.slice(0, 6));
  $('#newest').innerHTML = releaseGrid(newest.items);
  $('#feed').innerHTML = feedItems(feed);
  $('#kinds').innerHTML = hbars(ov.byKind.map((k) => ({ label: `${k.label}s`, count: k.count })));
  const a = ov.archive;
  $('#archive').innerHTML = hbars([
    { label: 'Payments', count: ov.payments },
    { label: 'Profiles', count: a.profiles },
    { label: 'Reactions', count: a.reactions },
    { label: 'Comments', count: a.comments },
    { label: 'Ecash wallets', count: a.wallets }
  ]);
}

/** The pulse, top lists and insight cards, all driven by one period switch. */
function renderPulse(main) {
  const $ = (sel) => main.querySelector(sel);
  let win = savedWindow();
  let metric = 'sats';
  let data = null;
  let seq = 0;

  const chartHost = $('#pulse-chart');
  const drawChart = () => {
    if (!data) return;
    const [, , series, label, format] = TILES.find(([k]) => k === metric);
    monthlyBars(chartHost, data.monthly.map((m) => ({ month: m.month, value: m[series] })), { format, label });
  };
  let lastWidth = chartHost.clientWidth;
  const observer = new ResizeObserver(() => {
    if (!chartHost.isConnected) { observer.disconnect(); return; }
    if (Math.abs(chartHost.clientWidth - lastWidth) > 8) { lastWidth = chartHost.clientWidth; drawChart(); }
  });
  observer.observe(chartHost);

  const drawTiles = () => {
    const c = data.current;
    const p = data.previous;
    $('#pulse-tiles').innerHTML = TILES.map(([key, label]) => `
      <button class="pulse-tile" data-metric="${key}" aria-pressed="${key === metric}">
        <span class="label">${esc(label)}</span>
        <span class="value">${key === 'sats' ? compact(c[key]) : num(c[key])}</span>
        <span class="hint">${esc(change(c[key], p?.[key], data))}</span>
      </button>`).join('');
    $('#pulse-tiles').querySelectorAll('[data-metric]').forEach((b) => b.addEventListener('click', () => {
      metric = b.dataset.metric;
      $('#pulse-tiles').querySelectorAll('[data-metric]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      drawChart();
    }));
  };

  const show = async () => {
    const mine = ++seq;
    const d = await get('/api/insights', { period: win });
    if (mine !== seq || !chartHost.isConnected) return;
    const first = !data;
    data = d;
    drawTiles();
    if (first) drawChart();
    const name = windowName(win);
    $('#pulse-note').textContent = `Numbers for the ${name}${d.previous ? ', compared with the period before' : ''}. Chart: every month on record.`;
    $('#top-title').textContent = `Top of the ${name}`;
    const lp = listPeriod(win);
    $('#more-releases').href = `#/releases?sort=sales${lp ? `&period=${lp}` : ''}`;
    $('#more-creators').href = `#/creators${lp ? `?period=${lp}` : ''}`;
    $('#more-supporters').href = `#/supporters${lp ? `?period=${lp}` : ''}`;
    $('#top-releases').innerHTML = releaseRows(d.topReleases, 5);
    $('#top-creators').innerHTML = creatorRows(d.topCreators, 5);
    $('#top-buyers').innerHTML = buyerRows(d.topBuyers, 5);
    $('#inside-cards').innerHTML = insideCards(d, name);
  };
  windowSwitch($('#pulse-window'), win, (w) => { win = w; show(); });
  show();
}

/** Four insight cards for one window: a headline figure, a sentence and a small breakdown. */
function insideCards(d, name) {
  const c = d.current;
  const card = (title, big, sentence, body) => `<a class="panel insight-card" href="#/insights">
    <h3>${esc(title)}</h3><div class="big-num">${big}</div><div class="panel-sub">${esc(sentence)}</div>${body}</a>`;
  if (!c.sales) return `<div class="empty">No purchases in the ${esc(name)} yet.</div>`;

  const bands = d.priceBands.filter((b) => b.releases);
  const topBand = bands.reduce((a, b) => (b.sats > a.sats ? b : a), bands[0]);
  const mostSold = bands.reduce((a, b) => (b.sales > a.sales ? b : a), bands[0]);
  const lightning = d.rails.find((r) => r.rail === 'lightning');
  const legs = d.rails.reduce((n, r) => n + r.payments, 0);

  return [
    card('Price points that sell', `${pct(topBand.sats / c.sats)}`,
      `of sats came from releases priced ${topBand.label} sats; the most purchases were at ${mostSold.label}.`,
      hbars(bands.map((b) => ({ label: b.label, count: b.sats })), { format: compact })),
    card('Where the money goes', pct(d.concentration.topCreatorShare),
      `of sats went to the top creator, and ${pct(d.concentration.top5Share)} to the top five, of ${plural(c.creatorsPaid, 'creator')} paid.`,
      hbars([
        { label: 'Top creator', count: d.concentration.topCreatorShare },
        { label: 'Top 5', count: d.concentration.top5Share },
        { label: 'Everyone else', count: Math.max(0, 1 - d.concentration.top5Share) }
      ], { format: pct })),
    card('Buyer loyalty', pct(c.buyers ? d.repeatBuyers / c.buyers : 0),
      `of ${plural(c.buyers, 'buyer')} bought more than once in the ${name}.`,
      hbars(d.repeat.map((b) => ({ label: b.label, count: b.buyers })))),
    card('How people pay', pct(legs ? lightning.payments / legs : 0),
      `of ${plural(legs, 'payment')} were lightning zaps; the rest were cashu nutzaps.`,
      hbars(d.rails.map((r) => ({ label: r.label, count: r.payments }))))
  ].join('');
}
