/**
 * Floating preview player. Views register the releases they render; any
 * element with `data-play="<address>"` then plays that release's free,
 * unencrypted preview.
 */
import { safeUrl } from './ui.js';

const tracks = new Map();

/** Remembers releases (with preview URLs) rendered by the current view. */
export function registerTracks(releases) {
  for (const r of releases) if (r.previewUrl) tracks.set(r.address, r);
}

/** Wires the global click handler and the player's close button. Called once. */
export function initPlayer() {
  const el = document.getElementById('player');
  const audio = el.querySelector('audio');
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (!btn) return;
    e.preventDefault();
    const r = tracks.get(btn.dataset.play);
    const src = safeUrl(r?.previewUrl);
    if (!src) return;
    el.hidden = false;
    el.querySelector('.player-title').textContent = r.title;
    const img = el.querySelector('.player-cover');
    img.src = safeUrl(r.cover) || 'img/logo.png';
    audio.src = r.previewUrl;
    audio.play().catch(() => { /* autoplay blocked: controls remain */ });
  });
  el.querySelector('.player-close').addEventListener('click', () => {
    audio.pause();
    audio.removeAttribute('src');
    el.hidden = true;
  });
}
