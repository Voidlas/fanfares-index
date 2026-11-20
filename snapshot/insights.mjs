/**
 * Insights: trends and breakdowns for the explorer's Insights page and the
 * overview, computed from the read model (worker/src/model.js) at build time.
 * Everything derives from timestamps already in the archive, so the full
 * history is available from the first build.
 *
 * One answer per rolling window (INSIGHT_PERIODS) and variant (with/without
 * test releases). Each compares the window with the one just before it,
 * except all time.
 */
import { KIND_LABELS } from '../lib/constants.js';
import { person } from '../worker/src/queries.js';

const DAY = 86400;
/** Rolling windows, in days; `all` has no start and nothing to compare with. */
export const INSIGHT_PERIODS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365, all: null };
export const DEFAULT_INSIGHT_PERIOD = '30d';

const sats = (msats) => Math.floor(msats / 1000);
const month = (at) => new Date(at * 1000).toISOString().slice(0, 7);
const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
const TOP = 8;

/** Price bands, in sats, that the price-point breakdown groups releases into. */
const PRICE_BANDS = [
  ['Free', 0, 0], ['1–100', 1, 100], ['101–1,000', 101, 1000], ['1,001–5,000', 1001, 5000], ['Over 5,000', 5001, Infinity]
];
/** Buyer loyalty bands: how many purchases each buyer made in the window. */
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

/** Groups rows into a Map by `key`, accumulating with `add` into `init()`. */
function groupBy(rows, key, init, add) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    const v = m.get(k) || init();
    add(v, r);
    m.set(k, v);
  }
  return m;
}

/**
 * Precomputes what every window shares, then answers each period from it.
 * @param {object} model Read model from buildModel.
 * @param {{includeTest: boolean, now: number}} opts `now` in unix seconds (the build time).
 * @returns {Record<string, object>} One insights object per INSIGHT_PERIODS key.
 */
export function insightsByPeriod(model, { includeTest, now }) {
  const visible = (c) => Boolean(c) && !c.deleted && (includeTest || !c.meta.isTest);
  const releases = [...model.contents.values()].filter(visible);
  const purchases = model.purchases.filter((p) => visible(model.contents.get(p.address)));
  const dated = purchases.filter((p) => p.at > 0);
  const payments = model.payments.filter((p) => visible(model.contents.get(p.address)));
  const creatorOf = (address) => model.contents.get(address).pubkey;

  // First purchase per buyer and first release per creator, for "new" counts.
  const firstBuy = new Map();
  for (const p of dated) if (!firstBuy.has(p.buyer) || p.at < firstBuy.get(p.buyer)) firstBuy.set(p.buyer, p.at);
  const firstRelease = new Map();
  for (const c of releases) if (!firstRelease.has(c.pubkey) || c.firstPublished < firstRelease.get(c.pubkey)) firstRelease.set(c.pubkey, c.firstPublished);

  // Monthly series from the first dated activity to this month (the same for every window).
  const blank = () => ({ sats: 0, sales: 0, newBuyers: 0, newCreators: 0, releases: 0 });
  const byMonth = new Map();
  const bump = (at, key, n = 1) => {
    const m = byMonth.get(month(at)) || blank();
    m[key] += n;
    byMonth.set(month(at), m);
  };
  for (const p of dated) { bump(p.at, 'sales'); bump(p.at, 'sats', p.msats); }
  for (const at of firstBuy.values()) bump(at, 'newBuyers');
  for (const at of firstRelease.values()) bump(at, 'newCreators');
  for (const c of releases) bump(c.firstPublished, 'releases');
  const keys = [...byMonth.keys()].sort();
  const monthly = keys.length ? monthsBetween(keys[0], month(now)).map((m) => {
    const v = byMonth.get(m) || blank();
    return { month: m, sats: sats(v.sats), sales: v.sales, newBuyers: v.newBuyers, newCreators: v.newCreators, releases: v.releases };
  }) : [];
  let firstActivity = now;
  for (const p of dated) firstActivity = Math.min(firstActivity, p.at);
  for (const c of releases) firstActivity = Math.min(firstActivity, c.firstPublished);

  /** Headline numbers between two unix times (`from` 0 = all time, undated purchases included). */
  const stats = (from, to) => {
    const inRange = (t) => t >= from && t < to;
    const bought = from ? dated.filter((p) => inRange(p.at)) : purchases;
    return {
      sats: sats(sum(bought, (p) => p.msats)),
      sales: bought.length,
      buyers: new Set(bought.map((p) => p.buyer)).size,
      creatorsPaid: new Set(bought.map((p) => creatorOf(p.address))).size,
      newBuyers: [...firstBuy.values()].filter(inRange).length,
      newCreators: [...firstRelease.values()].filter(inRange).length,
      releases: releases.filter((c) => inRange(c.firstPublished)).length
    };
  };

  const answer = (period, days) => {
    const from = days ? now - days * DAY : 0;
    const bought = from ? dated.filter((p) => p.at >= from) : purchases;
    const paid = from ? payments.filter((p) => p.createdAt >= from) : payments;
    const current = stats(from, now + 1);
    const previous = days ? stats(from - days * DAY, from) : null;

    // Price points: every listed release in its band, and what it sold in the window.
    const salesOf = groupBy(bought, (p) => p.address, () => ({ sales: 0, msats: 0 }), (v, p) => { v.sales++; v.msats += p.msats; });
    const soldOf = (c) => salesOf.get(c.address) || { sales: 0, msats: 0 };
    const priceBands = PRICE_BANDS.map(([label, lo, hi]) => {
      const sold = releases.filter((c) => c.meta.priceSats >= lo && c.meta.priceSats <= hi).map(soldOf);
      return {
        label, releases: sold.length, sales: sum(sold, (s) => s.sales), sats: sats(sum(sold, (s) => s.msats)),
        sellingReleases: sold.filter((s) => s.sales > 0).length
      };
    });

    const rails = ['lightning', 'cashu'].map((rail) => {
      const legs = paid.filter((p) => p.rail === rail);
      return { rail, label: rail === 'lightning' ? 'Lightning' : 'Cashu', payments: legs.length, sats: sats(sum(legs, (p) => p.msats)) };
    });
    const kinds = [...new Set(releases.map((c) => c.kind))].map((kind) => {
      const sold = releases.filter((c) => c.kind === kind).map(soldOf);
      return { kind, label: KIND_LABELS[kind] || String(kind), releases: sold.length, sales: sum(sold, (s) => s.sales), sats: sats(sum(sold, (s) => s.msats)) };
    }).sort((a, b) => b.sats - a.sats || b.sales - a.sales);

    const perBuyer = groupBy(bought, (p) => p.buyer, () => ({ n: 0 }), (v) => { v.n++; });
    const counts = [...perBuyer.values()].map((v) => v.n);
    const repeat = REPEAT_BANDS.map(([label, lo, hi]) => ({ label, buyers: counts.filter((n) => n >= lo && n <= hi).length }));

    const rank = (m) => [...m].sort((a, b) => b[1].msats - a[1].msats || b[1].sales - a[1].sales || (a[0] < b[0] ? -1 : 1));
    const acc = () => ({ sales: 0, msats: 0, buyers: new Set() });
    const add = (v, p) => { v.sales++; v.msats += p.msats; v.buyers.add(p.buyer); };
    const creators = rank(groupBy(bought, (p) => creatorOf(p.address), acc, add));
    const total = sum(creators, ([, v]) => v.msats) || 1;

    return {
      builtAt: now,
      period,
      days,
      since: from || firstActivity,
      current,
      previous,
      repeatBuyers: counts.filter((n) => n > 1).length,
      concentration: {
        topCreatorShare: creators.length ? creators[0][1].msats / total : 0,
        top5Share: sum(creators.slice(0, 5), ([, v]) => v.msats) / total
      },
      monthly,
      priceBands,
      rails,
      kinds,
      repeat,
      topReleases: rank(groupBy(bought, (p) => p.address, acc, add)).slice(0, TOP).map(([address, v]) => {
        const c = model.contents.get(address);
        return {
          address, title: c.meta.title, cover: c.meta.cover, kind: c.kind, kindLabel: KIND_LABELS[c.kind],
          author: person(model, c.pubkey), sales: v.sales, sats: sats(v.msats), buyers: v.buyers.size
        };
      }),
      topCreators: creators.slice(0, TOP).map(([pubkey, v]) => ({
        ...person(model, pubkey), sales: v.sales, sats: sats(v.msats), buyers: v.buyers.size
      })),
      // Biggest supporters: `buyers` here counts the distinct creators they paid.
      topBuyers: rank(groupBy(bought, (p) => p.buyer, acc, (v, p) => { v.sales++; v.msats += p.msats; v.buyers.add(creatorOf(p.address)); }))
        .slice(0, TOP).map(([pubkey, v]) => ({ ...person(model, pubkey), purchases: v.sales, sats: sats(v.msats), creators: v.buyers.size }))
    };
  };

  return Object.fromEntries(Object.entries(INSIGHT_PERIODS).map(([period, days]) => [period, answer(period, days)]));
}
