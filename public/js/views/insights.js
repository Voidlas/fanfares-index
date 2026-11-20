/**
 * Insights: how Fanfares is growing. A window switch (7 days to all time)
 * drives the headline numbers, breakdowns and rankings; the monthly charts
 * always show the full history.
 *
 * Reads /api/insights, which only the static snapshot publishes
 * (snapshot/insights.mjs); other deployments show a short notice.
 */
import { get, isStatic } from '../api.js';
import { hbars, monthlyBars } from '../charts.js';
import { buyerRows, change, creatorRows, listPeriod, pct, releaseRows, savedWindow, WINDOWS, windowName, windowSwitch } from '../insights-ui.js';
import { ago, compact, esc, kindPlural, num, plural } from '../ui.js';

/** Monthly chart panels: [host id, title, subtitle, series key, value formatter, tooltip extra]. */
const CHARTS = [
  ['ch-sats', 'Sats paid to creators', 'Every purchase, by the month it was paid', 'sats', (v) => `${num(v)} sats`, (m) => plural(m.sales, 'purchase')],
  ['ch-sales', 'Purchases', 'Count of purchases, whatever the price', 'sales', (v) => plural(v, 'purchase'), (m) => `${num(m.sats)} sats`],
  ['ch-buyers', 'New buyers', 'People making their first purchase', 'newBuyers', (v) => plural(v, 'new buyer'), null],
  ['ch-releases', 'Events published', 'Events published, and creators publishing their first', 'releases', (v) => plural(v, 'event'),
    (m) => (m.newCreators ? plural(m.newCreators, 'new creator') : '')]
];

/**
 * Renders the Insights page into `main`.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query `period` picks the window (7d, 30d, 90d, 365d, all).
 */
export async function renderInsights(main, query) {
  document.title = 'Insights · Fanfares Index';
  let win = WINDOWS.some(([k]) => k === query.get('period')) ? query.get('period') : savedWindow();
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Insights</div><h1>How Fanfares is growing</h1>
      <p id="ins-lede">Trends from every purchase and published event in the archive, recomputed with each hourly snapshot.</p></div>
    <div class="filters"><div id="ins-window"></div><span class="muted ins-compare" id="ins-compare"></span></div>
    <div class="stats ins-stats" id="ins-stats">${Array.from({ length: 5 }, () => '<div class="stat"><div class="skeleton" style="height:60px"></div></div>').join('')}</div>

    <section class="section ins-grid">
      <div class="panel">
        <h3>Price points that sell</h3>
        <div class="panel-sub" id="ins-prices-sub"></div>
        <div class="table-wrap" id="ins-prices"></div>
      </div>
      <div class="panel">
        <h3>Where the money goes</h3>
        <div class="panel-sub" id="ins-conc-sub"></div>
        <div id="ins-conc"></div>
        <h3 style="margin-top:32px">Sats by format</h3>
        <div class="panel-sub">What each format earned</div>
        <div id="ins-kinds"></div>
      </div>
      <div class="panel">
        <h3>Buyer loyalty</h3>
        <div class="panel-sub" id="ins-repeat-sub"></div>
        <div id="ins-repeat"></div>
      </div>
      <div class="panel">
        <h3>How people pay</h3>
        <div class="panel-sub">Payment legs to creators: lightning zaps or cashu nutzaps</div>
        <div id="ins-rails"></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 id="ins-top-title">Top of the period</h2></div>
      <div class="boards">
        <div><h3 class="board-title">Events <a class="more" id="ins-more-releases">View all</a></h3><div class="rows" id="ins-top-releases"></div></div>
        <div><h3 class="board-title">Creators <a class="more" id="ins-more-creators">View all</a></h3><div class="rows" id="ins-top-creators"></div></div>
        <div><h3 class="board-title">Supporters <a class="more" id="ins-more-supporters">View all</a></h3><div class="rows" id="ins-top-buyers"></div></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Month by month</h2><span class="muted ins-compare">Full history, whatever the period above</span></div>
      <div class="ins-grid" id="ins-charts">${CHARTS.map(([id, title, sub]) => `
        <div class="panel"><h3>${esc(title)}</h3><div class="panel-sub">${esc(sub)}</div><div id="${id}"><div class="skeleton" style="height:190px"></div></div></div>`).join('')}
      </div>
    </section>`;

  if (!(await isStatic())) {
    main.querySelector('#ins-stats').outerHTML = '<div class="empty">Insights are published with the static snapshot. This server does not provide them yet.</div>';
    main.querySelectorAll('.section, .filters').forEach((s) => s.remove());
    return;
  }

  let seq = 0;
  const show = async () => {
    const mine = ++seq;
    const d = await get('/api/insights', { period: win });
    if (mine !== seq || !main.querySelector('#ins-stats')) return null;
    renderWindow(main, d, win);
    return d;
  };
  windowSwitch(main.querySelector('#ins-window'), win, (w) => {
    win = w;
    // Keep the address shareable without re-running the router.
    history.replaceState(null, '', `#/insights?period=${w}`);
    show();
  });
  const d = await show();
  if (d) renderCharts(main, d);
}

/** Everything that depends on the selected window. */
function renderWindow(main, d, win) {
  const name = windowName(win);
  const c = d.current;
  const p = d.previous;
  const $ = (id) => main.querySelector(id);
  $('#ins-lede').textContent = `Trends from every purchase and published event in the archive, recomputed with each hourly snapshot (this one ${ago(d.builtAt)}).`;
  $('#ins-compare').textContent = p ? `Compared with the ${WINDOWS.find(([k]) => k === win)[1]} before` : 'Everything since the first sale';

  $('#ins-stats').innerHTML = [
    ['Sats paid', compact(c.sats), change(c.sats, p?.sats, d)],
    ['Purchases', num(c.sales), change(c.sales, p?.sales, d)],
    ['Buyers', num(c.buyers), change(c.buyers, p?.buyers, d)],
    ['New buyers', num(c.newBuyers), change(c.newBuyers, p?.newBuyers, d)],
    ['New events', num(c.releases), `${plural(c.newCreators, 'new creator')} · ${change(c.releases, p?.releases, d)}`]
  ].map(([label, value, hint]) => `<div class="stat"><div class="label">${esc(label)}</div>
    <div class="value">${value}</div><div class="hint">${esc(hint)}</div></div>`).join('');

  $('#ins-prices-sub').textContent = `Published events by price in sats, and what they sold in the ${name}`;
  $('#ins-prices').innerHTML = `<table>
    <thead><tr><th>Price</th><th class="r">Events</th><th class="r">Selling</th><th class="r">Sales</th><th class="r">Sats</th></tr></thead>
    <tbody>${d.priceBands.filter((b) => b.releases).map((b) => `<tr><td class="nowrap">${esc(b.label)}</td>
      <td class="r num">${num(b.releases)}</td><td class="r num muted">${pct(b.sellingReleases / b.releases)}</td>
      <td class="r num">${num(b.sales)}</td><td class="r num">${num(b.sats)}</td></tr>`).join('')}</tbody></table>
    <p class="ins-note">“Selling” is the share of events in the band with at least one purchase in the period.</p>`;

  const conc = d.concentration;
  $('#ins-conc-sub').textContent = c.sats
    ? `Share of ${num(c.sats)} sats paid in the ${name}, across ${plural(c.creatorsPaid, 'creator')}`
    : `No sats paid in the ${name}`;
  $('#ins-conc').innerHTML = c.sats ? hbars([
    { label: 'Top creator', count: conc.topCreatorShare },
    { label: 'Top 5', count: conc.top5Share },
    { label: 'Everyone else', count: Math.max(0, 1 - conc.top5Share) }
  ], { format: pct }) : '';
  $('#ins-kinds').innerHTML = hbars(d.kinds.map((k) => ({ label: kindPlural(k.kind), count: k.sats })), { format: compact });

  $('#ins-repeat-sub').textContent = c.buyers
    ? `${pct(d.repeatBuyers / c.buyers)} of ${plural(c.buyers, 'buyer')} bought more than once in the ${name}`
    : `No buyers in the ${name}`;
  $('#ins-repeat').innerHTML = hbars(d.repeat.map((b) => ({ label: b.label, count: b.buyers })));
  $('#ins-rails').innerHTML = hbars(d.rails.map((x) => ({ label: x.label, count: x.payments })))
    + `<p class="ins-note">${d.rails.map((x) => `${esc(x.label)}: ${num(x.sats)} sats`).join(' · ')}</p>`;

  $('#ins-top-title').textContent = `Top of the ${name}`;
  const lp = listPeriod(win);
  $('#ins-more-releases').href = `#/events?sort=sales${lp ? `&period=${lp}` : ''}`;
  $('#ins-more-creators').href = `#/creators${lp ? `?period=${lp}` : ''}`;
  $('#ins-more-supporters').href = `#/supporters${lp ? `?period=${lp}` : ''}`;
  $('#ins-top-releases').innerHTML = releaseRows(d.topReleases, 5);
  $('#ins-top-creators').innerHTML = creatorRows(d.topCreators, 5);
  $('#ins-top-buyers').innerHTML = buyerRows(d.topBuyers, 5);
}

/** Monthly charts (the same for every window), redrawn when their width changes. */
function renderCharts(main, d) {
  const draws = CHARTS.map(([id, title, , key, format, extra]) => {
    const host = main.querySelector(`#${id}`);
    const rows = d.monthly.map((m) => ({ month: m.month, value: m[key], extra: extra ? extra(m) : '' }));
    const draw = () => monthlyBars(host, rows, { format, label: title });
    draw();
    return [host, draw, host.clientWidth];
  });
  const observer = new ResizeObserver(() => {
    if (!main.querySelector('#ins-charts')) { observer.disconnect(); return; }
    for (const entry of draws) {
      if (Math.abs(entry[0].clientWidth - entry[2]) > 8) { entry[2] = entry[0].clientWidth; entry[1](); }
    }
  });
  draws.forEach(([host]) => observer.observe(host));
}
