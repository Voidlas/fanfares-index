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
import {
  DEFAULT_WINDOW, buyerRows, change, changeClass, creatorRows, listPeriod, pct, releaseRows, WINDOWS, windowName, windowSwitch
} from '../insights-ui.js';
import { ago, compact, esc, kindPlural, num, plural, satsShort } from '../ui.js';

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
  let win = WINDOWS.some(([k]) => k === query.get('period')) ? query.get('period') : DEFAULT_WINDOW;
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Insights</div><h1>How Fanfares is growing</h1>
      <p id="ins-lede">Trends from every purchase and published event in the archive, recomputed with each hourly snapshot.</p></div>
    <div class="filters"><div id="ins-window"></div><span class="muted ins-compare" id="ins-compare"></span></div>
    <div class="kpis" id="ins-stats">${Array.from({ length: 6 }, () => '<div class="kpi"><div class="skeleton" style="height:56px"></div></div>').join('')}</div>

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
      </div>
      <div class="panel">
        <h3>Formats</h3>
        <div class="panel-sub" id="ins-kinds-sub"></div>
        <div class="table-wrap" id="ins-kinds"></div>
      </div>
      <div class="panel">
        <h3>Record months</h3>
        <div class="panel-sub">The best month on record for each measure</div>
        <div id="ins-records"></div>
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
      <div class="panel ins-wide"><h3>Running total</h3><div class="panel-sub">Every sat ever paid to creators, added up month by month</div><div id="ch-total"><div class="skeleton" style="height:190px"></div></div></div>
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
  const during = win === 'all' ? 'overall' : `in the ${name}`;
  const c = d.current;
  const p = d.previous;
  const $ = (id) => main.querySelector(id);
  $('#ins-lede').textContent = `Trends from every purchase and published event in the archive, recomputed with each hourly snapshot (this one ${ago(d.builtAt)}).`;
  $('#ins-compare').textContent = p ? `Compared with the ${WINDOWS.find(([k]) => k === win)[1]} before` : 'Everything since the first sale';

  const avg = (x) => (x && x.sales ? x.sats / x.sales : 0);
  const perBuyer = (x) => (x && x.buyers ? x.sats / x.buyers : 0);
  $('#ins-stats').innerHTML = [
    ['Sats paid', `<span class="btc-num">${compact(c.sats)}</span>`, change(c.sats, p?.sats, d)],
    ['Purchases', num(c.sales), change(c.sales, p?.sales, d)],
    ['Avg. purchase', `${num(avg(c))}<small>sats</small>`, p ? change(avg(c), avg(p), d) : `${num(perBuyer(c))} sats per buyer`],
    ['Buyers', num(c.buyers), p ? change(c.buyers, p.buyers, d) : `${pct(c.buyers ? d.repeatBuyers / c.buyers : 0)} came back`],
    ['New buyers', num(c.newBuyers), change(c.newBuyers, p?.newBuyers, d)],
    ['Events published', num(c.releases), `${plural(c.newCreators, 'new creator')} · ${plural(c.creatorsPaid, 'creator')} paid`]
  ].map(([label, value, hint]) => `<div class="kpi"><div class="label">${esc(label)}</div>
    <div class="value">${value}</div><div class="hint ${changeClass(hint)}">${esc(hint)}</div></div>`).join('');

  $('#ins-prices-sub').textContent = `Published events by price in sats, and what they sold ${during}`;
  $('#ins-prices').innerHTML = `<table>
    <thead><tr><th>Price</th><th class="r">Events</th><th class="r">Selling</th><th class="r">Sales</th><th class="r">Sats</th></tr></thead>
    <tbody>${d.priceBands.filter((b) => b.releases).map((b) => `<tr><td class="nowrap">${esc(b.label)}</td>
      <td class="r num">${num(b.releases)}</td><td class="r num muted">${pct(b.sellingReleases / b.releases)}</td>
      <td class="r num">${num(b.sales)}</td><td class="r num">${num(b.sats)}</td></tr>`).join('')}</tbody></table>
    <p class="ins-note">“Selling” is the share of events in the band with at least one purchase in the period.</p>`;

  const conc = d.concentration;
  $('#ins-conc-sub').textContent = c.sats
    ? `Share of ${num(c.sats)} sats paid ${during}, across ${plural(c.creatorsPaid, 'creator')}`
    : `No sats paid ${during}`;
  $('#ins-conc').innerHTML = c.sats ? hbars([
    { label: 'Top creator', count: conc.topCreatorShare },
    { label: 'Top 5', count: conc.top5Share },
    { label: 'Everyone else', count: Math.max(0, 1 - conc.top5Share) }
  ], { format: pct }) : '';
  $('#ins-kinds-sub').textContent = `What each format sold and earned ${during}`;
  $('#ins-kinds').innerHTML = `<table>
    <thead><tr><th>Format</th><th class="r">Events</th><th class="r">Sales</th><th class="r">Sats</th><th class="r">Per sale</th></tr></thead>
    <tbody>${[...d.kinds].filter((k) => k.releases).sort((a, b) => b.sats - a.sats).map((k) => `<tr><td class="nowrap"><a href="#/events?kind=${k.kind}">${esc(kindPlural(k.kind))}</a></td>
      <td class="r num">${num(k.releases)}</td><td class="r num">${num(k.sales)}</td><td class="r">${satsShort(k.sats)}</td>
      <td class="r num muted">${k.sales ? num(k.sats / k.sales) : '—'}</td></tr>`).join('')}</tbody></table>`;

  $('#ins-repeat-sub').textContent = c.buyers
    ? `${pct(d.repeatBuyers / c.buyers)} of ${plural(c.buyers, 'buyer')} bought more than once ${during}`
    : `No buyers ${during}`;
  $('#ins-repeat').innerHTML = hbars(d.repeat.map((b) => ({ label: b.label, count: b.buyers })));
  $('#ins-rails').innerHTML = hbars(d.rails.map((x) => ({ label: x.label, count: x.payments })))
    + `<p class="ins-note">${d.rails.map((x) => `${esc(x.label)}: ${num(x.sats)} sats`).join(' · ')}</p>`;

  $('#ins-top-title').textContent = win === 'all' ? 'Top of all time' : `Top of the ${name}`;
  const lp = listPeriod(win);
  $('#ins-more-releases').href = `#/events?sort=sales${lp ? `&period=${lp}` : ''}`;
  $('#ins-more-creators').href = `#/creators${lp ? `?period=${lp}` : ''}`;
  $('#ins-more-supporters').href = `#/supporters${lp ? `?period=${lp}` : ''}`;
  $('#ins-top-releases').innerHTML = releaseRows(d.topReleases, 5);
  $('#ins-top-creators').innerHTML = creatorRows(d.topCreators, 5);
  $('#ins-top-buyers').innerHTML = buyerRows(d.topBuyers, 5);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };

/** Monthly charts and record months (the same for every window), redrawn when their width changes. */
function renderCharts(main, d) {
  const best = (key) => d.monthly.reduce((a, m) => (m[key] > (a?.[key] ?? -1) ? m : a), null);
  const active = d.monthly.filter((m) => m.sales > 0).length;
  main.querySelector('#ins-records').innerHTML = `<div class="records">${[
    ['sats', 'Most sats paid', (v) => `${satsShort(v)} sats`],
    ['sales', 'Most purchases', (v) => plural(v, 'purchase')],
    ['newBuyers', 'Most new buyers', (v) => plural(v, 'new buyer')],
    ['releases', 'Most events published', (v) => plural(v, 'event')],
    ['newCreators', 'Most new creators', (v) => plural(v, 'new creator')]
  ].map(([key, label, fmt]) => { const m = best(key); return m ? `<div class="rec-row"><span>${esc(label)}</span><b>${fmt(m[key])}</b><em>${esc(monthName(m.month))}</em></div>` : ''; }).join('')}
    <div class="rec-row"><span>Months with sales</span><b>${num(active)} of ${num(d.monthly.length)}</b><em>since ${esc(monthName(d.monthly[0]?.month || '2025-01'))}</em></div></div>`;

  let run = 0;
  const totals = d.monthly.map((m) => ({ month: m.month, value: (run += m.sats), extra: `+${num(m.sats)} that month` }));
  const totalHost = main.querySelector('#ch-total');
  const drawTotal = () => monthlyBars(totalHost, totals, { format: (v) => `${num(v)} sats`, label: 'Running total of sats paid', compress: false });
  drawTotal();
  const draws = [[totalHost, drawTotal, totalHost.clientWidth], ...CHARTS.map(([id, title, , key, format, extra]) => {
    const host = main.querySelector(`#${id}`);
    const rows = d.monthly.map((m) => ({ month: m.month, value: m[key], extra: extra ? extra(m) : '' }));
    const draw = () => monthlyBars(host, rows, { format, label: title });
    draw();
    return [host, draw, host.clientWidth];
  })];
  const observer = new ResizeObserver(() => {
    if (!main.querySelector('#ins-charts')) { observer.disconnect(); return; }
    for (const entry of draws) {
      if (Math.abs(entry[0].clientWidth - entry[2]) > 8) { entry[2] = entry[0].clientWidth; entry[1](); }
    }
  });
  draws.forEach(([host]) => observer.observe(host));
}
