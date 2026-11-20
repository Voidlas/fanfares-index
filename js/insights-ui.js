/**
 * Shared pieces for views built on /api/insights (the overview and the
 * Insights page): the rolling-window switch, "vs previous period" text and
 * the ranked lists of releases, creators and supporters.
 */
import { avatar, displayName, esc, personHref, plural, releaseHref, sats } from './ui.js';

/** Rolling windows published by the snapshot (snapshot/insights.mjs), in display order. */
export const WINDOWS = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '12 months'], ['all', 'All time']];
const DEFAULT = '30d';
const KEY = 'fanfares.insightPeriod';
const valid = (v) => WINDOWS.some(([k]) => k === v);

/** The window this viewer picked last (a per-browser convenience), or 30 days. */
export function savedWindow() {
  try { const v = localStorage.getItem(KEY); return valid(v) ? v : DEFAULT; } catch { return DEFAULT; }
}

/** Remembers the picked window; silently skipped where storage is unavailable. */
function saveWindow(v) {
  try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
}

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
 * Change against the previous window, in neutral words (growth is context, not a status).
 * @param {number} now This window's value.
 * @param {number|null|undefined} before The previous window's value; null for all time.
 * @param {object} d The insights answer (for `since` on all time).
 */
export function change(now, before, d) {
  if (before == null) return `since ${monthYear(d.since)}`;
  if (!before) return now ? 'none in the period before' : 'none in the period before either';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return 'same as the period before';
  return `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs the period before`;
}

/**
 * Window switch; calls `onChange(window)` after the viewer picks one.
 * @param {HTMLElement} host Element to render the chips into.
 * @param {string} current Selected window.
 * @param {(w: string) => void} onChange
 */
export function windowSwitch(host, current, onChange) {
  host.innerHTML = `<div class="chips" role="group" aria-label="Time period">${WINDOWS.map(([k, l]) =>
    `<button class="chip" data-window="${k}" aria-pressed="${k === current}">${l}</button>`).join('')}</div>`;
  host.querySelectorAll('[data-window]').forEach((chip) => chip.addEventListener('click', () => {
    if (chip.getAttribute('aria-pressed') === 'true') return;
    host.querySelectorAll('[data-window]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    saveWindow(chip.dataset.window);
    onChange(chip.dataset.window);
  }));
}

/** One ranked row; the arguments are already escaped HTML. */
const row = (i, pic, href, title, sub, right) => `<a class="row" href="${href}"><span class="rank">${i + 1}</span>${pic}
  <div class="grow"><div class="title">${title}</div><div class="sub">${sub}</div></div><div class="right">${right}</div></a>`;
const list = (items, render, n) => (items.length ? items.slice(0, n).map(render).join('') : '<div class="empty">Nothing yet in this period.</div>');

/** Top releases of a window, by sats earned. */
export const releaseRows = (items, n = 8) => list(items, (x, i) => row(i, avatar(x.author, 40), releaseHref(x.address), esc(x.title),
  `${esc(displayName(x.author))} · ${plural(x.sales, 'sale')}`, sats(x.sats)), n);

/** Top-earning creators of a window. */
export const creatorRows = (items, n = 8) => list(items, (x, i) => row(i, avatar(x, 40), personHref(x.pubkey), esc(displayName(x)),
  `${plural(x.sales, 'sale')} · ${plural(x.buyers, 'buyer')}`, sats(x.sats)), n);

/** Biggest supporters of a window. */
export const buyerRows = (items, n = 8) => list(items, (x, i) => row(i, avatar(x, 40), personHref(x.pubkey), esc(displayName(x)),
  `${plural(x.purchases, 'purchase')} · ${plural(x.creators, 'creator')}`, sats(x.sats)), n);

/** Whole-number percentage of a 0–1 share. */
export const pct = (x) => `${Math.round((x || 0) * 100)}%`;
