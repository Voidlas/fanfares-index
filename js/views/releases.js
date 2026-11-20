/**
 * Release browser (search, type filter, sort, paging) and the release
 * detail page (preview, price, revenue split, buyers, payments, comments,
 * raw signed event).
 */
import { get } from '../api.js';
import { fanfaresUrl } from '../nostr.js';
import {
  ago, avatar, copy, cover, date, displayName, duration, esc, periodSelect, gridSkeleton, num, personHref, releaseGrid, sats, whenCell
} from '../ui.js';
import { registerTracks } from '../player.js';

const KINDS = [['', 'All'], ['31338', 'Podcasts'], ['31339', 'Audiobooks'], ['31337', 'Tracks'], ['36787', 'Music'], ['30023', 'Articles'], ['1', 'Notes']];
const SORTS = [['newest', 'Newest'], ['sales', 'Best selling'], ['earned', 'Most earned'], ['price', 'Highest price'], ['oldest', 'Oldest']];
const PAGE = 24;

const searchIcon = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/**
 * Renders the release browser; filter state lives in the URL query so
 * results are linkable and survive reloads.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query Parsed from the hash route.
 */
export async function renderReleases(main, query) {
  const state = { q: query.get('q') || '', kind: query.get('kind') || '', sort: query.get('sort') || 'newest', period: query.get('period') || '', offset: 0, items: [] };
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Catalog</div><h1>Releases</h1>
      <p>Everything sold through Fanfares: podcasts, audiobooks, music and writing. Free previews play right here.</p></div>
    <div class="toolbar">
      <label class="search">${searchIcon}<input type="search" id="q" placeholder="Search titles, topics or creators" value="${esc(state.q)}" aria-label="Search releases"></label>
      <select class="select" id="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}"${v === state.sort ? ' selected' : ''}>${l}</option>`).join('')}</select>
      ${periodSelect(state.period)}
    </div>
    <div class="filters">
      <div class="chips" role="group" aria-label="Release type">
        ${KINDS.map(([v, l]) => `<button class="chip" data-kind="${v}" aria-pressed="${v === state.kind}">${l}</button>`).join('')}
      </div>
      <div class="result-count" id="count" aria-live="polite"></div>
    </div>
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
    history.replaceState(null, '', `#/releases${p.size ? `?${p}` : ''}`);
  };

  let seq = 0;
  const load = async (append) => {
    const mine = ++seq;
    if (!append) { state.offset = 0; state.items = []; results.innerHTML = gridSkeleton(12); }
    const res = await get('/api/releases', { q: state.q, kind: state.kind, sort: state.sort, period: state.period, limit: PAGE, offset: state.offset });
    if (mine !== seq) return;
    state.items.push(...res.items);
    state.offset += res.items.length;
    registerTracks(state.items);
    results.innerHTML = releaseGrid(state.items, state.q ? `Nothing matches “${state.q}”.` : 'No releases of this type yet.');
    count.textContent = `${num(res.total)} release${res.total === 1 ? '' : 's'}`;
    more.hidden = state.offset >= res.total;
  };

  let debounce;
  main.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = e.target.value.trim(); syncUrl(); load(false); }, 250);
  });
  main.querySelector('#sort').addEventListener('change', (e) => { state.sort = e.target.value; syncUrl(); load(false); });
  main.querySelector('#period').addEventListener('change', (e) => { state.period = e.target.value; syncUrl(); load(false); });
  main.querySelectorAll('[data-kind]').forEach((chip) => chip.addEventListener('click', () => {
    state.kind = chip.dataset.kind;
    main.querySelectorAll('[data-kind]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    syncUrl(); load(false);
  }));
  more.addEventListener('click', async () => { more.disabled = true; await load(true); more.disabled = false; });
  await load(false);
}

/** A person cell used in the buyers and payments tables. */
const who = (p, size = 26, phoneNote = '') => `<a class="who" href="${personHref(p.pubkey)}">${avatar(p, size)}<span>${esc(displayName(p))}${phoneNote
  ? `<small class="who-sub show-sm">${esc(phoneNote)}</small>` : ''}</span></a>`;

/**
 * Renders one release.
 * @param {HTMLElement} main
 * @param {string} address `kind:pubkey:d` (or event id) from the route.
 */
export async function renderRelease(main, address) {
  main.innerHTML = '<div class="detail"><div class="skeleton" style="aspect-ratio:1"></div><div><div class="skeleton" style="height:60px"></div></div></div>';
  let r;
  try { r = await get(`/api/releases/${encodeURIComponent(address)}`); } catch (err) {
    main.innerHTML = `<div class="empty">${err.status === 404 ? 'This release is not in the archive.' : esc(err.message)}</div>`;
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
    r.isTest ? 'Test release' : ''
  ].filter(Boolean);

  main.innerHTML = `
    <a class="back" href="#/releases">← Releases</a>
    <div class="detail">
      <div>
        <div class="detail-cover">${cover(r, { eager: true, large: true })}</div>
      </div>
      <div>
        <div class="eyebrow">${esc(r.kindLabel)}${r.topics.length ? ` · ${r.topics.slice(0, 3).map(esc).join(' · ')}` : ''}</div>
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
          <div><b class="sats">${num(r.stats.earnedSats)}</b><span>earned</span></div>
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
      </tbody></table></div>` : '<div class="empty">No payments recorded for this release.</div>'),
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
