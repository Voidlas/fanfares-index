/**
 * Builds the in-memory read model the Cloudflare API serves from.
 *
 * On the Workers free plan a Durable Object may write 100k SQLite rows a day,
 * so derived tables (content, payments, purchases, profiles, follows) are
 * not stored: they are recomputed here, in memory, from the raw `events`
 * rows whenever a sync phase stores something new. This mirrors
 * `rebuildDerived` in lib/db.js rule for rule, so the Node archive and the
 * Worker report the same numbers.
 *
 * Pure: no I/O, no Workers APIs. Called by worker/src/archive.js and by the
 * parity check in worker/scripts/parity.mjs.
 */
import { REPLACEABLE_ROLES, referenceTargets } from '../../lib/classify.js';
import { parseContent, parseNutzap, parseProfile, parseZapReceipt } from '../../lib/parse.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** Appends `value` to the array stored under `key` in `map`. */
function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/**
 * Latest revision per content address, with first-seen time, revision count
 * and deletion flag (a kind 5 from the same author naming the address or id).
 */
function buildContents(contentEvents, deletionEvents) {
  const deleted = new Set();
  for (const d of deletionEvents) {
    for (const t of d.tags || []) if ((t[0] === 'a' || t[0] === 'e') && t[1]) deleted.add(`${d.pubkey}|${t[1]}`);
  }
  const byAddress = new Map();
  const idToAddress = new Map();
  for (const { ev, address } of [...contentEvents].sort((a, b) => a.ev.created_at - b.ev.created_at)) {
    idToAddress.set(ev.id, address);
    const prev = byAddress.get(address);
    byAddress.set(address, { ev, first: prev ? prev.first : ev.created_at, revisions: (prev?.revisions || 0) + 1 });
  }
  const contents = new Map();
  for (const [address, v] of byAddress) {
    const meta = parseContent(v.ev);
    contents.set(address, {
      address,
      eventId: v.ev.id,
      kind: v.ev.kind,
      pubkey: v.ev.pubkey,
      createdAt: v.ev.created_at,
      firstPublished: meta.publishedAt && meta.publishedAt < v.first ? meta.publishedAt : v.first,
      revisions: v.revisions,
      deleted: deleted.has(`${v.ev.pubkey}|${address}`) || deleted.has(`${v.ev.pubkey}|${v.ev.id}`),
      meta,
      event: v.ev
    });
  }
  return { contents, idToAddress };
}

/** One payment leg per zap receipt / nutzap, resolved to a content address. */
function buildPayments(paymentEvents, idToAddress) {
  const seen = new Set();
  const payments = [];
  for (const { ev, role } of paymentEvents) {
    const leg = role === 'zap' ? parseZapReceipt(ev) : parseNutzap(ev);
    if (seen.has(leg.eventId)) continue;
    seen.add(leg.eventId);
    payments.push({
      eventId: leg.eventId,
      rail: leg.rail,
      address: leg.targetAddress || idToAddress.get(leg.targetEventId) || leg.targetEventId || null,
      sender: leg.sender || null,
      recipient: leg.recipient || null,
      msats: leg.amountMsats,
      createdAt: leg.createdAt,
      comment: leg.comment,
      mint: leg.mint
    });
  }
  return payments;
}

/**
 * Purchases: worker-verified ones (authoritative) plus receipt-derived ones,
 * where a buyer's payments to an item add up to at least its price.
 * Verified rows without a time borrow the buyer's latest payment time.
 */
function buildPurchases(verifiedRows, payments, contents) {
  const purchases = new Map();
  for (const v of verifiedRows) {
    const at = v.purchased_at > 1e12 ? Math.floor(v.purchased_at / 1000) : v.purchased_at || 0;
    purchases.set(`${v.address}|${v.buyer}`, { address: v.address, buyer: v.buyer, source: 'verified', msats: v.amount_msats, at, rail: 'lightning' });
  }
  const groups = new Map();
  for (const p of payments) {
    const c = contents.get(p.address);
    if (!c || !p.sender || p.sender === c.pubkey) continue;
    const key = `${p.address}|${p.sender}`;
    const g = groups.get(key) || { address: p.address, buyer: p.sender, msats: 0, at: 0, rails: new Set(), price: c.meta.priceSats };
    g.msats += p.msats;
    g.at = Math.max(g.at, p.createdAt);
    g.rails.add(p.rail);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const rail = g.rails.size > 1 ? 'mixed' : [...g.rails][0];
    const verified = purchases.get(key);
    if (verified) {
      if (verified.at === 0) Object.assign(verified, { at: g.at, rail });
    } else if (g.price > 0 && g.msats >= g.price * 1000) {
      purchases.set(key, { address: g.address, buyer: g.buyer, source: 'receipts', msats: g.msats, at: g.at, rail });
    }
  }
  return [...purchases.values()];
}

/**
 * Pubkeys that took part in Fanfares: creators, split and tagged recipients,
 * buyers, payers, commenters. Decides whose profiles the sync crawls and
 * which follow edges count.
 */
function buildParticipants(contentEvents, engagementAuthors, payments, purchases) {
  const keys = new Set(engagementAuthors);
  // Every revision counts: an earlier revision may have split to someone the latest no longer names.
  for (const { ev } of contentEvents) {
    keys.add(ev.pubkey);
    for (const t of ev.tags || []) if ((t[0] === 'p' || t[0] === 'zap') && t[1]) keys.add(t[1]);
  }
  for (const p of payments) { keys.add(p.sender); keys.add(p.recipient); }
  for (const p of purchases) keys.add(p.buyer);
  return new Set([...keys].filter((k) => HEX64.test(k || '')));
}

/**
 * Builds the full read model.
 * @param {Iterable<{id: string, kind: number, pubkey: string, created_at: number, role: string, address: string|null, json: string}>} eventRows
 *   Every row of the Durable Object's `events` table (or the Node archive's).
 * @param {{address: string, buyer: string, amount_msats: number, purchased_at: number}[]} verifiedRows
 *   Worker-verified purchases imported from the legacy fanfares-workers feed.
 * @returns {object} Lookup structures consumed by worker/src/queries.js.
 */
export function buildModel(eventRows, verifiedRows) {
  const index = [];
  const replaceable = new Map();
  const contentEvents = [];
  const deletionEvents = [];
  const paymentEvents = [];
  const engagementEvents = [];
  const profiles = new Map();
  const wallets = new Map();
  const followLists = [];

  for (const row of eventRows) {
    index.push({ id: row.id, kind: row.kind, pubkey: row.pubkey, createdAt: row.created_at, role: row.role });
    if (REPLACEABLE_ROLES.has(row.role)) replaceable.set(`${row.pubkey}:${row.kind}`, { id: row.id, createdAt: row.created_at });
    const ev = JSON.parse(row.json);
    if (row.role === 'content') contentEvents.push({ ev, address: row.address });
    else if (row.role === 'deletion') deletionEvents.push(ev);
    else if (row.role === 'zap' || row.role === 'nutzap') paymentEvents.push({ ev, role: row.role });
    else if (row.role === 'comment' || row.role === 'reaction' || row.role === 'repost') engagementEvents.push({ ev, role: row.role });
    else if (row.role === 'profile') profiles.set(ev.pubkey, { ...parseProfile(ev), createdAt: ev.created_at });
    else if (row.role === 'wallet') wallets.set(ev.pubkey, { mints: (ev.tags || []).filter((t) => t[0] === 'mint' && t[1]).map((t) => t[1]), createdAt: ev.created_at });
    else if (row.role === 'follows') followLists.push({ follower: ev.pubkey, followees: (ev.tags || []).filter((t) => t[0] === 'p').map((t) => t[1]) });
  }
  index.sort((a, b) => b.createdAt - a.createdAt);

  const { contents, idToAddress } = buildContents(contentEvents, deletionEvents);
  const payments = buildPayments(paymentEvents, idToAddress);
  const purchases = buildPurchases(verifiedRows, payments, contents);
  const resolve = (ref) => (contents.has(ref) ? ref : idToAddress.get(ref));

  // Releases relays only keep the newest revision of, backdated to their first payment or purchase.
  for (const p of payments) {
    const c = contents.get(p.address);
    if (c && p.createdAt < c.firstPublished) c.firstPublished = p.createdAt;
  }
  for (const p of purchases) {
    const c = contents.get(p.address);
    if (c && p.at > 0 && p.at < c.firstPublished) c.firstPublished = p.at;
  }

  const engagement = new Map();
  const comments = [];
  const engagementAuthors = [];
  for (const { ev, role } of engagementEvents) {
    engagementAuthors.push(ev.pubkey);
    const addresses = [...new Set(referenceTargets(ev).map(resolve).filter(Boolean))];
    for (const address of addresses) {
      const counts = engagement.get(address) || { comments: 0, reactions: 0, reposts: 0 };
      counts[{ comment: 'comments', reaction: 'reactions', repost: 'reposts' }[role]]++;
      engagement.set(address, counts);
    }
    if (role === 'comment') comments.push({ id: ev.id, pubkey: ev.pubkey, createdAt: ev.created_at, text: (ev.content || '').slice(0, 2000), addresses });
  }
  for (const { ev } of paymentEvents) if (ev.kind === 9321) engagementAuthors.push(ev.pubkey);

  const participants = buildParticipants(contentEvents, engagementAuthors, payments, purchases);
  const followers = new Map();
  const following = new Map();
  for (const { follower, followees } of followLists) {
    const edges = new Set(followees.filter((f) => f !== follower && participants.has(f)));
    following.set(follower, edges.size);
    for (const f of edges) followers.set(f, (followers.get(f) || 0) + 1);
  }

  const paymentsByAddress = new Map();
  const paymentsByRecipient = new Map();
  for (const p of payments) {
    if (p.address) push(paymentsByAddress, p.address, p);
    if (p.recipient) push(paymentsByRecipient, p.recipient, p);
  }
  const purchasesByAddress = new Map();
  const purchasesByBuyer = new Map();
  for (const p of purchases) { push(purchasesByAddress, p.address, p); push(purchasesByBuyer, p.buyer, p); }
  const commentsByAddress = new Map();
  for (const c of comments) for (const a of c.addresses) push(commentsByAddress, a, c);

  const targets = new Set([...contents.keys(), ...idToAddress.keys()]);
  return {
    builtAt: Math.floor(Date.now() / 1000),
    index,
    replaceable,
    contents,
    idToAddress,
    targets,
    payments,
    paymentsByAddress,
    paymentsByRecipient,
    purchases,
    purchasesByAddress,
    purchasesByBuyer,
    comments,
    commentsByAddress,
    engagement,
    profiles,
    wallets,
    followers,
    following,
    participants: [...participants]
  };
}
