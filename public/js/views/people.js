/**
 * People views: the creators directory, a person's profile (published
 * events, purchases, ecash mints) and the supporters leaderboard.
 */
import { every, get } from '../api.js';
import { fanfaresProfileUrl, npub } from '../nostr.js';
import {
  PERIODS_SHORT, agoShort, avatar, compact, copy, displayName, esc, num, personHref, plural, releaseGrid, safeUrl, satsShort,
  segmented, tween
} from '../ui.js';
import { registerTracks } from '../player.js';

const PAGE = 24;
const CREATOR_SORTS = [['', 'Zaps'], ['sales', 'Sales'], ['releases', 'Events'], ['newest', 'Recent']];

/** Short handle under a name: NIP-05 without the "_@", or a short npub. */
const handle = (p) => esc(p.nip05 ? p.nip05.replace(/^_@/, '') : `${npub(p.pubkey).slice(0, 14)}…`);

/** Summary strip whose numbers animate when the period changes. */
const summary = (cells) => `<div class="sum-strip">${cells.map(([id, label]) =>
  `<div class="sum-cell"><span class="label">${esc(label)}</span><span class="value" id="${id}">—</span><span class="hint" id="${id}-hint"></span></div>`).join('')}</div>`;

/** Top three as large cards. `figure` and `line` return HTML for one person. */
const podium = (items, figure, line) => (items.length ? `<div class="podium">${items.slice(0, 3).map((x, i) => `
  <a class="podium-card p${i + 1}" href="${personHref(x.pubkey)}">
    <span class="podium-rank">${i + 1}</span>${avatar(x, 64)}
    <div class="podium-name">${esc(displayName(x))}</div><div class="podium-handle">${handle(x)}</div>
    <div class="podium-figure">${figure(x)}</div><div class="podium-line">${line(x)}</div>
  </a>`).join('')}</div>` : '');

/** One creator in the ranking: who they are, the zaps they received, then the supporting figures. */
function creatorCard(c, rank) {
  const active = c.latestRelease ? `Last published ${agoShort(c.latestRelease)} ago` : '';
  return `<a class="cr-card" href="${personHref(c.pubkey)}">
    <div class="cr-head">${rank ? `<span class="cr-rank">${rank}</span>` : ''}${avatar(c, 44)}
      <div class="cr-id"><div class="name">${esc(displayName(c))}</div><div class="handle">${handle(c)}</div></div>
    </div>
    <div class="cr-earned"><b class="btc-num">${satsShort(c.earnedSats)}</b><span>sats in zaps</span></div>
    <dl class="cr-metrics">
      <div><dt>Sales</dt><dd>${compact(c.sales)}</dd></div>
      <div><dt>Supporters</dt><dd>${compact(c.buyers)}</dd></div>
      <div><dt>Events</dt><dd>${compact(c.releases)}</dd></div>
      <div><dt>Followers</dt><dd>${compact(c.followers)}</dd></div>
    </dl>
    <p class="about">${esc((c.about || '').replace(/https?:\/\/\S+/g, '').trim() || 'Publishing on Fanfares.')}</p>
    ${active ? `<div class="cr-foot">${active}</div>` : ''}
  </a>`;
}

/**
 * Top creators: summary, podium, then every creator as a card, ranked by
 * zaps received (or sales, events, recent activity). Finding a specific
 * creator is the main search's job.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query `sort` and `period` come from the overview's "View all".
 */
export async function renderCreators(main, query) {
  document.title = 'Creators · Fanfares Index';
  const state = { sort: CREATOR_SORTS.some(([k]) => k === query.get('sort')) ? query.get('sort') : '', period: query.get('period') || '', shown: PAGE };
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Creators</div><h1>Top creators on Fanfares</h1>
      <p>Ranked by the zaps their audiences paid them, straight into their own wallets.</p></div>
    <div class="toolbar split"><div id="sort"></div><div id="period"></div></div>
    ${summary([['c-total', 'Creators earning'], ['c-sats', 'Zapped to creators'], ['c-avg', 'Per creator'], ['c-sales', 'Sales']])}
    <div class="section-head list-head"><h2>Ranking</h2><span class="muted" id="count" aria-live="polite"></span></div>
    <div class="cr-grid" id="grid"><div class="skeleton" style="height:220px"></div><div class="skeleton" style="height:220px"></div></div>
    <div class="load-more"><button class="btn" id="more" hidden>Show more</button></div>`;
  const $ = (sel) => main.querySelector(sel);
  const grid = $('#grid');
  const more = $('#more');
  let ranked = [];
  let seq = 0;

  const paint = () => {
    grid.innerHTML = ranked.length ? ranked.slice(0, state.shown).map((c, i) => creatorCard(c, i + 1)).join('')
      : '<div class="empty">No creators in this period yet.</div>';
    $('#count').textContent = `${num(ranked.length)} creator${ranked.length === 1 ? '' : 's'}`;
    more.hidden = state.shown >= ranked.length;
  };

  /** Re-ranks for the current sort and period: summary, podium, list. */
  const refresh = async () => {
    const mine = ++seq;
    grid.classList.add('loading');
    const items = await every('/api/creators', { sort: state.sort, period: state.period });
    if (mine !== seq) return;
    grid.classList.remove('loading');
    ranked = items;
    const earning = ranked.filter((c) => c.earnedSats > 0);
    const total = earning.reduce((n, c) => n + c.earnedSats, 0);
    const sales = ranked.reduce((n, c) => n + c.sales, 0);
    tween($('#c-total'), earning.length);
    $('#c-total-hint').textContent = `of ${num(ranked.length)} ${state.period ? 'active in this period' : 'who have published'}`;
    tween($('#c-sats'), total, (v) => satsShort(v));
    $('#c-sats-hint').textContent = 'sats, peer to peer';
    tween($('#c-avg'), earning.length ? total / earning.length : 0, (v) => satsShort(v));
    $('#c-avg-hint').textContent = 'average sats received';
    tween($('#c-sales'), sales);
    $('#c-sales-hint').textContent = 'purchases of their work';
    state.shown = PAGE;
    paint();
  };

  const syncUrl = () => {
    const p = new URLSearchParams();
    if (state.sort) p.set('sort', state.sort);
    if (state.period) p.set('period', state.period);
    history.replaceState(null, '', `#/creators${p.size ? `?${p}` : ''}`);
  };
  segmented($('#sort'), CREATOR_SORTS, state.sort, (v) => { state.sort = v; syncUrl(); refresh(); }, 'Rank creators by');
  segmented($('#period'), PERIODS_SHORT, state.period, (v) => { state.period = v; syncUrl(); refresh(); }, 'Period');
  more.addEventListener('click', () => { state.shown += PAGE; paint(); });
  await refresh();
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
    s.releases && ['Events', num(s.releases)],
    s.sales && ['Sales', num(s.sales)],
    s.earnedSats && ['Earned', satsShort(s.earnedSats)],
    s.purchases && ['Purchases', num(s.purchases)],
    s.spentSats && ['Spent', satsShort(s.spentSats)],
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
    <div class="mini-stats profile-stats" style="--n:${Math.min(figures.length, 6)}">
      ${figures.map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}
    </div>
    ${p.wallet?.mints?.length ? `<div><h3 style="font-size:14px;font-weight:600;margin:0 0 4px">Accepts ecash</h3>
      <div class="muted" style="font-size:13px;margin-bottom:12px">Published a NIP-61 wallet (kind 10019), so buyers can pay in cashu from these mints.</div>
      <div class="mints">${p.wallet.mints.map((m) => `<span class="badge cashu">${esc(m.replace(/^https?:\/\//, ''))}</span>`).join('')}</div></div>` : ''}
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="releases" aria-selected="${p.releases.length > 0}">Published<span class="count">${num(p.releases.length)}</span></button>
      <button role="tab" data-tab="purchases" aria-selected="${!p.releases.length}">Collection<span class="count">${num(p.purchases.length)}</span></button>
    </div>
    <div id="tab-body"></div>`;
  main.querySelector('#npub').addEventListener('click', () => copy(n, 'npub copied'));
  const body = main.querySelector('#tab-body');
  const show = (name) => {
    main.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    body.innerHTML = name === 'releases'
      ? releaseGrid(p.releases, 'No events published.')
      : releaseGrid(p.purchases, 'Nothing collected yet.');
  };
  main.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  show(p.releases.length ? 'releases' : 'purchases');
}

/**
 * Supporters: who pays creators, how much, how often and how widely.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query `period` comes from the overview's "View all".
 */
export async function renderSupporters(main, query) {
  document.title = 'Supporters · Fanfares Index';
  let period = query.get('period') || '';
  let shown = 50;
  let rows = [];
  main.innerHTML = `
    <div class="page-head"><div class="eyebrow">Supporters</div><h1>Top supporters on Fanfares</h1>
      <p>The people paying creators directly. Every sat here bought a piece of work outright.</p></div>
    <div class="toolbar end"><div id="period"></div></div>
    ${summary([['s-total', 'Supporters'], ['s-sats', 'Sats spent'], ['s-avg', 'Per supporter'], ['s-repeat', 'Came back'], ['s-wide', 'Backed 2+ creators']])}
    <div id="podium"></div>
    <div class="section-head list-head"><h2>Leaderboard</h2><span class="muted" id="count"></span></div>
    <div class="sp-list" id="list"><div class="skeleton" style="height:320px"></div></div>
    <div class="load-more"><button class="btn" id="more" hidden>Show more</button></div>`;
  const $ = (sel) => main.querySelector(sel);
  const more = $('#more');
  let seq = 0;

  const paint = () => {
    const total = rows.reduce((n, s) => n + s.spentSats, 0);
    $('#list').innerHTML = rows.length ? `
      <div class="sp-row sp-headrow" aria-hidden="true"><span>#</span><span>Supporter</span><span class="r hide-sm">Purchases</span><span class="r hide-sm">Creators</span><span class="r hide-sm">Avg. ticket</span><span class="r">Spent</span><span class="r hide-sm">Last</span></div>
      ${rows.slice(0, shown).map((s, i) => `<a class="sp-row" href="${personHref(s.pubkey)}">
        <span class="rank">${i + 1}</span>
        <span class="who">${avatar(s, 36)}<span><b>${esc(displayName(s))}</b><small>${handle(s)}</small></span></span>
        <span class="r num hide-sm">${num(s.purchases)}</span>
        <span class="r num hide-sm">${num(s.creators)}</span>
        <span class="r hide-sm">${satsShort(s.purchases ? s.spentSats / s.purchases : 0)}</span>
        <span class="r sp-spent">${satsShort(s.spentSats)}<small class="show-sm">${plural(s.purchases, 'purchase')} · ${plural(s.creators, 'creator')}</small></span>
        <span class="r muted hide-sm" title="${s.latest ? new Date(s.latest * 1000).toLocaleString('en-US') : ''}">${agoShort(s.latest)}</span>
      </a>`).join('')}` : '<div class="empty">No purchases in this period yet.</div>';
    $('#count').textContent = total ? `${num(rows.length)} supporters · ${num(total)} sats` : '';
    more.hidden = shown >= rows.length;
  };

  const load = async () => {
    const mine = ++seq;
    $('#list').classList.add('loading');
    const items = await every('/api/supporters', { period });
    if (mine !== seq) return;
    $('#list').classList.remove('loading');
    rows = items;
    shown = 50;
    const total = rows.reduce((n, s) => n + s.spentSats, 0);
    const repeat = rows.filter((s) => s.purchases > 1).length;
    const wide = rows.filter((s) => s.creators > 1).length;
    const ratio = (n) => (rows.length ? (n / rows.length) * 100 : 0);
    tween($('#s-total'), rows.length);
    $('#s-total-hint').textContent = 'people who bought something';
    tween($('#s-sats'), total, (v) => satsShort(v));
    $('#s-sats-hint').textContent = 'paid to creators';
    tween($('#s-avg'), rows.length ? total / rows.length : 0, (v) => satsShort(v));
    $('#s-avg-hint').textContent = 'average sats spent';
    tween($('#s-repeat'), ratio(repeat), (v) => `${Math.round(v)}%`);
    $('#s-repeat-hint').textContent = `${num(repeat)} bought more than once`;
    tween($('#s-wide'), ratio(wide), (v) => `${Math.round(v)}%`);
    $('#s-wide-hint').textContent = `${num(wide)} support several creators`;
    $('#podium').innerHTML = podium(rows, (s) => `<span class="btc-num">${satsShort(s.spentSats)}</span><small>sats</small>`,
      (s) => `${plural(s.purchases, 'purchase')} · ${plural(s.creators, 'creator')}`);
    paint();
  };
  segmented($('#period'), PERIODS_SHORT, period, (v) => { period = v; load(); }, 'Period');
  more.addEventListener('click', () => { shown += 50; paint(); });
  await load();
}
