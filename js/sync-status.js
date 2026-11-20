/**
 * Polls /api/sync to drive the header status pill and let the Live page
 * follow crawl progress (every 5s while a sync runs, every 30s otherwise,
 * every 5 min on the static site, which has no live crawl).
 */
import { get } from './api.js';
import { ago } from './ui.js';

const listeners = new Set();
let lastSyncAt = null;
let wasRunning = false;

/** Subscribes to crawl events; returns an unsubscribe function. */
export function onSyncEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Paints the header pill. */
function paint(running) {
  const pill = document.getElementById('sync-pill');
  pill.classList.toggle('running', running);
  pill.classList.toggle('ok', !running && Boolean(lastSyncAt));
  pill.querySelector('.sync-text').textContent = running ? 'Syncing relays…' : lastSyncAt ? `Updated ${ago(lastSyncAt)}` : 'Not synced yet';
}

/** Starts polling and keeps the pill current. Called once at startup. */
export async function initSyncStatus() {
  const poll = async () => {
    let s;
    try { s = await get('/api/sync'); } catch { setTimeout(poll, 30000); return; }
    lastSyncAt = s.lastSyncAt;
    paint(s.running);
    const events = s.running ? [{ type: 'start' }, { type: 'running', backlog: s.log }] : wasRunning ? [{ type: 'idle' }] : [];
    for (const e of events) for (const fn of listeners) fn(e);
    wasRunning = s.running;
    // A static snapshot changes only when CI rebuilds it, so check rarely.
    setTimeout(poll, s.running ? 5000 : s.manual === false ? 300000 : 30000);
  };
  await poll();
}
