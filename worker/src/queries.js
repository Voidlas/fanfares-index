/**
 * Read-side API over the in-memory model from model.js. Each function returns
 * exactly the JSON shape lib/queries.js returns from SQL, so the explorer UI
 * in public/ works unchanged against either backend.
 *
 * Pure: called by worker/src/routes.js with validated parameters.
 */
import { KIND_LABELS } from '../../lib/constants.js';

const sum = (rows, f) => rows.reduce((acc, r) => acc + f(r), 0);
const sats = (msats) => Math.floor(msats / 1000);
const month = (at) => new Date(at * 1000).toISOString().slice(0, 7);
/** Byte-order string comparison, matching SQLite's default collation for tie-breaks. */
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Rolling ranking windows accepted by the `period` parameter, in seconds. */
export const PERIODS = { today: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };

/** Unix time a ranking window starts at; 0 (all time) for an unknown or empty period. */
export const periodStart = (period) => (PERIODS[period] ? Math.floor(Date.now() / 1000) - PERIODS[period] : 0);

/** Purchases of one release, limited to those made at or after `since`. */
const boughtSince = (model, address, since) => (model.purchasesByAddress.get(address) || []).filter((p) => !since || p.at >= since);

/** Whether a release is listed: never when deleted, test content only on request. */
const visible = (c, includeTest) => Boolean(c) && !c.deleted && (includeTest || !c.meta.isTest);

/** Shapes a profile (or its absence) into the person object the UI uses. */
export function person(model, pubkey) {
  const p = model.profiles.get(pubkey);
  return { pubkey, name: p?.displayName || p?.name || '', picture: p?.picture || '', nip05: p?.nip05 || '', lud16: p?.lud16 || '' };
}

/** Sales, earnings and engagement counts for one release address. */
function statsFor(model, address, since = 0) {
  const bought = boughtSince(model, address, since);
  const eng = model.engagement.get(address) || { comments: 0, reactions: 0, reposts: 0 };
  return {
    sales: bought.length,
    earnedSats: sats(sum(bought, (p) => p.msats)),
    zaps: (model.paymentsByAddress.get(address) || []).length,
    comments: eng.comments,
    reactions: eng.reactions,
    reposts: eng.reposts
  };
}

/** Shapes a content entry into a release card; `since` limits sales stats to a ranking window. */
function card(model, c, since = 0) {
  const m = c.meta;
  return {
    address: c.address, eventId: c.eventId, kind: c.kind, kindLabel: KIND_LABELS[c.kind],
    title: m.title, summary: m.summary, cover: m.cover, previewUrl: m.previewUrl, durationSec: m.durationSec,
    parts: m.parts, topics: m.topics, priceSats: m.priceSats, env: m.env, isTest: m.isTest,
    publishedAt: c.firstPublished, updatedAt: c.createdAt, revisions: c.revisions,
    author: person(model, c.pubkey), stats: statsFor(model, c.address, since)
  };
}

/** Purchases (or payments) whose release is currently listed. */
const visiblePurchases = (model, includeTest) => model.purchases.filter((p) => visible(model.contents.get(p.address), includeTest));

/** Archive-wide totals and monthly series for the overview page. */
export function overview(model, { includeTest }) {
  const releases = [...model.contents.values()].filter((c) => visible(c, includeTest));
  const bought = visiblePurchases(model, includeTest);
  const paid = model.payments.filter((p) => visible(model.contents.get(p.address), includeTest));
  const byKind = new Map();
  for (const c of releases) byKind.set(c.kind, (byKind.get(c.kind) || 0) + 1);
  const salesByMonth = new Map();
  for (const p of bought) {
    if (p.at <= 0) continue;
    const m = salesByMonth.get(month(p.at)) || { month: month(p.at), sales: 0, msats: 0 };
    m.sales++; m.msats += p.msats;
    salesByMonth.set(m.month, m);
  }
  const releasesByMonth = new Map();
  for (const c of releases) releasesByMonth.set(month(c.firstPublished), (releasesByMonth.get(month(c.firstPublished)) || 0) + 1);
  const countRole = (role) => model.index.filter((e) => e.role === role).length;
  return {
    releases: releases.length,
    creators: new Set(releases.map((c) => c.pubkey)).size,
    sales: bought.length,
    verifiedSales: bought.filter((p) => p.source === 'verified').length,
    buyers: new Set(bought.map((p) => p.buyer)).size,
    salesSats: sats(sum(bought, (p) => p.msats)),
    payments: paid.length,
    paymentsSats: sats(sum(paid, (p) => p.msats)),
    cashuPayments: paid.filter((p) => p.rail === 'cashu').length,
    byKind: [...byKind].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, label: KIND_LABELS[kind], count })),
    monthly: [...salesByMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ month: m.month, sales: m.sales, sats: sats(m.msats) })),
    releasesMonthly: [...releasesByMonth].sort((a, b) => a[0].localeCompare(b[0])).map(([m, n]) => ({ month: m, n })),
    archive: {
      events: model.index.length, profiles: model.profiles.size, wallets: model.wallets.size,
      comments: countRole('comment'), reactions: countRole('reaction')
    }
  };
}

/** Whether a release matches a free-text search over its text and its author's names. */
function matches(model, c, q) {
  const p = model.profiles.get(c.pubkey);
  const hay = [c.meta.title, c.meta.summary, c.meta.kindLabel, ...c.meta.topics, p?.name, p?.displayName, p?.nip05].join('\n').toLowerCase();
  return hay.includes(q.toLowerCase());
}

/** Sort comparators for release listings; ties fall back to newest first. */
function releaseOrder(model, sort, since) {
  const newest = (a, b) => b.firstPublished - a.firstPublished || byKey(a.address, b.address);
  const count = (c) => boughtSince(model, c.address, since).length;
  const earned = (c) => sum(boughtSince(model, c.address, since), (p) => p.msats);
  return {
    oldest: (a, b) => a.firstPublished - b.firstPublished || byKey(a.address, b.address),
    sales: (a, b) => count(b) - count(a) || newest(a, b),
    earned: (a, b) => earned(b) - earned(a) || newest(a, b),
    price: (a, b) => b.meta.priceSats - a.meta.priceSats || newest(a, b)
  }[sort] || newest;
}

/**
 * Release listing with search, kind and creator filters, sort and paging.
 * With a `period`, sales rankings count only purchases in that window (and
 * list only releases that sold in it); other sorts list releases published in it.
 */
export function listReleases(model, { q, kind, creator, sort, period, limit, offset, includeTest }) {
  const since = periodStart(period);
  const bySales = sort === 'sales' || sort === 'earned';
  const inWindow = (c) => !since || (bySales ? boughtSince(model, c.address, since).length > 0 : c.firstPublished >= since);
  const rows = [...model.contents.values()]
    .filter((c) => visible(c, includeTest) && (!kind || c.kind === kind) && (!creator || c.pubkey === creator) && (!q || matches(model, c, q)) && inWindow(c))
    .sort(releaseOrder(model, sort, since));
  return { total: rows.length, items: rows.slice(offset, offset + limit).map((c) => card(model, c, since)) };
}

/** One release by address or any revision id, with buyers, payments, comments and the raw event. */
export function getRelease(model, ref) {
  const c = model.contents.get(ref) || model.contents.get(model.idToAddress.get(ref));
  if (!c) return null;
  const bought = [...(model.purchasesByAddress.get(c.address) || [])].sort((a, b) => b.at - a.at);
  const paid = [...(model.paymentsByAddress.get(c.address) || [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  const comments = [...(model.commentsByAddress.get(c.address) || [])].sort((a, b) => a.createdAt - b.createdAt).slice(0, 200);
  return {
    ...card(model, c),
    splits: c.meta.splits.map((s) => ({ ...person(model, s.pubkey), weight: s.weight })),
    buyers: bought.map((p) => ({ ...person(model, p.buyer), source: p.source, sats: sats(p.msats), at: p.at, rail: p.rail })),
    payments: paid.map((p) => ({
      id: p.eventId, rail: p.rail, sats: sats(p.msats), at: p.createdAt, comment: p.comment, mint: p.mint,
      sender: person(model, p.sender), recipient: person(model, p.recipient)
    })),
    comments: comments.map((x) => ({ id: x.id, at: x.createdAt, text: x.text, author: person(model, x.pubkey) })),
    event: c.event
  };
}

/**
 * Creators ranked by earnings from their listed releases. With a `period`,
 * earnings, sales and buyers count only that window, and only creators who
 * sold something in it are listed.
 */
export function listCreators(model, { q, sort, period, limit, offset, includeTest }) {
  const needle = (q || '').toLowerCase();
  const since = periodStart(period);
  const byCreator = new Map();
  for (const c of model.contents.values()) {
    if (!visible(c, includeTest)) continue;
    const g = byCreator.get(c.pubkey) || { releases: 0, latest: 0, first: Infinity, bought: [] };
    g.releases++;
    g.latest = Math.max(g.latest, c.firstPublished);
    g.first = Math.min(g.first, c.firstPublished);
    g.bought.push(...boughtSince(model, c.address, since));
    byCreator.set(c.pubkey, g);
  }
  const rows = [...byCreator].filter(([pk, g]) => {
    if (since && !g.bought.length) return false;
    if (!needle) return true;
    const p = model.profiles.get(pk);
    return pk === q || [p?.name, p?.displayName, p?.nip05].some((v) => (v || '').toLowerCase().includes(needle));
  }).map(([pk, g]) => ({
    pk, releases: g.releases, latest: g.latest, first: g.first,
    earned: sats(sum(g.bought, (p) => p.msats)), sales: g.bought.length, buyers: new Set(g.bought.map((p) => p.buyer)).size,
    followers: model.followers.get(pk) || 0
  }));
  const order = {
    releases: (a, b) => b.releases - a.releases,
    newest: (a, b) => b.latest - a.latest,
    buyers: (a, b) => b.buyers - a.buyers
  }[sort] || ((a, b) => b.earned - a.earned || b.releases - a.releases);
  // Ties fall back to the most recently active creator, then pubkey, so pages never shuffle.
  rows.sort((a, b) => order(a, b) || b.latest - a.latest || byKey(a.pk, b.pk));
  return {
    total: rows.length,
    items: rows.slice(offset, offset + limit).map((r) => ({
      ...person(model, r.pk), about: model.profiles.get(r.pk)?.about || '',
      releases: r.releases, sales: r.sales, buyers: r.buyers, earnedSats: r.earned,
      followers: r.followers, firstRelease: r.first, latestRelease: r.latest
    }))
  };
}

/** One person: profile, releases, collection, wallet and totals. */
export function getPerson(model, pubkey, { includeTest }) {
  const profile = model.profiles.get(pubkey);
  const releases = listReleases(model, { creator: pubkey, sort: 'newest', limit: 200, offset: 0, includeTest });
  const bought = (model.purchasesByBuyer.get(pubkey) || [])
    .filter((p) => model.contents.get(p.address) && !model.contents.get(p.address).deleted)
    .sort((a, b) => b.at - a.at).slice(0, 200);
  const ownSales = [...model.contents.values()].filter((c) => c.pubkey === pubkey)
    .flatMap((c) => model.purchasesByAddress.get(c.address) || []);
  const received = model.paymentsByRecipient.get(pubkey) || [];
  if (!profile && !releases.total && !bought.length && !received.length) return null;
  const wallet = model.wallets.get(pubkey);
  return {
    ...person(model, pubkey),
    about: profile?.about || '',
    banner: profile?.banner || '',
    website: profile?.website || '',
    releases: releases.items,
    purchases: bought.map((p) => ({ ...card(model, model.contents.get(p.address)), paidSats: sats(p.msats), boughtAt: p.at, source: p.source })),
    wallet: wallet ? { mints: wallet.mints, updatedAt: wallet.createdAt } : null,
    stats: {
      releases: releases.total,
      sales: ownSales.length,
      earnedSats: sats(sum(ownSales, (p) => p.msats)),
      paymentsReceived: received.length,
      receivedSats: sats(sum(received, (p) => p.msats)),
      purchases: bought.length,
      spentSats: sats(sum(model.purchasesByBuyer.get(pubkey) || [], (p) => p.msats)),
      followers: model.followers.get(pubkey) || 0,
      following: model.following.get(pubkey) || 0
    }
  };
}

/** Buyers ranked by sats spent on listed releases, optionally within a `period`. */
export function listSupporters(model, { period, limit, offset, includeTest }) {
  const since = periodStart(period);
  const byBuyer = new Map();
  for (const p of visiblePurchases(model, includeTest)) {
    if (since && p.at < since) continue;
    const g = byBuyer.get(p.buyer) || { buyer: p.buyer, purchases: 0, msats: 0, creators: new Set(), latest: 0 };
    g.purchases++;
    g.msats += p.msats;
    g.creators.add(model.contents.get(p.address).pubkey);
    g.latest = Math.max(g.latest, p.at);
    byBuyer.set(p.buyer, g);
  }
  const rows = [...byBuyer.values()]
    .sort((a, b) => sats(b.msats) - sats(a.msats) || b.purchases - a.purchases || b.latest - a.latest || byKey(a.buyer, b.buyer));
  return {
    total: rows.length,
    items: rows.slice(offset, offset + limit).map((g) => ({
      ...person(model, g.buyer), purchases: g.purchases, spentSats: sats(g.msats), creators: g.creators.size, latest: g.latest
    }))
  };
}

/** Most recent sales, comments and releases across listed releases, newest first. */
export function activity(model, { limit, includeTest }) {
  const items = [];
  for (const p of visiblePurchases(model, includeTest)) {
    if (p.at > 0) items.push({ type: 'sale', actor: p.buyer, address: p.address, msats: p.msats, at: p.at, rail: p.rail, source: p.source });
  }
  for (const c of model.comments) {
    for (const a of c.addresses) {
      if (visible(model.contents.get(a), includeTest)) items.push({ type: 'comment', actor: c.pubkey, address: a, msats: 0, at: c.createdAt, rail: '', source: '' });
    }
  }
  for (const c of model.contents.values()) {
    if (visible(c, includeTest)) items.push({ type: 'release', actor: c.pubkey, address: c.address, msats: c.meta.priceSats * 1000, at: c.firstPublished, rail: '', source: '' });
  }
  items.sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const r of items) {
    const key = `${r.type}|${r.actor}|${r.address}|${r.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = model.contents.get(r.address);
    out.push({
      type: r.type, at: r.at, sats: sats(r.msats), rail: r.rail, source: r.source, actor: person(model, r.actor),
      release: { address: r.address, title: c.meta.title, kind: c.kind, cover: c.meta.cover, kindLabel: KIND_LABELS[c.kind] }
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Ids of raw events matching NIP-01-style filters, newest first. The caller
 * loads the signed JSON by primary key, so a request reads only `limit` rows.
 */
export function rawEventIds(model, { role, kind, author, since, until, limit }) {
  const ids = [];
  for (const e of model.index) {
    if ((role && e.role !== role) || (kind !== undefined && e.kind !== kind) || (author && e.pubkey !== author)
      || (since && e.createdAt < since) || (until && e.createdAt > until)) continue;
    ids.push(e.id);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** Event counts and newest timestamp per role, for the Live page. */
export function roleCounts(model) {
  const roles = new Map();
  for (const e of model.index) {
    const r = roles.get(e.role) || { role: e.role, n: 0, newest: 0 };
    r.n++;
    r.newest = Math.max(r.newest, e.createdAt);
    roles.set(e.role, r);
  }
  return [...roles.values()].sort((a, b) => b.n - a.n);
}
