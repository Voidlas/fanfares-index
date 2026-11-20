/**
 * The activity feed (sales, zaps, newly published events, comments,
 * reactions), shared by the overview and the Live page. Snapshot activity
 * and the real-time relay stream (live-relays.js) merge into one list.
 */
import { get } from '../api.js';
import { fanfaresUrl } from '../nostr.js';
import { subscribeLive, liveItems, liveStatus } from '../live-relays.js';
import { ago, agoShort, avatar, cover, displayName, esc, kindName, num, personHref, releaseHref, satsShort } from '../ui.js';

const VERB = { sale: 'bought', zap: 'zapped', release: 'published', comment: 'commented on', reaction: 'reacted to', repost: 'reposted' };
const ICON = {
  sale: '<path d="M11.5 2.5 4.5 11h5l-1 6.5 7-8.5h-5z"/>',
  zap: '<path d="M11.5 2.5 4.5 11h5l-1 6.5 7-8.5h-5z"/>',
  release: '<path d="M10 4v12M4 10h12"/>',
  comment: '<path d="M4 5h12v8H9l-4 3v-3H4z"/>',
  reaction: '<path d="M10 16s-6-3.6-6-8a3.2 3.2 0 0 1 6-1.6A3.2 3.2 0 0 1 16 8c0 4.4-6 8-6 8z"/>',
  repost: '<path d="M5 8h9l-3-3M15 12H6l3 3"/>'
};

/** Link to an event: its page here, or Fanfares for one newer than the snapshot. */
const eventHref = (r) => (r.fresh ? fanfaresUrl(r.address) || '#/events' : releaseHref(r.address));

/** One feed row. */
export function feedItem(e) {
  const r = e.release || {};
  const kind = kindName(r.kind, r.kindLabel);
  const ext = r.fresh ? ' target="_blank" rel="noopener"' : '';
  const right = e.sats && e.type !== 'release' ? satsShort(e.sats) : e.type === 'reaction' ? `<span class="fi-emoji">${esc(e.text)}</span>` : '';
  const sub = e.type === 'comment' && e.text ? `“${esc(e.text)}”` : `${esc(kind)}${e.rail === 'cashu' ? ' · ecash' : ''}${e.type === 'sale' && e.source === 'verified' ? ' · verified' : ''}`;
  return `<div class="fi ${e.type}${e.live ? ' is-live' : ''}" data-id="${esc(e.id || '')}">
    <a class="fi-thumb" href="${eventHref(r)}"${ext} tabindex="-1" aria-hidden="true">${cover({ ...r, kindLabel: kind }, {})}
      <span class="fi-icon"><svg width="11" height="11" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICON[e.type] || ICON.release}</svg></span></a>
    <div class="fi-body">
      <div class="fi-line"><a href="${personHref(e.actor.pubkey)}"><b>${esc(displayName(e.actor))}</b></a> ${VERB[e.type] || 'interacted with'}
        <a href="${eventHref(r)}"${ext}><b>${esc(r.title || 'an event')}</b></a></div>
      <div class="fi-sub">${sub}</div>
    </div>
    <div class="fi-right">${right}<span class="fi-when" title="${e.at ? new Date(e.at * 1000).toLocaleString('en-US') : ''}">${e.live && Date.now() / 1000 - e.at < 60 ? 'now' : agoShort(e.at)}</span></div>
  </div>`;
}

/** The newest published event, pinned above a feed. */
function latestCard(e) {
  const r = e.release || {};
  const ext = r.fresh ? ' target="_blank" rel="noopener"' : '';
  return `<a class="latest" href="${eventHref(r)}"${ext}>
    <span class="latest-cover">${cover({ ...r, kindLabel: kindName(r.kind, r.kindLabel) }, {})}</span>
    <span class="latest-body"><span class="eyebrow">Latest published · ${esc(kindName(r.kind, r.kindLabel))} · ${ago(e.at)}</span>
      <b>${esc(r.title || 'Untitled')}</b><span class="latest-by">${avatar(e.actor, 18)}${esc(displayName(e.actor))}</span></span>
    <span class="latest-go" aria-hidden="true">→</span></a>`;
}

/**
 * One-line connection status for a feed header.
 * @param {number} [newestAt] Time of the newest item shown, for the "all quiet" note.
 */
export function liveStatusText(newestAt) {
  const s = liveStatus();
  if (!s.since) return 'Connecting to relays…';
  const relays = s.connected ? `${s.connected} of ${s.relays.length} relays connected` : 'Relays unreachable, showing the archive';
  if (s.live) return `${relays} · ${num(s.live)} new since the snapshot · last ${agoShort(s.lastLiveAt)} ago`;
  const quiet = newestAt ? `all quiet, no new Fanfares activity since ${new Date(newestAt * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'listening for new activity';
  return `${relays} · ${quiet}`;
}

/**
 * Renders a self-updating feed into `host`: the snapshot's latest activity
 * and the archive's comments, reactions and reposts, with live relay items
 * merged on top as they arrive.
 * @param {HTMLElement} host
 * @param {object} [opts]
 * @param {number} [opts.limit] Rows shown.
 * @param {(e: object) => boolean} [opts.filter] Which items to show.
 * @param {HTMLElement} [opts.status] Element that shows the connection status line.
 * @param {boolean} [opts.pin] Pin the newest published event above the rows.
 * @param {(rows: object[]) => void} [opts.onPaint] Called with every merged item after each paint.
 * @returns {Promise<{refilter: (f: (e: object) => boolean) => void}>}
 */
export async function liveFeed(host, { limit = 8, filter = () => true, status, pin = false, onPaint } = {}) {
  const snapshot = await get('/api/activity', { limit: 100 });
  let show = filter;
  let newestAt = 0;
  const paint = () => {
    if (!host.isConnected) { stop(); return; }
    const all = [...liveItems(), ...snapshot].sort((a, b) => b.at - a.at);
    const latest = pin ? all.find((e) => e.type === 'release') : null;
    const rows = all.filter((e) => e !== latest && show(e)).slice(0, limit);
    const before = new Set([...host.querySelectorAll('[data-id]')].map((x) => x.dataset.id));
    host.innerHTML = (latest ? latestCard(latest) : '') + (rows.length ? rows.map(feedItem).join('') : '<div class="empty">Nothing here yet.</div>');
    if (before.size) host.querySelectorAll('.fi.is-live').forEach((x) => { if (!before.has(x.dataset.id)) x.classList.add('enter'); });
    newestAt = all[0]?.at || 0;
    if (status) status.textContent = liveStatusText(newestAt);
    onPaint?.(all);
  };
  let pending;
  const stop = subscribeLive((m) => {
    if (m.type === 'status') { if (status && host.isConnected) status.textContent = liveStatusText(newestAt); return; }
    clearTimeout(pending);
    pending = setTimeout(paint, m.type === 'profile' ? 300 : 60);
  });
  paint();
  // Keep relative times fresh.
  const tick = setInterval(() => { if (!host.isConnected) { clearInterval(tick); stop(); } else paint(); }, 30000);
  return { refilter: (f) => { show = f; paint(); } };
}

/** Static list of feed rows (no live updates). */
export function feedItems(items) {
  return items.length ? items.map(feedItem).join('') : '<div class="empty">No activity yet.</div>';
}
