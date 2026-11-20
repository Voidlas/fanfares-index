/**
 * Events: the catalog of everything published through Fanfares (search,
 * format tiles, sort, period, paging) and one event's detail page (preview,
 * price, revenue split, buyers, payments, comments, raw signed event).
 */
import { get, isStatic } from '../api.js';
import { fanfaresUrl } from '../nostr.js';
import {
  PERIODS_SHORT, ago, avatar, copy, cover, date, displayName, duration, esc, gridSkeleton, kindName, kindPlural, num, personHref,
  releaseGrid, sats, satsShort, searchIcon, segmented, tween, whenCell
} from '../ui.js';
import { registerTracks } from '../player.js';

const SORTS = [['newest', 'Newest'], ['sales', 'Best selling'], ['earned', 'Top earning'], ['price', 'Price']];
const PAGE = 24;

/**
 * Format tiles: one per kind that has published events (empty formats are
 * left out), with all-time earnings where the snapshot publishes them.
 */
async function formatTiles() {
  const [ov, ins] = await Promise.all([get('/api/overview'), (await isStatic()) ? get('/api/insights', { period: 'all' }).catch(() => null) : null]);
  const earned = new Map((ins?.kinds || []).map((k) => [k.kind, k.sats]));
  const byName = new Map();
  for (const k of ov.byKind) {
    if (!k.count) continue;
    const name = kindPlural(k.kind);
    const t = byName.get(name) || { name, kind: k.kind, count: 0, top: 0, sats: 0 };
    t.count += k.count;
    t.sats += earned.get(k.kind) || 0;
    if (k.count > t.top) { t.top = k.count; t.kind = k.kind; }
    byName.set(name, t);
  }
  return { total: ov.releases, earned: ins ? ins.current.sats : null, tiles: [...byName.values()].sort((a, b) => b.count - a.count) };
}

/**
 * Renders the events catalog; filter state lives in the URL query so
 * results are linkable and survive reloads.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query Parsed from the hash route.
 */
export async function renderReleases(main, query) {
  document.title = 'Events · Fanfares Index';
  const state = { q: query.get('q') || '', kind: query.get('kind') || '', sort: query.get('sort') || 'newest', period: query.get('period') || '', offset: 0, items: [] };
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Events</div><h1>Everything published on Fanfares</h1>
      <p>Podcasts, audiobooks, music, articles and notes. Each one is a signed Nostr event, with every sale it made on the record.</p></div>
    <div class="ev-controls">
      <div class="toolbar">
        <label class="search">${searchIcon}<input type="search" id="q" placeholder="Filter by title, topic or creator" value="${esc(state.q)}" aria-label="Filter events"></label>
        <div id="sort"></div>
        <div id="period"></div>
      </div>
      <div class="kind-tiles" id="tiles">${Array.from({ length: 5 }, () => '<div class="kind-tile"><div class="skeleton" style="height:52px"></div></div>').join('')}</div>
    </div>
    <div class="result-count" id="count" aria-live="polite"></div>
    <div id="results">${gridSkeleton(12)}</div>
    <div class="load-more"><button class="btn" id="more" hidden>Load more</button></div>`;

  const results = main.querySelector('#results');
  const more = main.querySelector('#more');
  const count = main.querySelector('#count');

  const syncUrl = () => {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.kind) p.set('kind', state.kind);
    if (state.sort !== 'newest') p.set('sort', state.sort);
    if (state.period) p.set('period', state.period);
    history.replaceState(null, '', `#/events${p.size ? `?${p}` : ''}`);
  };

  let seq = 0;
  const load = async (append) => {
    const mine = ++seq;
    if (!append) { state.offset = 0; state.items = []; results.classList.add('loading'); }
    const res = await get('/api/releases', { q: state.q, kind: state.kind, sort: state.sort, period: state.period, limit: PAGE, offset: state.offset });
    if (mine !== seq) return;
    results.classList.remove('loading');
    state.items.push(...res.items);
    state.offset += res.items.length;
    registerTracks(state.items);
    const what = state.kind ? kindPlural(Number(state.kind)).toLowerCase() : 'events';
    results.innerHTML = releaseGrid(state.items, state.q ? `Nothing matches “${state.q}”.` : `No ${what} in this period.`);
    const period = PERIODS_SHORT.find(([v]) => v === state.period);
    count.innerHTML = `<b>${num(res.total)}</b> ${res.total === 1 ? what.replace(/s$/, '') : what}${state.period ? ` · ${state.sort === 'sales' || state.sort === 'earned' ? 'selling' : 'published'} in the last ${esc(period[1])}` : ''}`;
    more.hidden = state.offset >= res.total;
  };

  const tilesHost = main.querySelector('#tiles');
  const paintTiles = (t) => {
    const all = { name: 'All events', kind: '', count: t.total, sats: t.earned };
    const max = Math.max(...t.tiles.map((x) => x.count), 1);
    tilesHost.innerHTML = [all, ...t.tiles].map((x) => `
      <button class="kind-tile" data-kind="${x.kind}" aria-pressed="${String(x.kind) === state.kind}">
        <span class="kt-name">${esc(x.name)}</span>
        <span class="kt-count">${num(x.count)}</span>
        <span class="kt-sub">${x.sats != null ? `${satsShort(x.sats)} earned` : '&nbsp;'}</span>
        ${x.kind ? `<span class="kt-bar"><i style="width:${Math.max(4, (x.count / max) * 100)}%"></i></span>` : '<span class="kt-bar all"><i style="width:100%"></i></span>'}
      </button>`).join('');
    tilesHost.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      state.kind = b.dataset.kind;
      tilesHost.querySelectorAll('[data-kind]').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      syncUrl(); load(false);
    }));
  };
  formatTiles().then(paintTiles).catch(() => { tilesHost.remove(); });

  let debounce;
  main.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = e.target.value.trim(); syncUrl(); load(false); }, 200);
  });
  segmented(main.querySelector('#sort'), SORTS, state.sort, (v) => { state.sort = v; syncUrl(); load(false); }, 'Sort');
  segmented(main.querySelector('#period'), PERIODS_SHORT, state.period, (v) => { state.period = v; syncUrl(); load(false); }, 'Period');
  more.addEventListener('click', async () => { more.disabled = true; await load(true); more.disabled = false; });
  await load(false);
}

/** A person cell used in the buyers and payments tables. */
const who = (p, size = 26, phoneNote = '') => `<a class="who" href="${personHref(p.pubkey)}">${avatar(p, size)}<span>${esc(displayName(p))}${phoneNote
  ? `<small class="who-sub show-sm">${esc(phoneNote)}</small>` : ''}</span></a>`;

/**
 * Renders one published event.
 * @param {HTMLElement} main
 * @param {string} address `kind:pubkey:d` (or event id) from the route.
 */
export async function renderRelease(main, address) {
  main.innerHTML = '<div class="detail"><div class="skeleton" style="aspect-ratio:1"></div><div><div class="skeleton" style="height:60px"></div></div></div>';
  let r;
  try { r = await get(`/api/releases/${encodeURIComponent(address)}`); } catch (err) {
    main.innerHTML = `<div class="empty">${err.status === 404 ? 'This event is not in the archive.' : esc(err.message)}</div>`;
    return;
  }
  registerTracks([r]);
  document.title = `${r.title} · Fanfares Index`;
  const link = fanfaresUrl(r.address);
  const totalWeight = r.splits.reduce((s, x) => s + x.weight, 0) || 1;
  const meta = [
    `Published ${date(r.publishedAt)}`,
    r.durationSec ? duration(r.durationSec) : '',
    r.parts > 1 ? `${r.parts} parts` : '',
    r.revisions > 1 ? `${r.revisions} revisions` : '',
    r.isTest ? 'Test event' : ''
  ].filter(Boolean);

  main.innerHTML = `
    <a class="back" href="#/events">← Events</a>
    <div class="detail">
      <div>
        <div class="detail-cover">${cover(r, { eager: true, large: true })}</div>
      </div>
      <div>
        <div class="eyebrow">${esc(kindName(r.kind, r.kindLabel))}${r.topics.length ? ` · ${r.topics.slice(0, 3).map(esc).join(' · ')}` : ''}</div>
        <h1>${esc(r.title)}</h1>
        <a class="author-chip" href="${personHref(r.author.pubkey)}">${avatar(r.author, 26)}${esc(displayName(r.author))}</a>
        <div class="meta-line">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
        <div class="price-box">
          <div><div class="eyebrow">Price</div><div class="price">${r.priceSats ? sats(r.priceSats) : 'Free'}</div></div>
          <div style="flex:1"></div>
          ${r.previewUrl ? `<button class="btn" data-play="${esc(r.address)}">Play preview</button>` : ''}
          ${link ? `<a class="btn primary" href="${link}" target="_blank" rel="noopener">Unlock on Fanfares</a>` : ''}
        </div>
        ${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ''}
        <div class="mini-stats">
          <div><b>${num(r.stats.sales)}</b><span>purchases</span></div>
          <div><b>${satsShort(r.stats.earnedSats)}</b><span>earned</span></div>
          <div><b>${num(r.stats.zaps)}</b><span>payments</span></div>
          <div><b>${num(r.stats.comments + r.stats.reactions + r.stats.reposts)}</b><span>reactions</span></div>
        </div>
        ${r.splits.length ? `
          <div>
            <h3 style="font-size:14px;font-weight:600;margin:0 0 4px">Where the money goes</h3>
            <div class="muted" style="font-size:13px;margin-bottom:14px">Each purchase is paid directly into these wallets. Fanfares takes no cut during Early Access.</div>
            <div class="split-bar">${r.splits.map((s) => `<span style="flex:${s.weight}" title="${esc(displayName(s))}"></span>`).join('')}</div>
            <div class="rows">${r.splits.map((s) => `<div class="row">${who(s, 24)}<div class="grow"></div>
              <div class="right num">${Math.round((s.weight / totalWeight) * 100)}%</div></div>`).join('')}</div>
          </div>` : ''}
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="true" data-tab="buyers">Buyers<span class="count">${num(r.buyers.length)}</span></button>
      <button role="tab" aria-selected="false" data-tab="payments">Payments<span class="count">${num(r.payments.length)}</span></button>
      <button role="tab" aria-selected="false" data-tab="comments">Comments<span class="count">${num(r.comments.length)}</span></button>
      <button role="tab" aria-selected="false" data-tab="event">Signed event</button>
    </div>
    <div id="tab-body"></div>`;

  const bodies = {
    buyers: () => (r.buyers.length ? `<div class="table-wrap"><table><thead><tr><th>Buyer</th><th class="hide-sm">Proof</th><th class="r">Paid</th><th class="r">When</th></tr></thead><tbody>
      ${r.buyers.map((b) => `<tr><td>${who(b, 26, b.source === 'verified' ? 'Verified purchase' : 'Matched from receipts')}</td>
        <td class="hide-sm"><span class="badge ${b.source}" title="${b.source === 'verified' ? 'Verified by the Fanfares key server' : 'Matched from public payment receipts'}">${b.source === 'verified' ? 'Verified' : 'Receipts'}</span>
          ${b.rail === 'cashu' ? ' <span class="badge cashu">Ecash</span>' : ''}</td>
        <td class="r nowrap">${sats(b.sats)}</td>${whenCell(b.at)}</tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No purchases yet.</div>'),
    payments: () => (r.payments.length ? `<div class="table-wrap"><table><thead><tr><th>From</th><th class="hide-sm">To</th><th class="hide-sm">Rail</th><th class="r">Amount</th><th class="r">When</th></tr></thead><tbody>
      ${r.payments.map((p) => `<tr><td>${who(p.sender)}</td><td class="hide-sm">${who(p.recipient)}</td>
        <td class="hide-sm"><span class="badge ${p.rail}">${p.rail === 'cashu' ? 'Cashu' : 'Lightning'}</span></td>
        <td class="r nowrap">${sats(p.sats)}</td>${whenCell(p.at)}</tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No payments recorded for this event.</div>'),
    comments: () => (r.comments.length ? `<div>${r.comments.map((c) => `<div class="comment">${avatar(c.author, 34)}
      <div><a href="${personHref(c.author.pubkey)}"><b>${esc(displayName(c.author))}</b></a> <span class="muted" style="font-size:12.5px">${ago(c.at)}</span>
      <p>${esc(c.text)}</p></div></div>`).join('')}</div>` : '<div class="empty">No comments yet.</div>'),
    event: () => `<div><p class="summary" style="font-size:14px;margin-bottom:18px">The exact event the creator signed and published. Anyone can fetch it from a relay and verify the signature.</p>
      <div class="hero-actions"><button class="btn" id="copy-addr">Copy address</button><button class="btn" id="copy-json">Copy JSON</button>${link ? `<a class="btn" href="${link}" target="_blank" rel="noopener">Open naddr</a>` : ''}</div>
      <details class="raw" open><summary>kind ${r.event.kind} · ${esc(r.event.id.slice(0, 16))}…</summary><pre>${esc(JSON.stringify(r.event, null, 2))}</pre></details></div>`
  };
  const body = main.querySelector('#tab-body');
  const show = (name) => {
    main.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    body.innerHTML = bodies[name]();
    body.querySelector('#copy-addr')?.addEventListener('click', () => copy(r.address, 'Address copied'));
    body.querySelector('#copy-json')?.addEventListener('click', () => copy(JSON.stringify(r.event), 'Event JSON copied'));
  };
  main.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  show('buyers');
}
