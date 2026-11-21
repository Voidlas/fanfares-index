/**
 * Shared pieces for views built on /api/insights (the overview and the
 * Insights page): the rolling-window switch, "vs previous period" text and
 * the ranked lists of events, creators and supporters.
 *
 * Every page opens on all time; a picked window applies to that page only
 * and is forgotten when the viewer navigates away.
 */
import { avatar, cover, displayName, esc, num, personHref, plural, releaseHref, satsShort, segmented } from './ui.js';

/** Rolling windows published by the snapshot (snapshot/insights.mjs), in display order. */
export const WINDOWS = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '12 months'], ['all', 'All time']];
export const DEFAULT_WINDOW = 'all';

/** Ranking-page period closest to a window, for "View all" links ('' = all time). */
export const listPeriod = (w) => ({ '7d': 'week', '30d': 'month', '365d': 'year' })[w] || '';

/** "last 30 days", "last 12 months" or "all time". */
export function windowName(w) {
  const label = WINDOWS.find(([k]) => k === w)?.[1] || '';
  return w === 'all' ? 'all time' : `last ${label}`;
}

/** Month and year of a unix time: "April 2025". */
export const monthYear = (ts) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Change against the previous window, short: "↑ 20%", "↓ 8%", "no change".
 * @param {number} now This window's value.
 * @param {number|null|undefined} before The previous window's value; null for all time.
 * @param {object} d The insights answer (for `since` on all time).
 */
export function change(now, before, d) {
  if (before == null) return `since ${monthYear(d.since)}`;
  if (!before) return now ? 'new this period' : 'none yet';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return 'no change';
  return `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}%`;
}

/** CSS modifier for a change string. */
export const changeClass = (s) => (s.startsWith('↑') ? 'up' : s.startsWith('↓') ? 'down' : '');

/**
 * Window switch; calls `onChange(window)` after the viewer picks one.
 * @param {HTMLElement} host Element to render the chips into.
 * @param {string} current Selected window.
 * @param {(w: string) => void} onChange
 */
export function windowSwitch(host, current, onChange) {
  segmented(host, WINDOWS.map(([k, l]) => [k, k === 'all' ? 'All' : k === '365d' ? '12m' : k]), current, onChange, 'Time period');
}

/**
 * One ranked row; the arguments are already escaped HTML.
 * `value` is the bold figure on the right, `unit` a small label under it.
 */
export const rankRow = ({ i, pic, href, title, sub, value, unit = '' }) => `<a class="row" href="${href}"><span class="rank">${i + 1}</span>${pic}
  <div class="grow"><div class="title">${title}</div><div class="sub">${sub}</div></div>
  <div class="right"><span class="rv">${value}</span>${unit ? `<span class="ru">${unit}</span>` : ''}</div></a>`;

const list = (items, render, n) => (items.length ? items.slice(0, n).map(render).join('') : '<div class="empty sm">A quiet stretch so far. Try a longer time frame.</div>');

/** Small square artwork for event rows. */
export const thumb = (r) => `<span class="thumb">${cover(r)}</span>`;

/**
 * Event rows. `by` is 'sats' (earned) or 'sales' (purchases); items carry
 * either insights fields (sats, sales) or list fields (stats.earnedSats, stats.sales).
 */
export const releaseRows = (items, n = 8, by = 'sats') => list(items, (x, i) => {
  const sales = x.stats?.sales ?? x.sales;
  const earned = x.stats?.earnedSats ?? x.sats;
  return rankRow({
    i, pic: thumb(x), href: releaseHref(x.address), title: esc(x.title),
    sub: by === 'sales' ? `${esc(displayName(x.author))} · ${satsShort(earned)}` : `${esc(displayName(x.author))} · ${plural(sales, 'sale')}`,
    value: by === 'sales' ? num(sales) : satsShort(earned), unit: by === 'sales' ? (sales === 1 ? 'purchase' : 'purchases') : 'sats'
  });
}, n);

/** Creator rows (insights `sats` or list `earnedSats`). */
export const creatorRows = (items, n = 8, by = 'sats') => list(items, (x, i) => {
  const earned = x.earnedSats ?? x.sats;
  return rankRow({
    i, pic: avatar(x, 40), href: personHref(x.pubkey), title: esc(displayName(x)),
    sub: by === 'sales' ? `${satsShort(earned)} · ${plural(x.buyers, 'supporter')}` : `${plural(x.sales, 'sale')} · ${plural(x.buyers, 'supporter')}`,
    value: by === 'sales' ? num(x.sales) : satsShort(earned), unit: by === 'sales' ? (x.sales === 1 ? 'sale' : 'sales') : 'sats'
  });
}, n);

/** Supporter rows (insights `sats` or list `spentSats`). */
export const buyerRows = (items, n = 8, by = 'sats') => list(items, (x, i) => {
  const spent = x.spentSats ?? x.sats;
  return rankRow({
    i, pic: avatar(x, 40), href: personHref(x.pubkey), title: esc(displayName(x)),
    sub: by === 'sales' ? `${satsShort(spent)} · ${plural(x.creators, 'creator')}` : `${plural(x.purchases, 'purchase')} · ${plural(x.creators, 'creator')}`,
    value: by === 'sales' ? num(x.purchases) : satsShort(spent), unit: by === 'sales' ? (x.purchases === 1 ? 'purchase' : 'purchases') : 'sats'
  });
}, n);

/** Whole-number percentage of a 0–1 share. */
export const pct = (x) => `${Math.round((x || 0) * 100)}%`;
