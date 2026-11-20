/**
 * Insights: trends and breakdowns for the explorer's Insights page, computed
 * from the read model (worker/src/model.js) at build time. Everything here
 * derives from timestamps already in the archive, so the full history is
 * available from the first build.
 *
 * Pure: called by snapshot/build.mjs once per variant (with/without test releases).
 */
import { KIND_LABELS } from '../lib/constants.js';
import { person } from '../worker/src/queries.js';

const DAY = 86400;
const WINDOW_DAYS = 30;
const sats = (msats) => Math.floor(msats / 1000);
const month = (at) => new Date(at * 1000).toISOString().slice(0, 7);
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);

/** Price bands, in sats, that the price-point breakdown groups releases into. */
const PRICE_BANDS = [
  ['Free', 0, 0], ['1–100', 1, 100], ['101–1,000', 101, 1000], ['1,001–5,000', 1001, 5000], ['Over 5,000', 5001, Infinity]
];
/** Buyer loyalty bands: how many purchases each buyer made. */
const REPEAT_BANDS = [['1 purchase', 1, 1], ['2', 2, 2], ['3–5', 3, 5], ['6–10', 6, 10], ['11 or more', 11, Infinity]];

/** Every month from `first` to `last` ("YYYY-MM"), so gaps show as empty bars. */
function monthsBetween(first, last) {
  const out = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * @param {object} model Read model from buildModel.
 * @param {{includeTest: boolean, now: number}} opts `now` in unix seconds (the build time).
 */
export function insights(model, { includeTest, now }) {
  const visible = (c) => Boolean(c) && !c.deleted && (includeTest || !c.meta.isTest);
  const releases = [...model.contents.values()].filter(visible);
  const purchases = model.purchases.filter((p) => visible(model.contents.get(p.address)));
  const dated = purchases.filter((p) => p.at > 0);
  const payments = model.payments.filter((p) => visible(model.contents.get(p.address)));

  // First purchase per buyer and first release per creator, for "new" counts.
  const firstBuy = new Map();
  for (const p of dated) if (!firstBuy.has(p.buyer) || p.at < firstBuy.get(p.buyer)) firstBuy.set(p.buyer, p.at);
  const firstRelease = new Map();
  for (const c of releases) if (!firstRelease.has(c.pubkey) || c.firstPublished < firstRelease.get(c.pubkey)) firstRelease.set(c.pubkey, c.firstPublished);

  /** Activity between two unix times. */
  const window = (from, to) => {
    const inRange = (t) => t >= from && t < to;
    const bought = dated.filter((p) => inRange(p.at));
    return {
      sats: sats(sum(bought, (p) => p.msats)),
      sales: bought.length,
      buyers: new Set(bought.map((p) => p.buyer)).size,
      newBuyers: [...firstBuy.values()].filter(inRange).length,
      newCreators: [...firstRelease.values()].filter(inRange).length,
      releases: releases.filter((c) => inRange(c.firstPublished)).length
    };
  };
  const recentStart = now - WINDOW_DAYS * DAY;

  // Monthly series from the first dated activity to this month.
  const byMonth = new Map();
  const bump = (at, key, n = 1) => {
    const m = byMonth.get(month(at)) || { sats: 0, sales: 0, newBuyers: 0, newCreators: 0, releases: 0 };
    m[key] += n;
    byMonth.set(month(at), m);
  };
  for (const p of dated) { bump(p.at, 'sales'); bump(p.at, 'sats', p.msats); }
  for (const at of firstBuy.values()) bump(at, 'newBuyers');
  for (const at of firstRelease.values()) bump(at, 'newCreators');
  for (const c of releases) bump(c.firstPublished, 'releases');
  const keys = [...byMonth.keys()].sort();
  const monthly = keys.length ? monthsBetween(keys[0], month(now)).map((m) => {
    const v = byMonth.get(m) || { sats: 0, sales: 0, newBuyers: 0, newCreators: 0, releases: 0 };
    return { month: m, sats: sats(v.sats), sales: v.sales, newBuyers: v.newBuyers, newCreators: v.newCreators, releases: v.releases };
  }) : [];

  // Price points: how many releases sit in each band and how they sell.
  const salesOf = new Map();
  for (const p of purchases) {
    const s = salesOf.get(p.address) || { sales: 0, msats: 0 };
    s.sales++; s.msats += p.msats;
    salesOf.set(p.address, s);
  }
  const priceBands = PRICE_BANDS.map(([label, lo, hi]) => {
    const inBand = releases.filter((c) => c.meta.priceSats >= lo && c.meta.priceSats <= hi);
    const sold = inBand.map((c) => salesOf.get(c.address) || { sales: 0, msats: 0 });
    return {
      label, releases: inBand.length, sales: sum(sold, (s) => s.sales), sats: sats(sum(sold, (s) => s.msats)),
      sellingReleases: sold.filter((s) => s.sales > 0).length
    };
  });

  // Payment rails and release formats.
  const rails = ['lightning', 'cashu'].map((rail) => {
    const legs = payments.filter((p) => p.rail === rail);
    return { label: rail === 'lightning' ? 'Lightning' : 'Cashu', payments: legs.length, sats: sats(sum(legs, (p) => p.msats)) };
  });
  const kinds = [...new Set(releases.map((c) => c.kind))].map((kind) => {
    const ofKind = releases.filter((c) => c.kind === kind);
    const sold = ofKind.map((c) => salesOf.get(c.address) || { sales: 0, msats: 0 });
    return { kind, label: KIND_LABELS[kind] || String(kind), releases: ofKind.length, sales: sum(sold, (s) => s.sales), sats: sats(sum(sold, (s) => s.msats)) };
  }).sort((a, b) => b.sats - a.sats || b.sales - a.sales);

  // Loyalty: purchases per buyer.
  const perBuyer = new Map();
  for (const p of purchases) perBuyer.set(p.buyer, (perBuyer.get(p.buyer) || 0) + 1);
  const repeat = REPEAT_BANDS.map(([label, lo, hi]) => ({ label, buyers: [...perBuyer.values()].filter((n) => n >= lo && n <= hi).length }));

  // Concentration: share of all sats earned by the top creators.
  const byCreator = new Map();
  for (const p of purchases) {
    const pk = model.contents.get(p.address).pubkey;
    byCreator.set(pk, (byCreator.get(pk) || 0) + p.msats);
  }
  const ranked = [...byCreator.values()].sort((a, b) => b - a);
  const total = sum(ranked, (v) => v) || 1;

  // Last 30 days: what sold and who earned.
  const recent = dated.filter((p) => p.at >= recentStart);
  const recentBy = (key) => {
    const m = new Map();
    for (const p of recent) {
      const k = key(p);
      const v = m.get(k) || { sales: 0, msats: 0, buyers: new Set() };
      v.sales++; v.msats += p.msats; v.buyers.add(p.buyer);
      m.set(k, v);
    }
    return [...m].sort((a, b) => b[1].msats - a[1].msats || b[1].sales - a[1].sales).slice(0, 8);
  };
  const topReleases = recentBy((p) => p.address).map(([address, v]) => {
    const c = model.contents.get(address);
    return {
      address, title: c.meta.title, cover: c.meta.cover, kind: c.kind, kindLabel: KIND_LABELS[c.kind],
      author: person(model, c.pubkey), sales: v.sales, sats: sats(v.msats)
    };
  });
  const topCreators = recentBy((p) => model.contents.get(p.address).pubkey).map(([pubkey, v]) => ({
    ...person(model, pubkey), sales: v.sales, sats: sats(v.msats), buyers: v.buyers.size
  }));

  return {
    builtAt: now,
    windowDays: WINDOW_DAYS,
    recent: window(recentStart, now + 1),
    previous: window(recentStart - WINDOW_DAYS * DAY, recentStart),
    totals: {
      sats: sats(sum(purchases, (p) => p.msats)), sales: purchases.length, buyers: perBuyer.size,
      creatorsPaid: byCreator.size, releases: releases.length,
      repeatBuyers: [...perBuyer.values()].filter((n) => n > 1).length
    },
    concentration: {
      topCreatorShare: (ranked[0] || 0) / total,
      top5Share: sum(ranked.slice(0, 5), (v) => v) / total
    },
    monthly,
    priceBands,
    rails,
    kinds,
    repeat,
    topReleases,
    topCreators
  };
}
