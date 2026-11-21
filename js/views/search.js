/**
 * Search: one field over every published event, creator and supporter in
 * the index, matched on every keystroke. Pasting an npub or hex pubkey
 * offers that profile. Before a query it suggests formats and shows what is
 * selling and who is rising.
 *
 * The data behind it is fetched as soon as the page opens, so the first
 * keystroke already has everything it needs; a thin bar under the field
 * shows while results update.
 */
import { every, get } from '../api.js';
import { decodeNpub, npub } from '../nostr.js';
import { registerTracks } from '../player.js';
import {
  avatar, displayName, esc, gridSkeleton, num, personHref, plural, releaseGrid, satsShort, searchIcon, segmented
} from '../ui.js';

const SCOPES = [['all', 'All'], ['events', 'Events'], ['creators', 'Creators'], ['supporters', 'Supporters']];
const SUGGEST = ['Podcast', 'Audiobook', 'Music', 'Article', 'Bitcoin', 'Nostr'];

/** Marks the query inside already-escaped text. */
function mark(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const i = safe.toLowerCase().indexOf(esc(q).toLowerCase());
  return i < 0 ? safe : `${safe.slice(0, i)}<mark>${safe.slice(i, i + esc(q).length)}</mark>${safe.slice(i + esc(q).length)}`;
}

let supportersCache;
/** Every supporter, paged in once per page load (the static file is fetched once). */
function allSupporters() {
  supportersCache ??= every('/api/supporters').catch((err) => { supportersCache = null; throw err; });
  return supportersCache;
}

/** A person result: avatar, name, a line of context and a figure on the right. */
const personRow = (p, q, sub, right) => `<a class="s-person" href="${personHref(p.pubkey)}">${avatar(p, 40)}
  <div class="grow"><div class="title">${mark(displayName(p), q)}</div><div class="sub">${sub}</div></div><div class="right">${right}</div></a>`;

const peopleSkeleton = (n) => `<div class="s-people">${Array.from({ length: n }, () => '<div class="skeleton" style="height:66px"></div>').join('')}</div>`;

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
      <h1>Search Fanfares</h1>
      <p>Find any event, creator or supporter by title, topic, name, NIP-05, lightning address or npub.</p>
    </section>
    <div class="search-dock">
      <label class="search-big" id="search-box">
        ${searchIcon}
        <input type="search" id="search-q" placeholder="Search events, creators, npubs…" value="${esc(state.q)}" aria-label="Search Fanfares"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
        <kbd>/</kbd>
        <span class="search-bar" aria-hidden="true"></span>
      </label>
      <div class="search-scope" id="scope"></div>
    </div>
    <div id="search-body" aria-live="polite"></div>`;

  const input = main.querySelector('#search-q');
  const box = main.querySelector('#search-box');
  const body = main.querySelector('#search-body');
  if (!matchMedia('(hover: none)').matches || state.q === '') input.focus({ preventScroll: true });

  // Warm every file a query reads, so the first keystroke answers instantly.
  allSupporters().catch(() => {});
  get('/api/creators', { limit: 1 }).catch(() => {});
  get('/api/releases', { limit: 1 }).catch(() => {});

  const syncUrl = () => {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.scope !== 'all') p.set('in', state.scope);
    history.replaceState(null, '', `#/search${p.size ? `?${p}` : ''}`);
  };

  /** What to show before a query: quick suggestions, what is selling and who is rising. */
  const idle = async () => {
    body.innerHTML = `
      <div class="s-suggest"><span class="muted">Try</span>${SUGGEST.map((s) => `<button class="pill" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <section class="s-section"><div class="section-head"><h2>Selling this week</h2><a class="more" href="#/events?sort=sales&period=week">View all</a></div><div id="s-hot">${gridSkeleton(6)}</div></section>
      <section class="s-section"><div class="section-head"><h2>Rising creators</h2><a class="more" href="#/creators?period=month">View all</a></div><div id="s-rising">${peopleSkeleton(4)}</div></section>`;
    body.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      input.value = b.dataset.q; state.q = b.dataset.q; syncUrl(); run();
    }));
    const [hot, rising] = await Promise.all([
      get('/api/releases', { sort: 'sales', period: 'week', limit: 6 }),
      get('/api/creators', { period: 'month', limit: 6 })
    ]);
    if (state.q || !body.querySelector('#s-hot')) return;
    const hotItems = hot.items.length ? hot.items : (await get('/api/releases', { sort: 'sales', limit: 6 })).items;
    registerTracks(hotItems);
    body.querySelector('#s-hot').innerHTML = `<div class="shelf">${releaseGrid(hotItems)}</div>`;
    body.querySelector('#s-rising').innerHTML = rising.items.length
      ? `<div class="s-people">${rising.items.map((c) => personRow(c, '', `${plural(c.sales, 'sale')} · ${plural(c.buyers, 'supporter')}`, satsShort(c.earnedSats))).join('')}</div>`
      : '<div class="empty">No creator sales this month yet.</div>';
  };

  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    const q = state.q;
    if (!q) { box.classList.remove('busy'); idle(); return; }
    const hex = decodeNpub(q) || (/^[0-9a-f]{64}$/i.test(q) ? q.toLowerCase() : '');
    const want = (s) => state.scope === 'all' || state.scope === s;
    const many = state.scope !== 'all';
    box.classList.add('busy');
    // First query on a fresh page: show the result layout right away instead of the idle shelves.
    if (!body.querySelector('.result-count')) {
      body.innerHTML = `<div class="result-count">Searching for “${esc(q)}”…</div>${want('creators') ? peopleSkeleton(2) : ''}${want('events') ? `<div style="margin-top:28px">${gridSkeleton(4)}</div>` : ''}`;
    }
    let events; let creators; let supporters;
    try {
      [events, creators, supporters] = await Promise.all([
        want('events') ? get('/api/releases', { q, sort: 'sales', limit: many ? 48 : 12 }) : null,
        want('creators') ? get('/api/creators', { q, limit: many ? 48 : 6 }) : null,
        want('supporters') ? allSupporters().then((all) => {
          const n = q.toLowerCase();
          const hits = all.filter((s) => [s.name, s.nip05, s.lud16].some((f) => (f || '').toLowerCase().includes(n)) || (n.startsWith('npub1') && npub(s.pubkey).startsWith(n)));
          return { total: hits.length, items: hits.slice(0, many ? 48 : 6) };
        }) : null
      ]);
    } catch (err) {
      if (mine !== seq) return;
      box.classList.remove('busy');
      body.innerHTML = `<div class="empty">Search failed: ${esc(err.message)}</div>`;
      return;
    }
    if (mine !== seq) return;
    box.classList.remove('busy');
    const total = (events?.total || 0) + (creators?.total || 0) + (supporters?.total || 0);
    const section = (title, n, html, scope) => (n ? `<section class="s-section"><div class="section-head"><h2>${title} <span class="muted">${num(n)}</span></h2>
      ${state.scope === 'all' && n > (scope === 'events' ? 12 : 6) ? `<button class="more linklike" data-scope="${scope}">See all</button>` : ''}</div>${html}</section>` : '');
    if (events) registerTracks(events.items);
    body.innerHTML = `
      ${hex ? `<a class="s-jump" href="${personHref(hex)}"><span class="eyebrow">Profile</span><b class="mono">${esc(npub(hex).slice(0, 20))}…</b><span class="go">Open →</span></a>` : ''}
      <div class="result-count"><b>${num(total)}</b> result${total === 1 ? '' : 's'} for “${esc(q)}”</div>
      ${creators ? section('Creators', creators.total, `<div class="s-people">${creators.items.map((c) => personRow(c, q, esc(c.nip05 ? c.nip05.replace(/^_@/, '') : `${plural(c.releases, 'event')} published`), satsShort(c.earnedSats))).join('')}</div>`, 'creators') : ''}
      ${events ? section('Events', events.total, releaseGrid(events.items), 'events') : ''}
      ${supporters ? section('Supporters', supporters.total, `<div class="s-people">${supporters.items.map((s) => personRow(s, q, `${plural(s.purchases, 'purchase')} · ${plural(s.creators, 'creator')}`, satsShort(s.spentSats))).join('')}</div>`, 'supporters') : ''}
      ${total || hex ? '' : `<div class="empty">Nothing on Fanfares matches “${esc(q)}”. Try a shorter word, a creator’s name or an npub.</div>`}`;
    body.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
      scopeSeg.querySelector(`[data-v="${b.dataset.scope}"]`).click();
    }));
  };

  const scopeSeg = segmented(main.querySelector('#scope'), SCOPES, state.scope, (v) => {
    state.scope = v; syncUrl(); run();
    if (main.querySelector('.search-dock').getBoundingClientRect().top < 80) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, 'Search in');
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    box.classList.toggle('busy', input.value.trim() !== '');
    debounce = setTimeout(() => { state.q = input.value.trim(); syncUrl(); run(); }, 70);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const hex = decodeNpub(input.value) || (/^[0-9a-f]{64}$/i.test(input.value.trim()) ? input.value.trim().toLowerCase() : '');
    if (hex) location.hash = personHref(hex);
    else input.blur(); // closes the phone keyboard so results are visible
  });
  await run();
}
