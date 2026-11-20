/**
 * Read-side queries behind the HTTP API. Each function takes the open archive
 * plus already-validated parameters from server.js and returns plain JSON.
 * All aggregation happens in SQL over the derived tables built by db.js.
 */
import { KIND_LABELS } from './constants.js';

/** Shared SQL fragment: hide deleted content, and test content unless asked. */
function visibility(includeTest) {
  return includeTest ? 'c.deleted = 0' : 'c.deleted = 0 AND c.is_test = 0';
}

/** Loads profile rows for a set of pubkeys into a lookup map. */
function profileMap(db, pubkeys) {
  const keys = [...new Set(pubkeys.filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = db.prepare(`SELECT * FROM profiles WHERE pubkey IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const r of rows) map.set(r.pubkey, r);
  }
  return map;
}

/** Shapes a profile row (or its absence) into the person object the UI uses. */
export function person(pubkey, row) {
  return {
    pubkey,
    name: row?.display_name || row?.name || '',
    picture: row?.picture || '',
    nip05: row?.nip05 || '',
    lud16: row?.lud16 || ''
  };
}

/** Engagement and sales counts per address, for a list of addresses. */
function statsFor(db, addresses) {
  const map = new Map(addresses.map((a) => [a, { sales: 0, earnedSats: 0, zaps: 0, comments: 0, reactions: 0, reposts: 0 }]));
  if (!addresses.length) return map;
  const ph = addresses.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT address, COUNT(*) n, SUM(amount_msats) m FROM purchases WHERE address IN (${ph}) GROUP BY address`).all(...addresses)) {
    Object.assign(map.get(r.address), { sales: r.n, earnedSats: Math.floor(r.m / 1000) });
  }
  for (const r of db.prepare(`SELECT address, COUNT(*) n FROM payments WHERE address IN (${ph}) GROUP BY address`).all(...addresses)) {
    map.get(r.address).zaps = r.n;
  }
  // Engagement may point at the address or at a specific revision id; map
  // both back to the address and count each engaging event once.
  const toAddress = new Map(addresses.map((a) => [a, a]));
  for (const r of db.prepare(`SELECT id, address FROM events WHERE role = 'content' AND address IN (${ph})`).all(...addresses)) {
    toAddress.set(r.id, r.address);
  }
  const targets = [...toAddress.keys()];
  const seen = new Set();
  const key = { comment: 'comments', reaction: 'reactions', repost: 'reposts' };
  const eng = db.prepare(`SELECT r.value, e.id, e.role FROM event_refs r JOIN events e ON e.id = r.event_id
    WHERE r.tag IN ('a','e','A','E') AND r.value IN (${targets.map(() => '?').join(',')})
    AND e.role IN ('comment','reaction','repost')`).all(...targets);
  for (const r of eng) {
    const address = toAddress.get(r.value);
    if (seen.has(`${address}|${r.id}`)) continue;
    seen.add(`${address}|${r.id}`);
    map.get(address)[key[r.role]]++;
  }
  return map;
}

/** Shapes content rows into release cards with author and stats attached. */
function releases(db, rows) {
  const profiles = profileMap(db, rows.map((r) => r.pubkey));
  const stats = statsFor(db, rows.map((r) => r.address));
  return rows.map((r) => {
    const meta = JSON.parse(r.meta_json);
    return {
      address: r.address,
      eventId: r.event_id,
      kind: r.kind,
      kindLabel: KIND_LABELS[r.kind],
      title: r.title,
      summary: meta.summary,
      cover: meta.cover,
      previewUrl: meta.previewUrl,
      durationSec: meta.durationSec,
      parts: meta.parts,
      topics: meta.topics,
      priceSats: r.price_sats,
      env: r.env,
      isTest: Boolean(r.is_test),
      publishedAt: r.first_published,
      updatedAt: r.created_at,
      revisions: r.revisions,
      author: person(r.pubkey, profiles.get(r.pubkey)),
      stats: stats.get(r.address)
    };
  });
}

/**
 * Archive-wide totals for the overview page.
 * @param {object} opts.includeTest Whether staging/test releases count.
 */
export function overview(db, { includeTest }) {
  const vis = visibility(includeTest);
  const one = (sql) => db.prepare(sql).get();
  const totals = one(`SELECT COUNT(*) releases, COUNT(DISTINCT pubkey) creators FROM content c WHERE ${vis}`);
  const sales = one(`SELECT COUNT(*) sales, COUNT(DISTINCT buyer) buyers, COALESCE(SUM(amount_msats),0) msats,
      SUM(source = 'verified') verified FROM purchases p JOIN content c USING(address) WHERE ${vis}`);
  const pay = one(`SELECT COUNT(*) n, COALESCE(SUM(amount_msats),0) msats, SUM(rail = 'cashu') cashu
      FROM payments p JOIN content c USING(address) WHERE ${vis}`);
  const byKind = db.prepare(`SELECT kind, COUNT(*) n FROM content c WHERE ${vis} GROUP BY kind ORDER BY n DESC`).all()
    .map((r) => ({ kind: r.kind, label: KIND_LABELS[r.kind], count: r.n }));
  const monthly = db.prepare(`SELECT strftime('%Y-%m', p.purchased_at, 'unixepoch') month, COUNT(*) sales,
      SUM(p.amount_msats) / 1000 sats FROM purchases p JOIN content c USING(address)
      WHERE ${vis} AND p.purchased_at > 0 GROUP BY month ORDER BY month`).all();
  const releasesMonthly = db.prepare(`SELECT strftime('%Y-%m', first_published, 'unixepoch') month, COUNT(*) n
      FROM content c WHERE ${vis} GROUP BY month ORDER BY month`).all();
  const counts = one(`SELECT (SELECT COUNT(*) FROM events) events, (SELECT COUNT(*) FROM profiles) profiles,
      (SELECT COUNT(*) FROM wallets) wallets, (SELECT COUNT(*) FROM events WHERE role = 'comment') comments,
      (SELECT COUNT(*) FROM events WHERE role = 'reaction') reactions`);
  return {
    releases: totals.releases,
    creators: totals.creators,
    sales: sales.sales,
    verifiedSales: sales.verified || 0,
    buyers: sales.buyers,
    salesSats: Math.floor(sales.msats / 1000),
    payments: pay.n,
    paymentsSats: Math.floor(pay.msats / 1000),
    cashuPayments: pay.cashu || 0,
    byKind,
    monthly,
    releasesMonthly,
    archive: counts
  };
}

/**
 * Release listing with search, kind filter, creator filter, sort and paging.
 * @param {object} p Validated query parameters from server.js.
 */
export function listReleases(db, { q, kind, creator, sort, limit, offset, includeTest }) {
  const where = [visibility(includeTest)];
  const params = [];
  if (kind) { where.push('c.kind = ?'); params.push(kind); }
  if (creator) { where.push('c.pubkey = ?'); params.push(creator); }
  if (q) {
    where.push(`(c.title LIKE ? OR c.meta_json LIKE ? OR c.pubkey IN
      (SELECT pubkey FROM profiles WHERE name LIKE ? OR display_name LIKE ? OR nip05 LIKE ?))`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const order = {
    newest: 'c.first_published DESC, c.address',
    oldest: 'c.first_published ASC, c.address',
    sales: '(SELECT COUNT(*) FROM purchases p WHERE p.address = c.address) DESC, c.first_published DESC, c.address',
    earned: '(SELECT COALESCE(SUM(amount_msats),0) FROM purchases p WHERE p.address = c.address) DESC, c.first_published DESC, c.address',
    price: 'c.price_sats DESC, c.first_published DESC, c.address'
  }[sort] || 'c.first_published DESC, c.address';
  const sqlWhere = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM content c WHERE ${sqlWhere}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM content c WHERE ${sqlWhere} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, items: releases(db, rows) };
}

/** One release with its buyers, payment legs, comments and raw event. */
export function getRelease(db, address) {
  const row = db.prepare('SELECT * FROM content WHERE address = ? OR event_id = ?').get(address, address);
  if (!row) return null;
  const [release] = releases(db, [row]);
  const purchases = db.prepare('SELECT buyer, source, amount_msats, purchased_at, rail FROM purchases WHERE address = ? ORDER BY purchased_at DESC').all(row.address);
  const payments = db.prepare('SELECT event_id, rail, sender, recipient, amount_msats, created_at, comment, mint FROM payments WHERE address = ? ORDER BY created_at DESC LIMIT 200').all(row.address);
  const comments = db.prepare(`SELECT DISTINCT e.id, e.pubkey, e.created_at, e.json FROM event_refs r JOIN events e ON e.id = r.event_id
    WHERE r.value IN (?, ?) AND e.role = 'comment' ORDER BY e.created_at ASC LIMIT 200`).all(row.address, row.event_id);
  const profiles = profileMap(db, [...purchases.map((p) => p.buyer), ...payments.flatMap((p) => [p.sender, p.recipient]), ...comments.map((c) => c.pubkey)]);
  const raw = JSON.parse(db.prepare('SELECT json FROM events WHERE id = ?').get(row.event_id).json);
  return {
    ...release,
    splits: JSON.parse(row.meta_json).splits.map((s) => ({ ...person(s.pubkey, profiles.get(s.pubkey) || profileMap(db, [s.pubkey]).get(s.pubkey)), weight: s.weight })),
    buyers: purchases.map((p) => ({ ...person(p.buyer, profiles.get(p.buyer)), source: p.source, sats: Math.floor(p.amount_msats / 1000), at: p.purchased_at, rail: p.rail })),
    payments: payments.map((p) => ({
      id: p.event_id, rail: p.rail, sats: Math.floor(p.amount_msats / 1000), at: p.created_at, comment: p.comment, mint: p.mint,
      sender: person(p.sender, profiles.get(p.sender)), recipient: person(p.recipient, profiles.get(p.recipient))
    })),
    comments: comments.map((c) => ({ id: c.id, at: c.created_at, text: JSON.parse(c.json).content.slice(0, 2000), author: person(c.pubkey, profiles.get(c.pubkey)) })),
    event: raw
  };
}

/** Creators ranked by earnings from their listed releases, with release and buyer counts. */
export function listCreators(db, { q, sort, limit, offset, includeTest }) {
  const vis = visibility(includeTest);
  const where = q ? 'AND (pr.name LIKE ? OR pr.display_name LIKE ? OR pr.nip05 LIKE ? OR c.pubkey = ?)' : '';
  const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`, q] : [];
  // Ties fall back to the most recently active creator, then pubkey, so pages never shuffle.
  const order = `${{ releases: 'releases DESC', newest: 'latest DESC', buyers: 'buyers DESC', sales: 'sales DESC, earned DESC' }[sort] || 'earned DESC, releases DESC'}, latest DESC, c.pubkey`;
  const base = `FROM content c LEFT JOIN profiles pr ON pr.pubkey = c.pubkey WHERE ${vis} ${where}`;
  const total = db.prepare(`SELECT COUNT(DISTINCT c.pubkey) n ${base}`).get(...params).n;
  const rows = db.prepare(`SELECT c.pubkey, COUNT(*) releases, MAX(c.first_published) latest, MIN(c.first_published) first,
      (SELECT COALESCE(SUM(p.amount_msats),0) FROM purchases p JOIN content c2 USING(address) WHERE c2.pubkey = c.pubkey AND ${vis.replaceAll('c.', 'c2.')}) / 1000 earned,
      (SELECT COUNT(*) FROM purchases p JOIN content c2 USING(address) WHERE c2.pubkey = c.pubkey AND ${vis.replaceAll('c.', 'c2.')}) sales,
      (SELECT COUNT(DISTINCT p.buyer) FROM purchases p JOIN content c2 USING(address) WHERE c2.pubkey = c.pubkey AND ${vis.replaceAll('c.', 'c2.')}) buyers,
      (SELECT COUNT(*) FROM follows f WHERE f.followee = c.pubkey) followers
    ${base} GROUP BY c.pubkey ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const profiles = profileMap(db, rows.map((r) => r.pubkey));
  return {
    total,
    items: rows.map((r) => ({
      ...person(r.pubkey, profiles.get(r.pubkey)),
      about: profiles.get(r.pubkey)?.about || '',
      releases: r.releases, sales: r.sales, buyers: r.buyers, earnedSats: r.earned,
      followers: r.followers, firstRelease: r.first, latestRelease: r.latest
    }))
  };
}

/** One person: profile, releases, purchases, wallet info, follow counts. */
export function getPerson(db, pubkey, { includeTest }) {
  const profile = db.prepare('SELECT * FROM profiles WHERE pubkey = ?').get(pubkey);
  const releasesRes = listReleases(db, { creator: pubkey, sort: 'newest', limit: 200, offset: 0, includeTest });
  const bought = db.prepare(`SELECT c.*, p.amount_msats paid, p.purchased_at bought_at, p.source FROM purchases p JOIN content c USING(address)
    WHERE p.buyer = ? AND c.deleted = 0 ORDER BY p.purchased_at DESC LIMIT 200`).all(pubkey);
  const boughtCards = releases(db, bought).map((r, i) => ({ ...r, paidSats: Math.floor(bought[i].paid / 1000), boughtAt: bought[i].bought_at, source: bought[i].source }));
  const wallet = db.prepare('SELECT mints_json, created_at FROM wallets WHERE pubkey = ?').get(pubkey);
  const earned = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(p.amount_msats),0) m FROM purchases p JOIN content c USING(address) WHERE c.pubkey = ?').get(pubkey);
  const received = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount_msats),0) m FROM payments WHERE recipient = ?').get(pubkey);
  const spent = db.prepare('SELECT COALESCE(SUM(amount_msats),0) m FROM purchases WHERE buyer = ?').get(pubkey);
  const follows = db.prepare('SELECT (SELECT COUNT(*) FROM follows WHERE followee = ?) followers, (SELECT COUNT(*) FROM follows WHERE follower = ?) following').get(pubkey, pubkey);
  if (!profile && !releasesRes.total && !bought.length && !received.n) return null;
  return {
    ...person(pubkey, profile),
    about: profile?.about || '',
    banner: profile?.banner || '',
    website: profile?.website || '',
    releases: releasesRes.items,
    purchases: boughtCards,
    wallet: wallet ? { mints: JSON.parse(wallet.mints_json), updatedAt: wallet.created_at } : null,
    stats: {
      releases: releasesRes.total,
      sales: earned.n,
      earnedSats: Math.floor(earned.m / 1000),
      paymentsReceived: received.n,
      receivedSats: Math.floor(received.m / 1000),
      purchases: bought.length,
      spentSats: Math.floor(spent.m / 1000),
      followers: follows.followers,
      following: follows.following
    }
  };
}

/** Buyers ranked by total spent on Fanfares releases. */
export function listSupporters(db, { limit, offset, includeTest }) {
  const vis = visibility(includeTest);
  const total = db.prepare(`SELECT COUNT(DISTINCT buyer) n FROM purchases p JOIN content c USING(address) WHERE ${vis}`).get().n;
  const rows = db.prepare(`SELECT p.buyer, COUNT(*) purchases, SUM(p.amount_msats) / 1000 sats, COUNT(DISTINCT c.pubkey) creators,
      MAX(p.purchased_at) latest FROM purchases p JOIN content c USING(address) WHERE ${vis}
      GROUP BY p.buyer ORDER BY sats DESC, purchases DESC, latest DESC, p.buyer LIMIT ? OFFSET ?`).all(limit, offset);
  const profiles = profileMap(db, rows.map((r) => r.buyer));
  return {
    total,
    items: rows.map((r) => ({ ...person(r.buyer, profiles.get(r.buyer)), purchases: r.purchases, spentSats: r.sats, creators: r.creators, latest: r.latest }))
  };
}

/** Most recent sales and payments across the archive, newest first. */
export function activity(db, { limit, includeTest }) {
  const vis = visibility(includeTest);
  const rows = db.prepare(`SELECT 'sale' type, p.buyer actor, p.address, p.amount_msats msats, p.purchased_at at, p.rail, p.source
      FROM purchases p JOIN content c USING(address) WHERE ${vis} AND p.purchased_at > 0
    UNION ALL SELECT 'comment', e.pubkey, c.address, 0, e.created_at, '', '' FROM events e
      JOIN event_refs r ON r.event_id = e.id AND r.tag IN ('a','e','A')
      JOIN content c ON r.value IN (c.address, c.event_id) WHERE e.role = 'comment' AND ${vis}
    UNION ALL SELECT 'release', c.pubkey, c.address, c.price_sats * 1000, c.first_published, '', '' FROM content c WHERE ${vis}
    ORDER BY at DESC LIMIT ?`).all(limit);
  const seen = new Set();
  const unique = rows.filter((r) => { const k = `${r.type}|${r.actor}|${r.address}|${r.at}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const titles = new Map();
  const addrs = [...new Set(unique.map((r) => r.address))];
  if (addrs.length) {
    for (const c of db.prepare(`SELECT address, title, kind, meta_json FROM content WHERE address IN (${addrs.map(() => '?').join(',')})`).all(...addrs)) {
      titles.set(c.address, { title: c.title, kind: c.kind, cover: JSON.parse(c.meta_json).cover });
    }
  }
  const profiles = profileMap(db, unique.map((r) => r.actor));
  return unique.map((r) => ({
    type: r.type, at: r.at, sats: Math.floor(r.msats / 1000), rail: r.rail, source: r.source,
    actor: person(r.actor, profiles.get(r.actor)),
    release: { address: r.address, ...titles.get(r.address), kindLabel: KIND_LABELS[titles.get(r.address)?.kind] }
  }));
}

/**
 * Raw signed events straight from the store, for API consumers who want to
 * re-verify or re-publish them. Filters mirror NIP-01 loosely.
 */
export function rawEvents(db, { role, kind, author, since, until, limit }) {
  const where = ['1 = 1'];
  const params = [];
  if (role) { where.push('role = ?'); params.push(role); }
  if (kind !== undefined) { where.push('kind = ?'); params.push(kind); }
  if (author) { where.push('pubkey = ?'); params.push(author); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (until) { where.push('created_at <= ?'); params.push(until); }
  const rows = db.prepare(`SELECT json FROM events WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
  return rows.map((r) => JSON.parse(r.json));
}

/** Sync history and archive composition, for the status page. */
export function syncStatus(db) {
  const runs = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 15').all()
    .map((r) => ({ ...r, summary: r.summary_json ? JSON.parse(r.summary_json) : null, summary_json: undefined }));
  const roles = db.prepare('SELECT role, COUNT(*) n, MAX(created_at) newest FROM events GROUP BY role ORDER BY n DESC').all();
  const last = db.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_at'").get();
  return { lastSyncAt: last ? JSON.parse(last.value) : null, runs, roles };
}
