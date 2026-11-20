/**
 * Home-page leaderboards: best-selling events, highest-earning creators and
 * biggest supporters, switchable between Today, This week, This month and
 * All time. Each board links to its full ranking for the same period.
 */
import { get } from '../api.js';
import { PERIODS, avatar, displayName, esc, num, personHref, plural, releaseHref, sats } from '../ui.js';

const SIZE = 5;
const DEFAULT_PERIOD = 'week';

/** One ranked row; `href`, `title`, `sub` and `right` are already escaped HTML. */
const row = (i, pic, href, title, sub, right) => `<a class="row" href="${href}"><span class="rank">${i + 1}</span>${pic}
  <div class="grow"><div class="title">${title}</div><div class="sub">${sub}</div></div><div class="right">${right}</div></a>`;

/** A board's rows, or an honest empty state for a quiet period. */
const rows = (items, render) => (items.length ? items.map(render).join('') : '<div class="empty">Nothing yet in this period.</div>');

/**
 * Renders the leaderboards section into `host` and wires the period chips.
 * @param {HTMLElement} host Container on the home page.
 */
export async function renderLeaderboards(host) {
  host.innerHTML = `
    <div class="section-head"><h2>Leaderboards</h2>
      <div class="chips" role="group" aria-label="Ranking period">${PERIODS.map(([v, l]) =>
        `<button class="chip" data-period="${v}" aria-pressed="${v === DEFAULT_PERIOD}">${l}</button>`).join('')}</div></div>
    <div class="boards">
      <div><h3 class="board-title">Best sellers <a class="more" id="lb-more-sales">View all</a></h3><div class="rows" id="lb-sales"></div></div>
      <div><h3 class="board-title">Highest earners <a class="more" id="lb-more-earners">View all</a></h3><div class="rows" id="lb-earners"></div></div>
      <div><h3 class="board-title">Top supporters <a class="more" id="lb-more-supporters">View all</a></h3><div class="rows" id="lb-supporters"></div></div>
    </div>`;
  let seq = 0;
  const load = async (period) => {
    const mine = ++seq;
    const q = period ? `&period=${period}` : '';
    host.querySelector('#lb-more-sales').href = `#/events?sort=sales${q}`;
    host.querySelector('#lb-more-earners').href = `#/creators${period ? `?period=${period}` : ''}`;
    host.querySelector('#lb-more-supporters').href = `#/supporters${period ? `?period=${period}` : ''}`;
    for (const id of ['#lb-sales', '#lb-earners', '#lb-supporters']) host.querySelector(id).innerHTML = '<div class="skeleton" style="height:260px"></div>';
    const [sales, earners, supporters] = await Promise.all([
      get('/api/releases', { sort: 'sales', period, limit: SIZE }),
      get('/api/creators', { period, limit: SIZE }),
      get('/api/supporters', { period, limit: SIZE })
    ]);
    if (mine !== seq) return;
    host.querySelector('#lb-sales').innerHTML = rows(sales.items, (r, i) => row(i, avatar(r.author, 40), releaseHref(r.address),
      esc(r.title), esc(displayName(r.author)), plural(r.stats.sales, 'sale')));
    host.querySelector('#lb-earners').innerHTML = rows(earners.items, (c, i) => row(i, avatar(c, 40), personHref(c.pubkey),
      esc(displayName(c)), `${plural(c.sales, 'sale')} · ${plural(c.buyers, 'supporter')}`, sats(c.earnedSats)));
    host.querySelector('#lb-supporters').innerHTML = rows(supporters.items, (s, i) => row(i, avatar(s, 40), personHref(s.pubkey),
      esc(displayName(s)), `${plural(s.purchases, 'purchase')} · ${plural(s.creators, 'creator')}`, sats(s.spentSats)));
  };
  host.querySelectorAll('[data-period]').forEach((chip) => chip.addEventListener('click', () => {
    host.querySelectorAll('[data-period]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    load(chip.dataset.period);
  }));
  await load(DEFAULT_PERIOD);
}
