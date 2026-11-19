/**
 * People views: the creators directory, a person's profile (releases,
 * purchases, ecash mints) and the supporters leaderboard.
 */
import { get } from '../api.js';
import { fanfaresProfileUrl, npub } from '../nostr.js';
import { avatar, copy, displayName, esc, num, periodSelect, personHref, plural, releaseGrid, safeUrl, sats, whenCell } from '../ui.js';
import { registerTracks } from '../player.js';

const PAGE = 24;
const searchIcon = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/** One creator card. */
function creatorCard(c) {
  return `<a class="creator-card" href="${personHref(c.pubkey)}">
    <div class="top">${avatar(c, 52)}<div style="min-width:0"><div class="name">${esc(displayName(c))}</div>
      <div class="nip05">${esc(c.nip05 || npub(c.pubkey).slice(0, 20) + '…')}</div></div></div>
    <p class="about">${esc(c.about || 'Publishing on Fanfares.')}</p>
    <div class="figures"><div><b class="sats">${num(c.earnedSats)}</b>earned</div><div><b>${num(c.releases)}</b>releases</div>
      <div><b>${num(c.buyers)}</b>supporters</div><div><b>${num(c.followers)}</b>followers</div></div>
  </a>`;
}

/**
 * Creators directory with search, sort, ranking period and paging.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query Parsed from the hash route; `period` comes from the home leaderboards.
 */
export async function renderCreators(main, query) {
  const state = { q: '', sort: '', period: query.get('period') || '', offset: 0, items: [] };
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Directory</div><h1>Creators</h1>
      <p>Everyone who has published on Fanfares, ranked by what their audience has paid them. Followers counts only people in this archive.</p></div>
    <div class="toolbar">
      <label class="search">${searchIcon}<input type="search" id="q" placeholder="Search by name or NIP-05" aria-label="Search creators"></label>
      <select class="select" id="sort" aria-label="Sort"><option value="">Most earned</option><option value="releases">Most releases</option>
        <option value="buyers">Most supporters</option><option value="newest">Recently active</option></select>
      ${periodSelect(state.period)}
    </div>
    <div class="result-count" id="count" aria-live="polite"></div>
    <div class="creator-grid" id="grid"></div>
    <div class="load-more"><button class="btn" id="more" hidden>Load more</button></div>`;
  const grid = main.querySelector('#grid');
  const more = main.querySelector('#more');
  let seq = 0;
  const load = async (append) => {
    const mine = ++seq;
    if (!append) { state.offset = 0; state.items = []; }
    const res = await get('/api/creators', { q: state.q, sort: state.sort, period: state.period, limit: PAGE, offset: state.offset });
    if (mine !== seq) return;
    state.items.push(...res.items);
    state.offset += res.items.length;
    grid.innerHTML = state.items.length ? state.items.map(creatorCard).join('') : '<div class="empty">No creators match.</div>';
    main.querySelector('#count').textContent = `${num(res.total)} creators`;
    more.hidden = state.offset >= res.total;
  };
  let debounce;
  main.querySelector('#q').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = e.target.value.trim(); load(false); }, 250);
  });
  main.querySelector('#sort').addEventListener('change', (e) => { state.sort = e.target.value; load(false); });
  main.querySelector('#period').addEventListener('change', (e) => { state.period = e.target.value; load(false); });
  more.addEventListener('click', () => load(true));
  await load(false);
}

/** A person's page: works for creators, buyers, or both. */
export async function renderPerson(main, pubkey) {
  main.innerHTML = '<div class="skeleton" style="height:220px"></div>';
  let p;
  try { p = await get(`/api/people/${pubkey}`); } catch (err) {
    main.innerHTML = `<div class="empty">${err.status === 404 ? 'This person has no Fanfares activity in the archive.' : esc(err.message)}</div>`;
    return;
  }
  registerTracks([...p.releases, ...p.purchases]);
  document.title = `${displayName(p)} · Fanfares Index`;
  const n = npub(p.pubkey);
  const banner = safeUrl(p.banner);
  const s = p.stats;
  const figures = [
    s.releases && ['Releases', num(s.releases)],
    s.sales && ['Sales', num(s.sales)],
    s.earnedSats && ['Earned', sats(s.earnedSats)],
    s.purchases && ['Purchases', num(s.purchases)],
    s.spentSats && ['Spent', sats(s.spentSats)],
    ['Followers', num(s.followers)]
  ].filter(Boolean);
  main.innerHTML = `
    <a class="back" href="#/creators">← Creators</a>
    <div class="profile-banner" style="${banner ? `background-image:url('${banner}')` : ''}"></div>
    <div class="profile-head">${avatar(p, 112)}
      <div style="padding-bottom:6px;min-width:0"><h1>${esc(displayName(p))}</h1>
        <div class="meta-line" style="margin:6px 0 0">
          ${p.nip05 ? `<span>${esc(p.nip05)}</span>` : ''}
          <span class="copyable mono" id="npub" title="Copy npub">${esc(n.slice(0, 16))}…${esc(n.slice(-6))}</span>
          ${p.lud16 ? `<span>⚡ ${esc(p.lud16)}</span>` : ''}
          ${safeUrl(p.website) ? `<a href="${safeUrl(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\//, ''))}</a>` : ''}
        </div></div>
    </div>
    ${p.about ? `<p class="profile-about">${esc(p.about)}</p>` : ''}
    <div class="hero-actions" style="margin-top:20px">
      <a class="btn primary" href="${fanfaresProfileUrl(p.pubkey)}" target="_blank" rel="noopener">View on Fanfares</a>
    </div>
    <div class="mini-stats" style="grid-template-columns:repeat(${Math.min(figures.length, 6)},1fr);margin-top:36px">
      ${figures.map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}
    </div>
    ${p.wallet?.mints?.length ? `<div><h3 style="font-size:14px;font-weight:600;margin:0 0 4px">Accepts ecash</h3>
      <div class="muted" style="font-size:13px;margin-bottom:12px">Published a NIP-61 wallet (kind 10019), so buyers can pay in cashu from these mints.</div>
      <div class="mints">${p.wallet.mints.map((m) => `<span class="badge cashu">${esc(m.replace(/^https?:\/\//, ''))}</span>`).join('')}</div></div>` : ''}
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="releases" aria-selected="${p.releases.length > 0}">Releases<span class="count">${num(p.releases.length)}</span></button>
      <button role="tab" data-tab="purchases" aria-selected="${!p.releases.length}">Collection<span class="count">${num(p.purchases.length)}</span></button>
    </div>
    <div id="tab-body"></div>`;
  main.querySelector('#npub').addEventListener('click', () => copy(n, 'npub copied'));
  const body = main.querySelector('#tab-body');
  const show = (name) => {
    main.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    body.innerHTML = name === 'releases'
      ? releaseGrid(p.releases, 'No releases published.')
      : releaseGrid(p.purchases, 'Nothing collected yet.');
  };
  main.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  show(p.releases.length ? 'releases' : 'purchases');
}

/**
 * Supporters leaderboard, rankable by period.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query Parsed from the hash route; `period` comes from the home leaderboards.
 */
export async function renderSupporters(main, query) {
  let period = query.get('period') || '';
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Leaderboard</div><h1>Supporters</h1>
      <p>The people paying creators directly. No ads, no subscriptions: every sat here bought a piece of work outright.</p></div>
    <div class="toolbar">${periodSelect(period)}</div>
    <div class="result-count" id="count"></div>
    <div class="table-wrap"><table><thead><tr><th style="width:36px">#</th><th>Supporter</th><th class="r hide-sm">Purchases</th><th class="r hide-sm">Creators</th><th class="r">Spent</th><th class="r">Last</th></tr></thead>
      <tbody id="body"><tr><td colspan="6"><div class="skeleton" style="height:200px"></div></td></tr></tbody></table></div>
    <div class="load-more"><button class="btn" id="more" hidden>Load more</button></div>`;
  let rows = [];
  let offset = 0;
  const tbody = main.querySelector('#body');
  const more = main.querySelector('#more');
  const load = async () => {
    const res = await get('/api/supporters', { period, limit: 50, offset });
    rows.push(...res.items);
    offset += res.items.length;
    tbody.innerHTML = rows.map((s, i) => `<tr><td class="muted num">${i + 1}</td>
      <td><a class="who" href="${personHref(s.pubkey)}">${avatar(s, 30)}<span>${esc(displayName(s))}<small class="who-sub">${plural(s.purchases, 'purchase')}</small></span></a></td>
      <td class="r num hide-sm">${num(s.purchases)}</td><td class="r num hide-sm">${num(s.creators)}</td>
      <td class="r nowrap">${sats(s.spentSats)}</td>${whenCell(s.latest)}</tr>`).join('');
    main.querySelector('#count').textContent = `${num(res.total)} supporters`;
    more.hidden = offset >= res.total;
  };
  main.querySelector('#period').addEventListener('change', (e) => { period = e.target.value; rows = []; offset = 0; load(); });
  more.addEventListener('click', load);
  await load();
}
