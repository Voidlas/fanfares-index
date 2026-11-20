/**
 * Entry point: hash router, nav highlighting, the test-event toggle, the
 * "/" search shortcut and one-time setup of the player and sync status.
 */
import { includeTest, setIncludeTest } from './api.js';
import { initPlayer } from './player.js';
import { initSyncStatus } from './sync-status.js';
import { esc } from './ui.js';
import { renderHome } from './views/home.js';
import { renderInsights } from './views/insights.js';
import { renderApi, renderLive } from './views/live.js';
import { renderCreators, renderPerson, renderSupporters } from './views/people.js';
import { renderRelease, renderReleases } from './views/events.js';
import { renderSearch } from './views/search.js';

const main = document.getElementById('main');

const ROUTES = [
  [/^\/?$/, 'home', () => renderHome(main)],
  [/^\/search$/, 'search', (m, q) => renderSearch(main, q)],
  [/^\/(events|releases)$/, 'events', (m, q) => renderReleases(main, q)],
  [/^\/(?:event|release)\/(.+)$/, 'events', (m) => renderRelease(main, decodeURIComponent(m[1]))],
  [/^\/creators$/, 'creators', (m, q) => renderCreators(main, q)],
  [/^\/p\/([0-9a-f]{64})$/, 'creators', (m) => renderPerson(main, m[1])],
  [/^\/supporters$/, 'supporters', (m, q) => renderSupporters(main, q)],
  [/^\/insights$/, 'insights', (m, q) => renderInsights(main, q)],
  [/^\/live$/, 'live', () => renderLive(main)],
  [/^\/api$/, 'api', () => renderApi(main)]
];

/** Renders the view for the current hash. */
async function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const match = ROUTES.map(([re, nav, fn]) => [path.match(re), nav, fn]).find(([m]) => m);
  document.title = 'Fanfares Index';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === match?.[1]));
  window.scrollTo(0, 0);
  if (!match) { main.innerHTML = '<div class="empty">Page not found. <a href="#/">Go to the overview</a>.</div>'; return; }
  try {
    await match[2](match[0], new URLSearchParams(qs || ''));
  } catch (err) {
    main.innerHTML = `<div class="empty">Something went wrong loading this page: ${esc(err.message)}</div>`;
  }
}

const toggle = document.getElementById('show-test');
toggle.checked = includeTest();
toggle.addEventListener('change', () => { setIncludeTest(toggle.checked); route(); });

// Press "/" anywhere (outside a field) to jump to search.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  e.preventDefault();
  const field = document.getElementById('search-q');
  if (field) field.focus(); else location.hash = '#/search';
});

// Event-list filter edits rewrite the hash with replaceState; only real
// navigations fire hashchange, so filters don't re-render the page.
window.addEventListener('hashchange', route);
initPlayer();
initSyncStatus();
route();

// Installable app and offline support (sw.js). Skipped where unsupported or on plain http dev hosts.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// "Install app" appears only when the browser offers installation.
let installPrompt;
const installBtn = document.getElementById('install');
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; installBtn.hidden = false; });
installBtn.addEventListener('click', async () => { installBtn.hidden = true; await installPrompt?.prompt(); installPrompt = null; });
window.addEventListener('appinstalled', () => { installBtn.hidden = true; });
