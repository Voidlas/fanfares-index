/**
 * Overview: the front page of the Fanfares Index, built phone first.
 *
 *   hero      a search field and the sats paid to creators, with one
 *             time-frame control that scopes the whole page
 *   top       most purchased events, top creators and top supporters,
 *             by sats or by purchases (tabs on phones, columns on desktop)
 *   trend     every month on record for one chosen measure
 *   inside    four insight cards (a swipeable row on phones)
 *   newest    just published, with artwork
 *   record    what the archive holds, by format and by event type
 *
 * The time frame starts at all time on every visit and is not remembered.
 * Trend and insight cards need /api/insights (static snapshot only).
 */
import { every, get, isStatic } from '../api.js';
import { hbars, monthlyBars } from '../charts.js';
import {
  DEFAULT_WINDOW, buyerRows, change, changeClass, creatorRows, listPeriod, pct, releaseRows, windowName
} from '../insights-ui.js';
import { registerTracks } from '../player.js';
import {
  compact, esc, gridSkeleton, kindPlural, menuButton, num, plural, releaseGrid, searchIcon, segmented, tween
} from '../ui.js';

/** Time frames offered on the overview: each maps to an insights window and a ranking period. */
const FRAMES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['365d', 'Last 12 months'], ['all', 'All time']];
/** Trend measures: [key in insights.monthly, switch label, chart label, tooltip formatter]. */
const MEASURES = [
  ['sats', 'Sats', 'Sats paid to creators', (v) => `${num(v)} sats`],
  ['sales', 'Purchases', 'Purchases', (v) => plural(v, 'purchase')],
  ['newBuyers', 'Buyers', 'New buyers', (v) => plural(v, 'new buyer')],
  ['releases', 'Events', 'Events published', (v) => plural(v, 'event')]
];
const BOARDS = [['events', 'Events'], ['creators', 'Creators'], ['supporters', 'Supporters']];
const TOP_N = 5;

const skeleton = (h) => `<div class="skeleton" style="height:${h}px"></div>`;
const chartIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 13.5h11M4.5 11V7.5M8 11V3.5M11.5 11V6"/></svg>';

/** Renders the overview into `main`. */
export async function renderHome(main) {
  main.innerHTML = `
    <section class="home-hero">
      <div class="hero">
        <h1>Everything that happens <span class="accent">on Fanfares.</span></h1>
        <p class="lede">Every event, creator and sale on Fanfares, read from Nostr. Every sat here went straight to the people who made the work.</p>
        <div class="hero-actions">
          <a class="search-cta" href="#/search">${searchIcon}<span>Search events, creators, npubs…</span><kbd>/</kbd></a>
          <a class="btn ghost" href="#/insights">${chartIcon}<span>Insights</span></a>
        </div>
      </div>
      <div class="hero-card" id="headline">
        <div class="hc-head"><span class="eyebrow">Paid directly to creators</span><div id="frame-a"></div></div>
        <div class="big"><span class="btc-num" id="hc-sats">—</span><small>sats</small></div>
        <div class="hc-sub" id="hc-sub">${skeleton(18)}</div>
        <div class="hero-facts" id="hc-facts">${skeleton(40)}</div>
      </div>
    </section>

    <section class="section" id="top">
      <div class="section-head top-head"><h2 id="top-title">Top on Fanfares</h2>
        <div class="top-tools"><div class="top-sort" id="top-sort"></div><div class="top-frame" id="frame-b"></div></div>
        <div class="board-tabs" id="board-tabs"></div></div>
      <div class="boards" id="boards" data-show="events">
        <div class="board" data-board="events"><h3 class="board-title"><span id="t-events">Top-earning events</span><a class="more" id="more-releases">View all</a></h3><div class="rows" id="top-releases">${skeleton(250)}</div></div>
        <div class="board" data-board="creators"><h3 class="board-title"><span>Top creators</span><a class="more" id="more-creators">View all</a></h3><div class="rows" id="top-creators">${skeleton(250)}</div></div>
        <div class="board" data-board="supporters"><h3 class="board-title"><span>Top supporters</span><a class="more" id="more-supporters">View all</a></h3><div class="rows" id="top-buyers">${skeleton(250)}</div></div>
      </div>
    </section>

    <section class="section" id="trend">
      <div class="section-head wrap"><h2>Month by month</h2><div id="trend-measure"></div></div>
      <div class="panel trend-panel"><div id="trend-chart">${skeleton(200)}</div>
        <div class="trend-foot"><span>Every month on record.</span><a class="more" href="#/insights">All insights →</a></div></div>
    </section>

    <section class="section" id="inside">
      <div class="section-head"><h2>Inside the numbers</h2><a class="more" href="#/insights">All insights</a></div>
      <div class="ins-cards" id="inside-cards">${Array.from({ length: 4 }, () => `<div class="panel">${skeleton(150)}</div>`).join('')}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Just published</h2><a class="more" href="#/events">View all</a></div>
      <div id="newest" class="shelf">${gridSkeleton(6)}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>On the record</h2><a class="more" href="#/live">Live view</a></div>
      <div class="record" id="record">${skeleton(120)}</div>
    </section>`;

  const $ = (sel) => main.querySelector(sel);
  const staticSite = await isStatic();
  const state = { frame: DEFAULT_WINDOW, by: 'sats', board: 'events', measure: 'sats', ins: null, ov: null };
  let seq = 0;

  // ---- one time frame for the whole page, offered at the top and again above the rankings
  const frames = [];
  const setFrame = (f) => {
    state.frame = f;
    frames.forEach((m) => m.set(f));
    refresh();
  };
  frames.push(menuButton($('#frame-a'), FRAMES, state.frame, setFrame, { label: 'Time frame' }));
  frames.push(menuButton($('#frame-b'), FRAMES, state.frame, setFrame, { label: 'Time frame' }));
  segmented($('#top-sort'), [['sats', 'Sats'], ['sales', 'Purchases']], state.by, (v) => { state.by = v; paintTop(); }, 'Rank by');
  segmented($('#board-tabs'), BOARDS, state.board, (v) => { state.board = v; $('#boards').dataset.show = v; }, 'Ranking');

  // ---- hero card
  const paintHero = () => {
    const d = state.ins;
    const ov = state.ov;
    const all = state.frame === 'all' || !d;
    const c = d?.current;
    const sats = all && !c ? ov?.salesSats : c?.sats;
    if (sats == null) return;
    tween($('#hc-sats'), sats);
    const sales = c ? c.sales : ov.sales;
    const buyers = c ? c.buyers : ov.buyers;
    const delta = d && !all ? change(c.sats, d.previous?.sats, d) : '';
    $('#hc-sub').innerHTML = `<b>${num(sales)}</b> ${sales === 1 ? 'purchase' : 'purchases'} · <b>${num(buyers)}</b> ${buyers === 1 ? 'supporter' : 'supporters'}${delta
      ? ` <span class="chg ${changeClass(delta)}" title="Sats paid, compared with the period before">${esc(delta)}</span>` : ''}`;
    const facts = all
      ? [[ov?.releases, 'events'], [ov?.creators, 'creators'], [ov?.verifiedSales, 'verified sales']]
      : [[c.releases, 'new events'], [c.creatorsPaid, 'creators paid'], [c.newBuyers, 'new supporters']];
    $('#hc-facts').innerHTML = facts.map(([v, l]) => `<div><b>${v == null ? '—' : num(v)}</b><span>${esc(l)}</span></div>`).join('');
  };

  // ---- rankings, from the list endpoints so they can be ordered by sats or purchases
  let top = null;
  const loadTop = async () => {
    const period = listPeriod(state.frame);
    ['#top-releases', '#top-creators', '#top-buyers'].forEach((id) => $(id).classList.add('loading'));
    const [events, creators, supporters] = await Promise.all([
      Promise.all([
        get('/api/releases', { sort: 'earned', period, limit: TOP_N }),
        get('/api/releases', { sort: 'sales', period, limit: TOP_N })
      ]),
      Promise.all([get('/api/creators', { period, limit: TOP_N }), get('/api/creators', { sort: 'sales', period, limit: TOP_N })]),
      every('/api/supporters', { period })
    ]);
    return {
      events: { sats: events[0].items.filter((r) => r.stats.earnedSats > 0), sales: events[1].items.filter((r) => r.stats.sales > 0) },
      creators: { sats: creators[0].items.filter((c) => c.earnedSats > 0), sales: creators[1].items.filter((c) => c.sales > 0) },
      supporters: {
        sats: supporters.slice(0, TOP_N),
        sales: [...supporters].sort((a, b) => b.purchases - a.purchases || b.spentSats - a.spentSats).slice(0, TOP_N)
      }
    };
  };
  const paintTop = () => {
    if (!top) return;
    const by = state.by;
    $('#t-events').textContent = by === 'sales' ? 'Most purchased events' : 'Top-earning events';
    $('#top-releases').innerHTML = releaseRows(top.events[by], TOP_N, by);
    $('#top-creators').innerHTML = creatorRows(top.creators[by], TOP_N, by);
    $('#top-buyers').innerHTML = buyerRows(top.supporters[by], TOP_N, by);
    ['#top-releases', '#top-creators', '#top-buyers'].forEach((id) => $(id).classList.remove('loading'));
    const lp = listPeriod(state.frame);
    $('#more-releases').href = `#/events?sort=${by === 'sales' ? 'sales' : 'earned'}${lp ? `&period=${lp}` : ''}`;
    $('#more-creators').href = `#/creators${by === 'sales' ? '?sort=sales' : ''}${lp ? `${by === 'sales' ? '&' : '?'}period=${lp}` : ''}`;
    $('#more-supporters').href = `#/supporters${lp ? `?period=${lp}` : ''}`;
  };

  // ---- trend chart (all history; the same for every time frame)
  const chartHost = $('#trend-chart');
  const drawChart = () => {
    if (!state.ins) return;
    const [key, , label, format] = MEASURES.find(([k]) => k === state.measure);
    monthlyBars(chartHost, state.ins.monthly.map((m) => ({ month: m.month, value: m[key] })), { format, label });
  };
  let lastWidth = chartHost.clientWidth;
  const observer = new ResizeObserver(() => {
    if (!chartHost.isConnected) { observer.disconnect(); return; }
    if (Math.abs(chartHost.clientWidth - lastWidth) > 8) { lastWidth = chartHost.clientWidth; drawChart(); }
  });
  observer.observe(chartHost);
  segmented($('#trend-measure'), MEASURES.map(([k, l]) => [k, l]), state.measure, (v) => { state.measure = v; drawChart(); }, 'Measure');

  if (!staticSite) { $('#trend').remove(); $('#inside').remove(); }

  /** Re-scopes everything that depends on the time frame. */
  async function refresh() {
    const mine = ++seq;
    const name = windowName(state.frame);
    $('#headline').classList.add('busy');
    const [ins, t] = await Promise.all([
      staticSite ? get('/api/insights', { period: state.frame }).catch(() => null) : null,
      loadTop()
    ]);
    if (mine !== seq || !chartHost.isConnected) return;
    $('#headline').classList.remove('busy');
    const first = !state.ins;
    state.ins = ins;
    top = t;
    paintHero();
    paintTop();
    if (ins) {
      if (first) drawChart();
      $('#inside-cards').innerHTML = insideCards(ins, name);
    }
  }

  const [ov] = await Promise.all([get('/api/overview'), refresh()]);
  if (!$('#record')) return;
  state.ov = ov;
  paintHero();

  const newest = await get('/api/releases', { sort: 'newest', limit: 6 });
  if (!$('#newest')) return;
  registerTracks(newest.items);
  $('#newest').innerHTML = releaseGrid(newest.items);
  const a = ov.archive;
  const tile = (n, label, href) => `<${href ? `a href="${href}"` : 'div'} class="rec-tile"><b>${compact(n)}</b><span>${esc(label)}</span></${href ? 'a' : 'div'}>`;
  $('#record').innerHTML = `
    <div class="rec-group"><div class="rec-label">Published, by format</div><div class="rec-tiles">
      ${ov.byKind.filter((k) => k.count).map((k) => tile(k.count, kindPlural(k.kind), `#/events?kind=${k.kind}`)).join('')}</div></div>
    <div class="rec-group"><div class="rec-label">Signed Nostr events in the archive · ${num(a.events)}</div><div class="rec-tiles">
      ${tile(ov.payments, 'Payments')}${tile(a.profiles, 'Profiles')}${tile(a.reactions, 'Reactions')}${tile(a.comments, 'Comments')}${tile(a.wallets, 'Ecash wallets')}</div></div>`;
}

/** Four insight cards for one window: a headline figure, a sentence and a small breakdown. */
function insideCards(d, name) {
  const c = d.current;
  const card = (title, big, sentence, body) => `<a class="panel insight-card" href="#/insights">
    <h3>${esc(title)}</h3><div class="big-num">${big}</div><div class="panel-sub">${esc(sentence)}</div>${body}</a>`;
  if (!c.sales) return `<div class="empty">No purchases in the ${esc(name)} yet. Try a longer time frame.</div>`;

  const bands = d.priceBands.filter((b) => b.releases);
  const topBand = bands.reduce((a, b) => (b.sats > a.sats ? b : a), bands[0]);
  const mostSold = bands.reduce((a, b) => (b.sales > a.sales ? b : a), bands[0]);
  const lightning = d.rails.find((r) => r.rail === 'lightning');
  const legs = d.rails.reduce((n, r) => n + r.payments, 0);
  const topKind = [...d.kinds].sort((a, b) => b.sats - a.sats)[0];

  return [
    card('Price points that sell', `${pct(topBand.sats / c.sats)}`,
      `of sats came from events priced ${topBand.label} sats; most purchases were at ${mostSold.label}.`,
      hbars(bands.map((b) => ({ label: b.label, count: b.sats })), { format: compact })),
    card('What earns', pct(topKind.sats / c.sats),
      `of sats went to ${kindPlural(topKind.kind).toLowerCase()}, across ${plural(c.creatorsPaid, 'creator')} paid.`,
      hbars(d.kinds.filter((k) => k.releases).map((k) => ({ label: kindPlural(k.kind), count: k.sats })), { format: compact })),
    card('Buyer loyalty', pct(c.buyers ? d.repeatBuyers / c.buyers : 0),
      `of ${plural(c.buyers, 'buyer')} bought more than once${name === 'all time' ? '' : ` in the ${name}`}.`,
      hbars(d.repeat.map((b) => ({ label: b.label, count: b.buyers })))),
    card('How people pay', pct(legs ? lightning.payments / legs : 0),
      `of ${plural(legs, 'payment')} were lightning zaps; the rest were cashu nutzaps.`,
      hbars(d.rails.map((r) => ({ label: r.label, count: r.payments }))))
  ].join('');
}
