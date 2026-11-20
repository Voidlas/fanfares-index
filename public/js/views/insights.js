/**
 * Insights: how Fanfares is growing. Month-by-month trends, the last 30 days
 * against the 30 before, price points that sell, payment rails, buyer
 * loyalty and who is earning right now.
 *
 * Reads /api/insights, which only the static snapshot publishes
 * (snapshot/insights.mjs); other deployments show a short notice.
 */
import { get, isStatic } from '../api.js';
import { hbars, monthlyBars } from '../charts.js';
import { ago, avatar, compact, displayName, esc, num, personHref, plural, releaseHref, sats } from '../ui.js';

const pct = (x) => `${Math.round(x * 100)}%`;

/** "+104% vs previous 30 days", in neutral ink: growth is context, not a status. */
function change(now, before, days) {
  if (!before) return now ? `none in the ${days} days before` : `none in the ${days} days before either`;
  const d = Math.round(((now - before) / before) * 100);
  if (d === 0) return `same as the previous ${days} days`;
  return `${d > 0 ? '↑' : '↓'} ${Math.abs(d)}% vs previous ${days} days`;
}

/** Monthly chart panels: [host id, title, subtitle, series key, value formatter, tooltip extra]. */
const CHARTS = [
  ['ch-sats', 'Sats paid to creators', 'Every purchase, by the month it was paid', 'sats', (v) => `${num(v)} sats`, (m) => `${plural(m.sales, 'purchase')}`],
  ['ch-sales', 'Purchases', 'Count of purchases, whatever the price', 'sales', (v) => plural(v, 'purchase'), (m) => `${num(m.sats)} sats`],
  ['ch-buyers', 'New buyers', 'People making their first purchase', 'newBuyers', (v) => plural(v, 'new buyer'), null],
  ['ch-releases', 'New releases', 'Releases published, and creators publishing their first', 'releases', (v) => plural(v, 'release'),
    (m) => (m.newCreators ? `${plural(m.newCreators, 'new creator')}` : '')]
];

/** Renders the Insights page into `main`. */
export async function renderInsights(main) {
  document.title = 'Insights · Fanfares Index';
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Insights</div><h1>How Fanfares is growing</h1>
      <p id="ins-lede">Trends from every purchase and release in the archive, recomputed with each hourly snapshot.</p></div>
    <div class="stats ins-stats" id="ins-stats">${Array.from({ length: 5 }, () => '<div class="stat"><div class="skeleton" style="height:60px"></div></div>').join('')}</div>
    <section class="section ins-grid" id="ins-charts">${CHARTS.map(([id, title, sub]) => `
      <div class="panel"><h3>${esc(title)}, by month</h3><div class="panel-sub">${esc(sub)}</div><div id="${id}"><div class="skeleton" style="height:190px"></div></div></div>`).join('')}
    </section>
    <section class="section ins-grid">
      <div class="panel">
        <h3>Price points that sell</h3>
        <div class="panel-sub">Listed releases grouped by price in sats, with everything they have sold</div>
        <div class="table-wrap" id="ins-prices"></div>
      </div>
      <div class="panel">
        <h3>Where the money goes</h3>
        <div class="panel-sub" id="ins-conc-sub">Share of all sats earned</div>
        <div id="ins-conc"></div>
        <h3 style="margin-top:32px">Sats by format</h3>
        <div class="panel-sub">What each type of release has earned</div>
        <div id="ins-kinds"></div>
      </div>
      <div class="panel">
        <h3>Buyer loyalty</h3>
        <div class="panel-sub" id="ins-repeat-sub">Buyers by how many purchases they have made</div>
        <div id="ins-repeat"></div>
      </div>
      <div class="panel">
        <h3>How people pay</h3>
        <div class="panel-sub">Payment legs to creators: lightning zaps or cashu nutzaps</div>
        <div id="ins-rails"></div>
      </div>
    </section>
    <section class="section grid-2 even">
      <div>
        <div class="section-head"><h2>Top releases, last 30 days</h2><a class="more" href="#/releases?sort=sales&period=month">View all</a></div>
        <div class="rows" id="ins-top-releases"></div>
      </div>
      <div>
        <div class="section-head"><h2>Top earners, last 30 days</h2><a class="more" href="#/creators?period=month">View all</a></div>
        <div class="rows" id="ins-top-creators"></div>
      </div>
    </section>`;

  if (!(await isStatic())) {
    main.querySelector('#ins-stats').outerHTML = '<div class="empty">Insights are published with the static snapshot. This server does not provide them yet.</div>';
    main.querySelectorAll('.section').forEach((s) => s.remove());
    return;
  }
  const d = await get('/api/insights');
  const days = d.windowDays;
  main.querySelector('#ins-lede').textContent =
    `Trends from every purchase and release in the archive, recomputed with each hourly snapshot (this one ${ago(d.builtAt)}).`;

  const r = d.recent;
  const p = d.previous;
  main.querySelector('#ins-stats').innerHTML = [
    [`Sats, last ${days} days`, compact(r.sats), change(r.sats, p.sats, days)],
    ['Purchases', num(r.sales), change(r.sales, p.sales, days)],
    ['Buyers', num(r.buyers), change(r.buyers, p.buyers, days)],
    ['New buyers', num(r.newBuyers), change(r.newBuyers, p.newBuyers, days)],
    ['New releases', num(r.releases), `${plural(r.newCreators, 'new creator')} · ${change(r.releases, p.releases, days)}`]
  ].map(([label, value, hint]) => `<div class="stat"><div class="label">${esc(label)}</div>
    <div class="value">${value}</div><div class="hint">${esc(hint)}</div></div>`).join('');

  // Monthly charts, redrawn when their width changes.
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

  // Price bands, hiding empty ones (no free releases yet, for example).
  main.querySelector('#ins-prices').innerHTML = `<table>
    <thead><tr><th>Price</th><th class="r">Releases</th><th class="r">Selling</th><th class="r">Sales</th><th class="r">Sats</th></tr></thead>
    <tbody>${d.priceBands.filter((b) => b.releases).map((b) => `<tr><td class="nowrap">${esc(b.label)}</td>
      <td class="r num">${num(b.releases)}</td><td class="r num muted">${pct(b.sellingReleases / b.releases)}</td>
      <td class="r num">${num(b.sales)}</td><td class="r num">${num(b.sats)}</td></tr>`).join('')}</tbody></table>
    <p class="ins-note">“Selling” is the share of releases in the band with at least one purchase.</p>`;

  const t = d.totals;
  const c = d.concentration;
  main.querySelector('#ins-conc-sub').textContent = `Share of all ${num(t.sats)} sats, across ${plural(t.creatorsPaid, 'paid creator')}`;
  main.querySelector('#ins-conc').innerHTML = hbars([
    { label: 'Top creator', count: c.topCreatorShare },
    { label: 'Top 5', count: c.top5Share },
    { label: 'Everyone else', count: Math.max(0, 1 - c.top5Share) }
  ], { format: pct });
  main.querySelector('#ins-kinds').innerHTML = hbars(d.kinds.map((k) => ({ label: `${k.label}s`, count: k.sats })), { format: compact });

  main.querySelector('#ins-repeat-sub').textContent =
    `${pct(t.buyers ? t.repeatBuyers / t.buyers : 0)} of ${num(t.buyers)} buyers have come back for more`;
  main.querySelector('#ins-repeat').innerHTML = hbars(d.repeat.map((b) => ({ label: b.label, count: b.buyers })));

  main.querySelector('#ins-rails').innerHTML = hbars(d.rails.map((x) => ({ label: x.label, count: x.payments })))
    + `<p class="ins-note">${d.rails.map((x) => `${esc(x.label)}: ${num(x.sats)} sats`).join(' · ')}</p>`;

  main.querySelector('#ins-top-releases').innerHTML = d.topReleases.length ? d.topReleases.map((x, i) => `
    <a class="row" href="${releaseHref(x.address)}">
      <span class="rank">${i + 1}</span>
      <div class="grow"><div class="title">${esc(x.title)}</div><div class="sub">${esc(x.kindLabel || '')} · ${esc(displayName(x.author))} · ${plural(x.sales, 'purchase')}</div></div>
      <div class="right">${sats(x.sats)}</div>
    </a>`).join('') : `<div class="empty">No purchases in the last ${days} days.</div>`;
  main.querySelector('#ins-top-creators').innerHTML = d.topCreators.length ? d.topCreators.map((x, i) => `
    <a class="row" href="${personHref(x.pubkey)}">
      <span class="rank">${i + 1}</span>${avatar(x, 40)}
      <div class="grow"><div class="title">${esc(displayName(x))}</div><div class="sub">${plural(x.sales, 'purchase')} · ${plural(x.buyers, 'buyer')}</div></div>
      <div class="right">${sats(x.sats)}</div>
    </a>`).join('') : `<div class="empty">No purchases in the last ${days} days.</div>`;
}
