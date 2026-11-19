/**
 * Pure parsers that turn raw Nostr events into the rows the archive stores:
 * content metadata (title, artwork, preview, price, environment), payment
 * legs (zap receipts and nutzaps) and profile metadata. No I/O; every
 * function here is safe to call on untrusted relay data.
 */
import { CONTENT_KINDS, FANFARES_APP_REF, KIND_LABELS } from './constants.js';

/** First value of tag `name`, or ''. */
export function tagValue(ev, name) {
  return ev?.tags?.find((t) => t[0] === name)?.[1] || '';
}

/** Every first value of tags named `name`. */
export function tagValues(ev, name) {
  return (ev?.tags || []).filter((t) => t[0] === name && t[1]).map((t) => t[1]);
}

/**
 * The address an event is stored and bought under: `kind:pubkey:d` when it
 * has a `d` tag (Fanfares gives even kind 1 notes one), else the event id.
 */
export function contentAddress(ev) {
  const d = tagValue(ev, 'd');
  return d ? `${ev.kind}:${ev.pubkey}:${d}` : ev.id;
}

/** Whether an event was published by the Fanfares client. */
export function isFanfaresEvent(ev) {
  return (ev?.tags || []).some(
    (t) => (t[0] === 'a' && t[1] === FANFARES_APP_REF) || (t[0] === 'client' && t[1] === 'Fanfares')
  );
}

/**
 * Whether an event is Fanfares sellable content (and not a reply that happens
 * to carry the client tag).
 */
export function isFanfaresContent(ev) {
  return CONTENT_KINDS.includes(ev.kind) && isFanfaresEvent(ev) && Boolean(tagValue(ev, 'price') || tagValue(ev, 'encrypted'));
}

/** Parses an `imeta` tag's "key value" entries into a multi-map. */
function parseImeta(tag) {
  const out = {};
  for (const part of tag.slice(1)) {
    const i = part.indexOf(' ');
    const key = i === -1 ? part : part.slice(0, i);
    const value = i === -1 ? true : part.slice(i + 1);
    (out[key] ||= []).push(value);
  }
  return out;
}

/** Converts "1:07:44", "5:35" or "260" to seconds; 0 when unparsable. */
export function durationSeconds(raw) {
  if (!raw) return 0;
  const parts = String(raw).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** The visible text of a Fanfares note: everything above the unlock footer. */
export function publicText(content) {
  if (!content) return '';
  const cut = content.indexOf('⚡Zap ');
  return (cut === -1 ? content : content.slice(0, cut)).trim();
}

/**
 * Which Fanfares deployment a release was published from, read from the
 * key endpoint and media hosts it references. Older releases name neither
 * (bare `["encrypted"]` tag, non-Fanfares hosts) and stay 'unknown'.
 * @param {object} ev Content event.
 * @returns {'staging' | 'production' | 'unknown'}
 */
export function releaseEnvironment(ev) {
  const urls = (ev.tags || []).flat().filter((v) => typeof v === 'string' && /https?:\/\//.test(v)).join(' ');
  if (/staging\.|localhost|127\.0\.0\.1/.test(urls)) return 'staging';
  if (/(^|[/.\s])(api|cn|blossom)\.fanfares\.live|fanfares\.io/.test(urls)) return 'production';
  return 'unknown';
}

/**
 * Whether a release is QA/placeholder material that the public explorer
 * hides by default (it stays in the archive and appears with `test=1`):
 * staging uploads, titles that say test/QA/"don't pay", untitled audio,
 * slug titles like "ak-pay-ux", and very short titles priced at 1-2 sats
 * (the keyboard-mash uploads from early testing).
 * @param {object} r Fields already derived by parseContent.
 */
export function looksLikeTest({ title, env, priceSats, hasTitleTag, kind }) {
  const t = title.trim().toLowerCase();
  if (env === 'staging') return true;
  if (/\b(tes[tr]\w*|tedt|qa|smoke|do not (buy|pay|zap)|don'?t (buy|pay|zap))\b|testfi/.test(t)) return true;
  if (/^(title for .{0,30}|podcast|episode \d*|untitled)$/.test(t)) return true;
  if (kind !== 1 && !hasTitleTag) return true;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(t)) return true;
  const letters = t.replace(/[^\p{L}\p{N}]/gu, '').length;
  return letters < 6 || (priceSats <= 2 && letters < 14);
}

/**
 * Extracts everything the archive shows about a content event.
 * @param {object} ev A Fanfares content event (kind in CONTENT_KINDS).
 * @returns {object} Normalised metadata stored in the `content` table.
 */
export function parseContent(ev) {
  const imetas = (ev.tags || []).filter((t) => t[0] === 'imeta').map(parseImeta);
  const purpose = (m) => m.purpose?.[0] || (m.artwork ? 'artwork' : m.preview ? 'preview' : 'main');
  const artworkMeta = imetas.find((m) => purpose(m) === 'artwork');
  const previewMeta = imetas.find((m) => purpose(m) === 'preview' && !m.encrypted);
  const mainMetas = imetas.filter((m) => purpose(m) === 'main' && m.encrypted);

  const price = tagValue(ev, 'price') ? (ev.tags.find((t) => t[0] === 'price') || []) : [];
  const priceSats = Math.max(0, parseInt(price[1], 10) || 0);
  const env = releaseEnvironment(ev);

  const text = publicText(ev.content);
  // Notes have no title tag: use their first line of prose, skipping bare media links.
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !/^https?:\/\/\S+$/.test(l));
  const title = tagValue(ev, 'title') || tagValue(ev, 'subject') || firstLine?.slice(0, 120) || 'Untitled';
  const summary = tagValue(ev, 'summary') || (ev.kind === 36787 ? '' : text).slice(0, 600);
  const cover = tagValue(ev, 'image') || artworkMeta?.url?.[0] || '';
  const previewUrl = previewMeta?.url?.[0] || (ev.kind === 36787 && !tagValue(ev, 'encrypted') ? tagValue(ev, 'url') : '') || '';
  const previewMime = previewMeta?.m?.[0] || '';
  const duration = mainMetas.reduce((s, m) => s + durationSeconds(m.duration?.[0]), 0)
    || durationSeconds(tagValue(ev, 'duration'));

  const splits = (ev.tags || [])
    .filter((t) => t[0] === 'zap' && /^[0-9a-f]{64}$/.test(t[1] || ''))
    .map((t) => ({ pubkey: t[1], weight: Number(t[3]) || 1 }));

  const isTest = looksLikeTest({ title, env, priceSats, hasTitleTag: Boolean(tagValue(ev, 'title') || tagValue(ev, 'subject')), kind: ev.kind });

  return {
    address: contentAddress(ev),
    kind: ev.kind,
    kindLabel: KIND_LABELS[ev.kind] || `Kind ${ev.kind}`,
    title,
    summary,
    cover,
    previewUrl,
    previewMime,
    durationSec: duration,
    priceSats,
    env,
    isTest,
    parts: mainMetas.length,
    topics: [...new Set(tagValues(ev, 't').map((t) => t.toLowerCase()))].slice(0, 12),
    splits,
    publishedAt: parseInt(tagValue(ev, 'published_at'), 10) || 0
  };
}

/**
 * Reads the amount in millisats from a bolt11 invoice's human-readable part.
 * @param {string} bolt11 The invoice from a zap receipt's `bolt11` tag.
 * @returns {number} msats, or 0 for amountless/unparsable invoices.
 */
export function bolt11Msats(bolt11) {
  const m = /^ln(?:bc|tb|bcrt|tbs)(\d+)([munp]?)1/i.exec(bolt11 || '');
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = { '': 1e11, m: 1e8, u: 1e5, n: 1e2, p: 0.1 }[m[2].toLowerCase()];
  return Math.round(n * mult);
}

/**
 * Turns a NIP-57 zap receipt into one payment leg. The bolt11 amount is what
 * was actually paid, so it wins over the zap request's `amount` tag.
 * @param {object} ev Kind 9735 event.
 */
export function parseZapReceipt(ev) {
  let request = {};
  try { request = JSON.parse(tagValue(ev, 'description') || '{}') || {}; } catch { /* malformed request */ }
  const reqAmount = parseInt(request.tags?.find?.((t) => t[0] === 'amount')?.[1], 10) || 0;
  return {
    eventId: ev.id,
    rail: 'lightning',
    targetAddress: tagValue(ev, 'a'),
    targetEventId: tagValue(ev, 'e'),
    sender: tagValue(ev, 'P') || request.pubkey || '',
    recipient: tagValue(ev, 'p'),
    amountMsats: bolt11Msats(tagValue(ev, 'bolt11')) || reqAmount,
    comment: typeof request.content === 'string' ? request.content.slice(0, 280) : '',
    createdAt: ev.created_at,
    mint: ''
  };
}

/**
 * Turns a NIP-61 nutzap into one payment leg; the amount is the sum of the
 * locked proofs (Fanfares always sends unit `sat`).
 * @param {object} ev Kind 9321 event.
 */
export function parseNutzap(ev) {
  const unit = tagValue(ev, 'unit') || 'sat';
  let sats = 0;
  for (const raw of tagValues(ev, 'proof')) {
    try { sats += Number(JSON.parse(raw).amount) || 0; } catch { /* bad proof */ }
  }
  return {
    eventId: ev.id,
    rail: 'cashu',
    targetAddress: tagValue(ev, 'a'),
    targetEventId: tagValue(ev, 'e'),
    sender: ev.pubkey,
    recipient: tagValue(ev, 'p'),
    amountMsats: unit === 'msat' ? sats : sats * 1000,
    comment: (ev.content || '').slice(0, 280),
    createdAt: ev.created_at,
    mint: tagValue(ev, 'u')
  };
}

/** Parses kind 0 metadata into the fields the UI shows. */
export function parseProfile(ev) {
  let m = {};
  try { m = JSON.parse(ev.content || '{}') || {}; } catch { /* bad metadata */ }
  const s = (v) => (typeof v === 'string' ? v.slice(0, 2000) : '');
  return {
    name: s(m.name),
    displayName: s(m.display_name || m.displayName),
    picture: s(m.picture),
    banner: s(m.banner),
    about: s(m.about),
    nip05: s(m.nip05),
    lud16: s(m.lud16 || m.lud06),
    website: s(m.website)
  };
}
