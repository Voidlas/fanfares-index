/**
 * Polls /api/sync to drive the header status dot and let the Live page
 * follow crawl progress (every 5s while a sync runs, every 30s otherwise,
 * every 5 min on the static site, which has no live crawl).
 *
 * The dot is green when the index is fresh, amber while syncing or when a
 * scheduled rebuild is overdue. A short age ("3m") shows only while the
 * update is recent; clicking opens the details.
 */
import { get } from './api.js';
import { liveStatus } from './live-relays.js';
import { ago, esc, num } from './ui.js';

const listeners = new Set();
let lastSyncAt = null;
let wasRunning = false;
let info = null;

/** Subscribes to crawl events; returns an unsubscribe function. */
export function onSyncEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Minutes since the last crawl, or null. */
const ageMin = () => (lastSyncAt ? Math.max(0, Math.floor((Date.now() / 1000 - lastSyncAt) / 60)) : null);

/** Paints the header dot. */
function paint(running) {
  const pill = document.getElementById('sync-pill');
  const age = ageMin();
  const overdue = info && age != null && age > (info.intervalMin || 60) * 1.5;
  pill.classList.toggle('running', running);
  pill.classList.toggle('ok', !running && age != null && !overdue);
  pill.classList.toggle('stale', !running && overdue);
  pill.querySelector('.sync-text').textContent = running ? 'Syncing' : age != null && age < 10 ? (age < 1 ? 'now' : `${age}m`) : '';
  pill.title = running ? 'Syncing relays…' : lastSyncAt ? `Updated ${ago(lastSyncAt)}` : 'Not synced yet';
  if (!document.getElementById('sync-pop').hidden) fillPop();
}

/** Details panel under the dot. */
function fillPop() {
  const pop = document.getElementById('sync-pop');
  const age = ageMin();
  const every = info?.intervalMin || 60;
  const next = age == null ? null : Math.max(0, every - age);
  const live = liveStatus();
  const row = (k, v) => `<div class="sp-kv"><span>${k}</span><b>${v}</b></div>`;
  pop.innerHTML = `
    <div class="sp-title ${age != null && age > every * 1.5 ? 'stale' : 'ok'}"><span class="dot"></span>${age == null ? 'Not synced yet' : age > every * 1.5 ? 'Update overdue' : 'Index is up to date'}</div>
    ${row('Last updated', lastSyncAt ? esc(ago(lastSyncAt)) : '—')}
    ${row('Next update', next == null ? '—' : next ? `in about ${next} min` : 'any moment')}
    ${row('Schedule', `every ${every} min`)}
    ${info?.roles ? row('Signed events', num(info.roles.reduce((n, r) => n + r.n, 0))) : ''}
    ${row('Live relays', live.since ? `${live.connected} of ${live.relays.length} connected` : 'opens on the Live page')}
    <a class="sp-link" href="#/live">Open live view →</a>`;
}

/** Wires the dot to open and close its panel. */
function wire() {
  const pill = document.getElementById('sync-pill');
  const pop = document.getElementById('sync-pop');
  const close = () => { pop.hidden = true; pill.setAttribute('aria-expanded', 'false'); };
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pop.hidden) { close(); return; }
    fillPop();
    pop.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('hashchange', close);
}

/** Starts polling and keeps the dot current. Called once at startup. */
export async function initSyncStatus() {
  wire();
  setInterval(() => paint(wasRunning), 60000);
  const poll = async () => {
    let s;
    try { s = await get('/api/sync'); } catch { setTimeout(poll, 30000); return; }
    lastSyncAt = s.lastSyncAt;
    info = s;
    paint(s.running);
    const events = s.running ? [{ type: 'start' }, { type: 'running', backlog: s.log }] : wasRunning ? [{ type: 'idle' }] : [];
    for (const e of events) for (const fn of listeners) fn(e);
    wasRunning = s.running;
    // A static snapshot changes only when CI rebuilds it, so check rarely.
    setTimeout(poll, s.running ? 5000 : s.manual === false ? 300000 : 30000);
  };
  await poll();
}
