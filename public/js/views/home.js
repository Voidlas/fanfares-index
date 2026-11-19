/**
 * Overview: the public face of the Fanfares Index. Headline totals,
 * leaderboards by period, monthly earnings, best-selling releases, top
 * creators and the live activity feed.
 */
import { get } from '../api.js';
import { hbars, monthlyBars } from '../charts.js';
import {
  avatar, compact, cover, displayName, esc, gridSkeleton, num, personHref, plural, releaseGrid, releaseHref, sats
} from '../ui.js';
import { feedItems } from './feed.js';
import { renderLeaderboards } from './leaderboards.js';

/** "2025-09" → "September 2025". */
function monthName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Renders the overview into `main`. */
export async function renderHome(main) {
  main.innerHTML = `
    <section class="hero">
      <span class="live-dot">Live from Nostr · updated automatically</span>
      <h1>Everything that has ever happened<span class="accent"> on Fanfares.</span></h1>
      <p class="lede">Every event ever published, every creator, every buyer, and the zap receipts behind every purchase,
        indexed live from Nostr, searchable in an instant and open through one API. A complete, reliable record no one else on Nostr offers.</p>
      <div class="hero-actions">
        <a class="btn primary" href="#/releases">Search the archive</a>
        <a class="btn" href="#/api">Open API</a>
      </div>
    </section>
    <section class="headline" id="headline">
      <div><div class="skeleton" style="height:150px"></div></div><div><div class="skeleton" style="height:150px"></div></div>
    </section>
    <div class="stats" id="stats">${Array.from({ length: 5 }, () => '<div class="stat"><div class="skeleton" style="height:60px"></div></div>').join('')}</div>

    <section class="section" id="leaderboards"></section>

    <section class="section grid-2">
      <div class="panel">
        <h3>Sats paid to creators, by month</h3>
        <div class="panel-sub">Every purchase is a lightning zap or cashu nutzap, sent straight to the creator's wallet.</div>
        <div id="chart-sats"></div>
        <div class="chart-notes" id="chart-notes"></div>
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
      <div class="section-head"><h2>All-time best sellers</h2><a class="more" href="#/releases?sort=sales">View all</a></div>
      <div id="top" class="shelf">${gridSkeleton(6)}</div>
    </section>

    <section class="section grid-2 even">
      <div>
        <div class="section-head"><h2>Top creators</h2><a class="more" href="#/creators">View all</a></div>
        <div class="rows" id="creators"></div>
      </div>
      <div>
        <div class="section-head"><h2>Happening now</h2><a class="more" href="#/live">View all</a></div>
        <div id="feed"></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Just released</h2><a class="more" href="#/releases">View all</a></div>
      <div id="newest" class="shelf">${gridSkeleton(6)}</div>
    </section>`;

  renderLeaderboards(main.querySelector('#leaderboards'));
  const [ov, top, newest, creators, feed] = await Promise.all([
    get('/api/overview'),
    get('/api/releases', { sort: 'sales', limit: 12 }),
    get('/api/releases', { sort: 'newest', limit: 6 }),
    get('/api/creators', { limit: 6 }),
    get('/api/activity', { limit: 8 })
  ]);

  const seenCovers = new Set();
  // One artwork per creator, best sellers first, so the strip shows the breadth of the catalog.
  const heroCovers = [...top.items, ...newest.items]
    .filter((r) => r.cover && !seenCovers.has(r.author.pubkey) && seenCovers.add(r.author.pubkey)).slice(0, 4);
  main.querySelector('#headline').innerHTML = `
    <div>
      <div class="eyebrow">Paid to creators on Fanfares</div>
      <div class="big">${num(ov.salesSats)}<small>sats</small></div>
      <div class="sub">across ${num(ov.sales)} purchases by ${num(ov.buyers)} people, settled peer to peer</div>
    </div>
    <div><div class="hero-covers">${heroCovers.map((r) => `<a href="${releaseHref(r.address)}" title="${esc(r.title)}">${cover(r, { eager: true })}</a>`).join('')}</div></div>`;

  main.querySelector('#stats').innerHTML = [
    ['Releases', num(ov.releases), `${ov.byKind.length} formats`],
    ['Creators', num(ov.creators), 'publishing on Nostr'],
    ['Purchases', num(ov.sales), `${num(ov.verifiedSales)} verified by Fanfares`],
    ['Supporters', num(ov.buyers), 'unique buyers'],
    ['Sats earned', compact(ov.salesSats), 'straight to creator wallets']
  ].map(([label, value, hint]) => `<div class="stat"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="hint">${hint}</div></div>`).join('');

  const chartHost = main.querySelector('#chart-sats');
  const drawChart = () => monthlyBars(chartHost, ov.monthly.map((m) => ({ month: m.month, value: m.sats, extra: `${num(m.sales)} purchases` })), {
    format: (v) => `${num(v)} sats`, label: 'Sats paid to creators'
  });
  drawChart();
  // Redraw on width changes (rotation, window resize) while this view is open.
  let lastWidth = chartHost.clientWidth;
  const observer = new ResizeObserver(() => {
    if (!chartHost.isConnected) { observer.disconnect(); return; }
    if (Math.abs(chartHost.clientWidth - lastWidth) > 8) { lastWidth = chartHost.clientWidth; drawChart(); }
  });
  observer.observe(chartHost);
  const dated = ov.monthly.filter((m) => m.month);
  const best = dated.reduce((a, m) => (m.sats > (a?.sats || 0) ? m : a), null);
  const last = dated[dated.length - 1];
  main.querySelector('#chart-notes').innerHTML = [
    best && ['Best month', `${monthName(best.month)}`, `${num(best.sats)} sats`],
    last && ['This month', `${num(last.sales)} purchases`, `${num(last.sats)} sats`],
    ['Average purchase', `${num(ov.sales ? ov.salesSats / ov.sales : 0)} sats`, `${num(ov.payments)} payment legs`]
  ].filter(Boolean).map(([l, a, b]) => `<div><span>${l}</span><b>${a}</b><em>${b}</em></div>`).join('');
  main.querySelector('#kinds').innerHTML = hbars(ov.byKind.map((k) => ({ label: `${k.label}s`, count: k.count })));
  const a = ov.archive;
  main.querySelector('#archive').innerHTML = hbars([
    { label: 'Payments', count: ov.payments },
    { label: 'Profiles', count: a.profiles },
    { label: 'Reactions', count: a.reactions },
    { label: 'Comments', count: a.comments },
    { label: 'Ecash wallets', count: a.wallets }
  ]);

  main.querySelector('#top').innerHTML = releaseGrid(top.items.slice(0, 6));
  main.querySelector('#newest').innerHTML = releaseGrid(newest.items);
  main.querySelector('#creators').innerHTML = creators.items.map((c, i) => `
    <a class="row" href="${personHref(c.pubkey)}">
      <span class="rank">${i + 1}</span>${avatar(c, 40)}
      <div class="grow"><div class="title">${esc(displayName(c))}</div><div class="sub">${plural(c.releases, 'release')} · ${plural(c.buyers, 'supporter')}</div></div>
      <div class="right">${sats(c.earnedSats)}</div>
    </a>`).join('');
  main.querySelector('#feed').innerHTML = feedItems(feed);
}
