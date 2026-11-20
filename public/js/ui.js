/**
 * Shared rendering helpers: escaping, number/time formatting, and the small
 * components (avatar, release card, rows) every view composes.
 */
import { shortNpub } from './nostr.js';

/** HTML-escapes untrusted text from Nostr events. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Only http(s) URLs may reach src/href attributes. */
export function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? esc(url) : '';
}

const nf = new Intl.NumberFormat('en-US');
/** 1234567 → "1,234,567". */
export const num = (n) => nf.format(Math.round(n || 0));

/** Compact figures for hero stats: 937816 → "938K". */
export function compact(n) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n >= 1e6 ? 2 : 1 }).format(n || 0);
}

/** Sats value with the lightning glyph styling. */
export const sats = (n) => `<span class="sats">${num(n)}</span>`;

/** Short sats for dense layouts: 620000 → "620K", full value on hover. */
export const satsShort = (n) => `<span class="sats" title="${num(n)} sats">${n >= 10000 ? compact(n) : num(n)}</span>`;

/**
 * Display names for content kinds. Fanfares calls kind 31337 audio "Music";
 * the archive's older labels ("Track") are mapped here so every view agrees.
 */
const KIND_NAMES = { 1: 'Note', 30023: 'Article', 31337: 'Music', 31338: 'Podcast', 31339: 'Audiobook', 36787: 'Music' };
export const kindName = (kind, fallback = '') => KIND_NAMES[kind] || fallback || `Kind ${kind}`;
/** Plural display name: "Podcasts", "Music". */
export const kindPlural = (kind) => { const n = kindName(kind); return n === 'Music' ? n : `${n}s`; };

/** "3 days ago" style relative time for unix seconds. */
export function ago(ts) {
  if (!ts) return 'date unknown';
  const s = Math.floor(Date.now() / 1000) - ts;
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) {
    if (s >= secs) { const v = Math.floor(s / secs); return `${v} ${name}${v > 1 ? 's' : ''} ago`; }
  }
  return 'just now';
}

/** Compact relative time for table cells: "5m", "3h", "2d", "11mo", "1y". */
export function agoShort(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  const units = [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [secs, u] of units) if (s >= secs) return `${Math.floor(s / secs)}${u}`;
  return 'now';
}

/** Table cell for a timestamp: compact text, full date on hover. */
export const whenCell = (ts) => `<td class="r muted num nowrap" title="${ts ? new Date(ts * 1000).toLocaleString('en-US') : ''}">${agoShort(ts)}</td>`;

/** "Mar 4, 2026". */
export function date(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

/** "1h 07m" / "5m". */
export function duration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${Math.max(1, m)} min`;
}

/** "1 event" / "3 events". */
export const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

/** Display name, falling back to a short npub for people without profiles. */
export const displayName = (p) => p?.name?.trim() || shortNpub(p?.pubkey) || 'Unknown';

/** Round avatar with a lettered fallback when the profile has no picture. */
export function avatar(p, size = 36) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  const src = safeUrl(p?.picture);
  const letter = esc((displayName(p)[0] || '?').toUpperCase());
  const fallback = `<span class="avatar fallback" style="${style}" aria-hidden="true">${letter}</span>`;
  if (!src) return fallback;
  return `<img class="avatar" src="${src}" alt="" style="${style}" loading="lazy" decoding="async" referrerpolicy="no-referrer"
    onerror="this.outerHTML=this.dataset.fb" data-fb="${esc(fallback)}">`;
}

/** Cover art, or a typographic cover for notes/articles without an image. */
export function cover(r, { eager = false, large = false } = {}) {
  const src = safeUrl(r.cover);
  // Releases without artwork get a quiet typographic cover; the title only
  // appears inside it on the detail page, where it is not repeated below.
  const excerpt = (r.summary || '').replace(r.title, '').replace(/https?:\/\/\S+/g, '').trim();
  const body = large ? `<div class="tc-title">${esc(r.title)}</div>`
    : excerpt ? `<div class="tc-excerpt">${esc(excerpt.slice(0, 220))}</div>` : '<div class="tc-mark" aria-hidden="true">“</div>';
  const text = `<div class="text-cover"><div class="tc-kind">${esc(kindName(r.kind, r.kindLabel))}</div>${body}</div>`;
  if (!src) return text;
  return `<img src="${src}" alt="" loading="${eager ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer"
    onerror="this.outerHTML=this.dataset.fb" data-fb="${esc(text)}">`;
}

/** Path segment for a published event's detail page. */
export const releaseHref = (address) => `#/event/${encodeURIComponent(address)}`;
export const personHref = (pubkey) => `#/p/${pubkey}`;

const playIcon = '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.8v10.4L12 7z" fill="currentColor"/></svg>';

/** Event card for grids: cover, kind badge, title, creator, price, sales. */
export function releaseCard(r) {
  const play = r.previewUrl
    ? `<button class="play" data-play="${esc(r.address)}" aria-label="Play preview of ${esc(r.title)}">${playIcon}</button>` : '';
  const sales = r.stats?.sales ? `${num(r.stats.sales)} sold` : '';
  const kind = `${r.isTest ? 'Test · ' : ''}${esc(kindName(r.kind, r.kindLabel))}${r.durationSec ? ` · ${duration(r.durationSec)}` : ''}`;
  return `<article class="release-card">
    <div class="cover-wrap">
      <a class="cover" href="${releaseHref(r.address)}" aria-label="${esc(r.title)}" tabindex="-1">${cover(r)}</a>
      ${play}
    </div>
    <div class="kind">${kind}</div>
    <a href="${releaseHref(r.address)}"><h3>${esc(r.title)}</h3></a>
    <a class="byline" href="${personHref(r.author.pubkey)}">${esc(displayName(r.author))}</a>
    <div class="foot">${r.priceSats ? sats(r.priceSats) : '<span>Free</span>'}<span>${sales}</span></div>
  </article>`;
}

/** Event grid, or an empty state. */
export function releaseGrid(items, empty = 'No events found.') {
  if (!items.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="release-grid">${items.map(releaseCard).join('')}</div>`;
}

/** Skeleton placeholders while a grid loads. */
export function gridSkeleton(n = 8) {
  return `<div class="release-grid">${Array.from({ length: n }, () => '<div><div class="skeleton" style="aspect-ratio:1"></div><div class="skeleton" style="height:12px;margin-top:14px;width:40%"></div><div class="skeleton" style="height:14px;margin-top:8px;width:85%"></div></div>').join('')}</div>`;
}

/** Copies text and shows a short toast. */
export function copy(text, label = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast(label), () => toast('Copy failed'));
}

let toastTimer;
/** Brief confirmation message at the top of the page. */
export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 1800);
}

/** Ranking periods for every leaderboard: [API value, label]. Rolling windows; '' is all time. */
export const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['', 'All time']];

/** Short labels for the ranking periods, used in segmented switches. */
export const PERIODS_SHORT = [['today', '24h'], ['week', '7d'], ['month', '30d'], ['year', '12m'], ['', 'All']];

/**
 * Segmented switch with a sliding thumb. Renders into `host` and calls
 * `onChange(value)` when the viewer picks another option.
 * @param {HTMLElement} host
 * @param {[string, string][]} options [value, label] pairs.
 * @param {string} current Selected value.
 * @param {(value: string) => void} onChange
 * @param {string} [label] Accessible group name.
 */
export function segmented(host, options, current, onChange, label = 'Options') {
  host.innerHTML = `<div class="seg" role="radiogroup" aria-label="${esc(label)}"><span class="seg-thumb" aria-hidden="true"></span>${options.map(([v, l]) =>
    `<button type="button" role="radio" data-v="${esc(v)}" aria-checked="${v === current}">${esc(l)}</button>`).join('')}</div>`;
  const seg = host.firstElementChild;
  const thumb = seg.querySelector('.seg-thumb');
  const place = (animate) => {
    const on = seg.querySelector('[aria-checked="true"]');
    if (!on) return;
    thumb.style.transition = animate ? '' : 'none';
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  };
  requestAnimationFrame(() => place(false));
  new ResizeObserver(() => place(false)).observe(seg);
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.getAttribute('aria-checked') === 'true') return;
    seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    place(true);
    onChange(b.dataset.v);
  });
  return seg;
}

/**
 * Animates the number inside `el` from what it showed last to `to`, so
 * switching a period visibly updates the figures.
 * @param {HTMLElement} el
 * @param {number} to
 * @param {(n: number) => string} format Returns HTML.
 */
export function tween(el, to, format = num) {
  if (!el) return;
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.innerHTML = format(to); return; }
  const start = performance.now();
  const dur = 520;
  const step = (t) => {
    const k = Math.min(1, (t - start) / dur);
    const e = 1 - (1 - k) ** 3;
    el.innerHTML = format(from + (to - from) * e);
    if (k < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Search glyph shared by search fields. */
export const searchIcon = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
