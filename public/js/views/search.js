/**
 * Instant Fanfares search: one field over every published event, creator
 * and supporter in the index, matched as you type. Pasting an npub or hex
 * pubkey jumps to that profile. Before a query it shows what is selling and
 * who is rising; index totals sit behind a Stats toggle.
 */
import { get } from '../api.js';
import { decodeNpub, npub } from '../nostr.js';
import { registerTracks } from '../player.js';
import {
  avatar, displayName, esc, gridSkeleton, kindName, num, personHref, plural, releaseGrid, satsShort, segmented
} from '../ui.js';

const SCOPES = [['all', 'Everything'], ['events', 'Events'], ['creators', 'Creators'], ['supporters', 'Supporters']];

/** Marks the query inside already-escaped text. */
function mark(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const i = safe.toLowerCase().indexOf(esc(q).toLowerCase());
  return i < 0 ? safe : `${safe.slice(0, i)}<mark>${safe.slice(i, i + esc(q).length)}</mark>${safe.slice(i + esc(q).length)}`;
}

let supportersCache;
/** Every supporter, paged in once per page load (the static file is fetched once). */
async function allSupporters() {
  supportersCache ??= (async () => {
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const res = await get('/api/supporters', { limit: 100, offset });
      out.push(...res.items);
      if (!res.items.length || out.length >= res.total) return out;
    }
  })().catch((err) => { supportersCache = null; throw err; });
  return supportersCache;
}

/** A person result: avatar, name, a line of context and a figure on the right. */
const personRow = (p, q, sub, right) => `<a class="s-person" href="${personHref(p.pubkey)}">${avatar(p, 44)}
  <div class="grow"><div class="title">${mark(displayName(p), q)}</div><div class="sub">${sub}</div></div><div class="right">${right}</div></a>`;

/**
 * Renders the search page.
 * @param {HTMLElement} main
 * @param {URLSearchParams} query `q` and `in` (scope) from the hash route.
 */
export async function renderSearch(main, query) {
  document.title = 'Search · Fanfares Index';
  const state = { q: query.get('q') || '', scope: SCOPES.some(([k]) => k === query.get('in')) ? query.get('in') : 'all' };
  main.innerHTML = `
    <section class="search-hero">
      <div class="eyebrow"><span class="spark" aria-hidden="true"></span>Instant Fanfares search</div>
      <h1>Search anything on Fanfares, <span class="accent">instantly.</span></h1>
      <label class="search-big">
        <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input type="search" id="search-q" placeholder="Try “bitcoin”, a creator’s name or an npub" value="${esc(state.q)}" aria-label="Search Fanfares" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </label>
      <div class="search-row"><div class="search-scope" id="scope"></div>
        <button class="btn sm stats-btn" id="stats-btn" aria-expanded="false" aria-controls="stats">Stats</button></div>
      <div class="search-stats" id="stats" hidden></div>
    </section>
    <div id="search-body"></div>`;

  const input = main.querySelector('#search-q');
  const body = main.querySelector('#search-body');
  if (!matchMedia('(hover: none)').matches) input.focus();

  const ov = await get('/api/overview');
  const statsBtn = main.querySelector('#stats-btn');
  const statsBox = main.querySelector('#stats');
  statsBtn.addEventListener('click', async () => {
    const open = statsBox.hidden;
    statsBox.hidden = !open;
    statsBtn.setAttribute('aria-expanded', String(open));
    if (!open || statsBox.childElementCount) return;
    const people = await get('/api/creators', { limit: 1 });
    const cell = (v, l) => `<div><b>${v}</b><span>${esc(l)}</span></div>`;
    statsBox.innerHTML = `<div class="stats-grid">${[
      cell(num(ov.releases), 'events'), cell(num(people.total), 'creators'), cell(num(ov.buyers), 'supporters'),
      cell(num(ov.sales), 'purchases'), cell(satsShort(ov.salesSats), 'sats paid'), cell(num(ov.archive.events), 'signed Nostr events')
    ].join('')}</div><div class="stats-kinds">${ov.byKind.filter((k) => k.count).map((k) => `<span>${esc(kindName(k.kind))} <b>${num(k.count)}</b></span>`).join('')}</div>`;
  });

  const syncUrl = () => {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.scope !== 'all') p.set('in', state.scope);
    history.replaceState(null, '', `#/search${p.size ? `?${p}` : ''}`);
  };

  /** What to show before a query: what is selling and who is rising. */
  const idle = async () => {
    body.innerHTML = `
      <section class="s-section"><div class="section-head"><h2>Selling this week</h2><a class="more" href="#/events?sort=sales&period=week">View all</a></div><div id="s-hot">${gridSkeleton(6)}</div></section>
      <section class="section s-section"><div class="section-head"><h2>Rising creators</h2><a class="more" href="#/creators?period=month">View all</a></div><div class="s-people" id="s-rising"></div></section>`;
    const [hot, rising] = await Promise.all([
      get('/api/releases', { sort: 'sales', period: 'week', limit: 6 }),
      get('/api/creators', { period: 'month', limit: 6 })
    ]);
    if (state.q || !body.querySelector('#s-hot')) return;
    const hotItems = hot.items.length ? hot.items : (await get('/api/releases', { sort: 'sales', limit: 6 })).items;
    registerTracks(hotItems);
    body.querySelector('#s-hot').innerHTML = `<div class="shelf">${releaseGrid(hotItems)}</div>`;
    body.querySelector('#s-rising').innerHTML = rising.items.map((c) => personRow(c, '', `${plural(c.sales, 'sale')} · ${plural(c.buyers, 'supporter')}`, satsShort(c.earnedSats))).join('')
      || '<div class="empty">No creator sales this month yet.</div>';
  };

  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    const q = state.q;
    if (!q) { idle(); return; }
    const hex = decodeNpub(q) || (/^[0-9a-f]{64}$/i.test(q) ? q.toLowerCase() : '');
    const want = (s) => state.scope === 'all' || state.scope === s;
    body.classList.add('loading');
    const [events, creators, supporters] = await Promise.all([
      want('events') ? get('/api/releases', { q, sort: 'sales', limit: state.scope === 'events' ? 48 : 12 }) : null,
      want('creators') ? get('/api/creators', { q, limit: state.scope === 'creators' ? 48 : 6 }) : null,
      want('supporters') ? allSupporters().then((all) => {
        const n = q.toLowerCase();
        const hits = all.filter((s) => [s.name, s.nip05, s.lud16].some((f) => (f || '').toLowerCase().includes(n)) || (n.startsWith('npub1') && npub(s.pubkey).startsWith(n)));
        return { total: hits.length, items: hits.slice(0, state.scope === 'supporters' ? 48 : 6) };
      }) : null
    ]);
    if (mine !== seq) return;
    body.classList.remove('loading');
    const total = (events?.total || 0) + (creators?.total || 0) + (supporters?.total || 0);
    const section = (title, n, html, scope) => (n ? `<section class="s-section"><div class="section-head"><h2>${title} <span class="muted">${num(n)}</span></h2>
      ${state.scope === 'all' && n > 6 ? `<button class="more linklike" data-scope="${scope}">See all</button>` : ''}</div>${html}</section>` : '');
    if (events) registerTracks(events.items);
    body.innerHTML = `
      ${hex ? `<a class="s-jump" href="${personHref(hex)}"><span class="eyebrow">Profile</span><b class="mono">${esc(npub(hex).slice(0, 24))}…</b><span class="go">Open profile →</span></a>` : ''}
      <div class="result-count"><b>${num(total)}</b> result${total === 1 ? '' : 's'} for “${esc(q)}”</div>
      ${creators ? section('Creators', creators.total, `<div class="s-people">${creators.items.map((c) => personRow(c, q, esc(c.nip05 || `${plural(c.releases, 'event')} published`), satsShort(c.earnedSats))).join('')}</div>`, 'creators') : ''}
      ${events ? section('Events', events.total, releaseGrid(events.items), 'events') : ''}
      ${supporters ? section('Supporters', supporters.total, `<div class="s-people">${supporters.items.map((s) => personRow(s, q, `${plural(s.purchases, 'purchase')} · backed ${plural(s.creators, 'creator')}`, satsShort(s.spentSats))).join('')}</div>`, 'supporters') : ''}
      ${total || hex ? '' : `<div class="empty">Nothing on Fanfares matches “${esc(q)}”. Try a shorter word, a creator’s name or an npub.</div>`}`;
    body.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
      state.scope = b.dataset.scope; scopeSeg.querySelector(`[data-v="${state.scope}"]`).click();
    }));
  };

  const scopeSeg = segmented(main.querySelector('#scope'), SCOPES, state.scope, (v) => { state.scope = v; syncUrl(); run(); window.scrollTo({ top: 0, behavior: 'smooth' }); }, 'Search in');
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = input.value.trim(); syncUrl(); run(); }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const hex = decodeNpub(input.value) || (/^[0-9a-f]{64}$/i.test(input.value.trim()) ? input.value.trim().toLowerCase() : '');
    if (hex) location.hash = personHref(hex);
  });
  await run();
}
