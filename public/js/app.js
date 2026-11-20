/**
 * Entry point: hash router, nav highlighting, the test-release toggle and
 * one-time setup of the player and sync status.
 */
import { includeTest, setIncludeTest } from './api.js';
import { initPlayer } from './player.js';
import { initSyncStatus } from './sync-status.js';
import { esc } from './ui.js';
import { renderHome } from './views/home.js';
import { renderInsights } from './views/insights.js';
import { renderApi, renderLive } from './views/live.js';
import { renderCreators, renderPerson, renderSupporters } from './views/people.js';
import { renderRelease, renderReleases } from './views/releases.js';

const main = document.getElementById('main');

const ROUTES = [
  [/^\/?$/, 'home', () => renderHome(main)],
  [/^\/releases$/, 'releases', (m, q) => renderReleases(main, q)],
  [/^\/release\/(.+)$/, 'releases', (m) => renderRelease(main, decodeURIComponent(m[1]))],
  [/^\/creators$/, 'creators', (m, q) => renderCreators(main, q)],
  [/^\/p\/([0-9a-f]{64})$/, 'creators', (m) => renderPerson(main, m[1])],
  [/^\/supporters$/, 'supporters', (m, q) => renderSupporters(main, q)],
  [/^\/insights$/, 'insights', () => renderInsights(main)],
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

// Release-list filter edits rewrite the hash with replaceState; only real
// navigations fire hashchange, so filters don't re-render the page.
window.addEventListener('hashchange', route);
initPlayer();
initSyncStatus();
route();
