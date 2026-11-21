/**
 * Real-time Fanfares activity straight from Nostr relays, in the browser.
 *
 * The snapshot is rebuilt hourly; this stream fills the gap. It subscribes
 * to the same relays the crawler reads for everything newer than the
 * snapshot: events published through Fanfares (NIP-89 handler tag), and the
 * zaps, nutzaps, comments and reactions pointing at known events. Items come
 * out in the activity feed's shape, flagged `live: true`.
 *
 * One shared connection per page load; views subscribe and unsubscribe.
 */
import { get, isStatic } from './api.js';
import { kindName } from './ui.js';

const RELAYS = ['wss://fanfares.nostr1.com', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io'];
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.primal.net'];
const APP_REF = '31990:d7d8109ee43657ce6056ada4653006bbb641f31e50e85243681c2724507811ec:Fanfares';
const CONTENT_KINDS = [1, 30023, 31337, 31338, 31339, 36787];
const ACTIVITY_KINDS = [9735, 9321, 1111, 7, 6, 16];
/** Archive roles replayed into the feed on load (sales and new events already come from the activity file). */
const ARCHIVE_ROLES = ['comment', 'reaction', 'repost'];
const CHUNK = 150;
const KEEP = 400;

const listeners = new Set();
const items = [];
const seen = new Set();
const profiles = new Map();
const status = new Map(RELAYS.map((r) => [r, 'connecting']));
let started = false;
let since = 0;
let received = 0;
let lastLiveAt = 0;
let archiveLoaded = false;
const known = new Map(); // address or event id -> { address, title, cover, kind, kindLabel }

const emit = (msg) => { for (const fn of listeners) fn(msg); };

/** Amount in sats from a BOLT11 invoice's human-readable part. */
function bolt11Sats(inv) {
  const m = /^ln(?:bc|tb|bcrt)(\d+)([munp]?)1/i.exec(inv || '');
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = { '': 1e8, m: 1e5, u: 100, n: 0.1, p: 0.0001 }[m[2].toLowerCase()];
  return Math.floor(n * mult);
}

const tag = (ev, name) => ev.tags.find((t) => t[0] === name)?.[1];
/** The known event a reaction, zap or comment points at (NIP-22 root tags first). */
function target(ev) {
  for (const name of ['A', 'a', 'E', 'e']) {
    for (const t of ev.tags) if (t[0] === name && known.has(t[1])) return known.get(t[1]);
  }
  return null;
}

/** Turns a raw event into a feed item, or null when it is not about Fanfares content. */
function toItem(ev) {
  if (CONTENT_KINDS.includes(ev.kind) && ev.tags.some((t) => t[0] === 'a' && t[1] === APP_REF)) {
    const d = tag(ev, 'd');
    const address = ev.kind === 1 || d == null ? ev.id : `${ev.kind}:${ev.pubkey}:${d}`;
    const title = tag(ev, 'title') || ev.content.split('\n')[0].slice(0, 120) || 'Untitled';
    const release = { address, title, cover: tag(ev, 'image') || tag(ev, 'cover') || '', kind: ev.kind, kindLabel: kindName(ev.kind), fresh: !known.has(address) };
    return { id: ev.id, type: 'release', at: ev.created_at, actor: { pubkey: ev.pubkey }, release };
  }
  const release = target(ev);
  if (!release) return null;
  if (ev.kind === 9735) {
    let req = null;
    try { req = JSON.parse(tag(ev, 'description') || 'null'); } catch { /* malformed */ }
    const msats = Number(req?.tags?.find((t) => t[0] === 'amount')?.[1] || 0);
    const sats = msats ? Math.floor(msats / 1000) : bolt11Sats(tag(ev, 'bolt11'));
    return { id: ev.id, type: 'zap', at: ev.created_at, sats, rail: 'lightning', actor: { pubkey: req?.pubkey || tag(ev, 'P') || ev.pubkey }, release };
  }
  if (ev.kind === 9321) {
    let sats = 0;
    for (const t of ev.tags) if (t[0] === 'proof') { try { sats += Number(JSON.parse(t[1]).amount) || 0; } catch { /* skip */ } }
    return { id: ev.id, type: 'zap', at: ev.created_at, sats, rail: 'cashu', actor: { pubkey: ev.pubkey }, release };
  }
  if (ev.kind === 1111) return { id: ev.id, type: 'comment', at: ev.created_at, text: ev.content.slice(0, 160), actor: { pubkey: ev.pubkey }, release };
  if (ev.kind === 6 || ev.kind === 16) return { id: ev.id, type: 'repost', at: ev.created_at, actor: { pubkey: ev.pubkey }, release };
  if (ev.kind === 7) return { id: ev.id, type: 'reaction', at: ev.created_at, text: ev.content === '+' || !ev.content ? '♥' : ev.content.slice(0, 4), actor: { pubkey: ev.pubkey }, release };
  return null;
}

/** Attaches a cached profile to an actor. */
function withProfile(item) {
  const p = profiles.get(item.actor.pubkey);
  if (p) Object.assign(item.actor, p);
  return item;
}

const wanted = new Set();
let profileTimer;
/** Batches kind-0 lookups for actors we have not seen yet. */
function wantProfile(pubkey) {
  if (profiles.has(pubkey) || wanted.has(pubkey)) return;
  wanted.add(pubkey);
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => {
    const authors = [...wanted].filter((pk) => !profiles.has(pk));
    if (!authors.length) return;
    for (const url of PROFILE_RELAYS) {
      open(url, [{ kinds: [0], authors }], (ev) => {
        try {
          const c = JSON.parse(ev.content);
          profiles.set(ev.pubkey, { name: c.display_name || c.name || '', picture: c.picture || '', nip05: c.nip05 || '' });
          for (const it of items) if (it.actor.pubkey === ev.pubkey) withProfile(it);
          emit({ type: 'profile', pubkey: ev.pubkey });
        } catch { /* bad profile json */ }
      }, { closeOnEose: true });
    }
  }, 400);
}

/**
 * Opens one relay with the given filters.
 * @returns {WebSocket|null}
 */
function open(url, filters, onEvent, { closeOnEose = false, track = false } = {}) {
  let ws;
  try { ws = new WebSocket(url); } catch { if (track) setStatus(url, 'failed'); return null; }
  const sub = `ff${Math.random().toString(36).slice(2, 8)}`;
  ws.onopen = () => { if (track) setStatus(url, 'live'); ws.send(JSON.stringify(['REQ', sub, ...filters])); };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg[0] === 'EVENT' && msg[1] === sub && msg[2]) onEvent(msg[2]);
    else if (msg[0] === 'EOSE' && closeOnEose) ws.close();
  };
  ws.onerror = () => { if (track) setStatus(url, 'failed'); };
  ws.onclose = () => {
    if (!track) return;
    setStatus(url, 'reconnecting');
    setTimeout(() => open(url, filters.map((f) => ({ ...f, since: Math.max(f.since || 0, Math.floor(Date.now() / 1000) - 120) })), onEvent, { track }), 8000);
  };
  return ws;
}

function setStatus(url, s) {
  status.set(url, s);
  emit({ type: 'status' });
}

/**
 * Handles one event, from a relay or (with `archived`) from the archive.
 * @returns {object|null} The feed item it became.
 */
function ingest(ev, archived = false) {
  if (!ev?.id || seen.has(ev.id) || (!archived && ev.created_at < since)) return null;
  seen.add(ev.id);
  if (!archived) received += 1;
  const item = toItem(ev);
  if (!item) return null;
  item.live = !archived;
  if (!archived) lastLiveAt = Math.max(lastLiveAt, ev.created_at);
  withProfile(item);
  wantProfile(item.actor.pubkey);
  items.push(item);
  items.sort((a, b) => b.at - a.at);
  if (items.length > KEEP) items.length = KEEP;
  if (!archived) emit({ type: 'item', item });
  return item;
}

/** Replays the newest archived comments, reactions and reposts (static snapshot only). */
async function loadArchive() {
  if (!(await isStatic())) return;
  const fetchJson = (rel) => fetch(`api/v1/${rel}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const manifest = await fetchJson('events/manifest.json');
  const files = ARCHIVE_ROLES.map((role) => manifest?.roles?.[role]?.shards?.[0]?.file).filter(Boolean);
  const shards = await Promise.all(files.map(fetchJson));
  for (const evs of shards) for (const ev of evs || []) ingest(ev, true);
  archiveLoaded = true;
  emit({ type: 'item' });
}

/** Loads what the snapshot knows, then subscribes on every relay. */
async function start() {
  started = true;
  const [meta, list] = await Promise.all([
    get('/api/sync').catch(() => null),
    (async () => {
      const out = [];
      for (let offset = 0; ; offset += 100) {
        const res = await get('/api/releases', { limit: 100, offset });
        out.push(...res.items);
        if (!res.items.length || out.length >= res.total) return out;
      }
    })().catch(() => [])
  ]);
  for (const r of list) {
    const info = { address: r.address, title: r.title, cover: r.cover, kind: r.kind, kindLabel: kindName(r.kind, r.kindLabel) };
    known.set(r.address, info);
    if (r.eventId) known.set(r.eventId, info);
  }
  // Everything newer than the snapshot (at most a day back, so a stale page still shows something fresh).
  const now = Math.floor(Date.now() / 1000);
  since = Math.max(meta?.lastSyncAt || 0, now - 86400) - 60;
  const addrs = list.map((r) => r.address);
  const ids = list.filter((r) => r.kind === 1 && r.eventId).map((r) => r.eventId);
  const filters = [{ kinds: CONTENT_KINDS, '#a': [APP_REF], since }];
  for (let i = 0; i < addrs.length; i += CHUNK) filters.push({ kinds: ACTIVITY_KINDS, '#a': addrs.slice(i, i + CHUNK), since });
  for (let i = 0; i < ids.length; i += CHUNK) filters.push({ kinds: ACTIVITY_KINDS, '#e': ids.slice(i, i + CHUNK), since });
  if (typeof WebSocket === 'undefined') { for (const r of RELAYS) status.set(r, 'failed'); emit({ type: 'status' }); return; }
  loadArchive().catch(() => {});
  for (const url of RELAYS) open(url, filters, (ev) => ingest(ev), { track: true });
}

/**
 * Subscribes to the live stream. The callback gets `{type: 'item'|'status'|'profile'}`.
 * @returns {() => void} Unsubscribe.
 */
export function subscribeLive(fn) {
  listeners.add(fn);
  if (!started) start().catch(() => {});
  return () => listeners.delete(fn);
}

/** Live items received so far, newest first. */
export const liveItems = () => items;

/** Connection state per relay, plus counters. */
export const liveStatus = () => ({
  relays: [...status], received, since, lastLiveAt, archiveLoaded,
  live: items.filter((i) => i.live).length,
  connected: [...status.values()].filter((s) => s === 'live').length
});
