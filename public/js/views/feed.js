/**
 * Activity feed items (sales, new releases, comments), shared by the
 * overview and the Live page.
 */
import { ago, displayName, esc, personHref, releaseHref, sats } from '../ui.js';

const ICONS = { sale: '⚡', release: '✦', comment: '💬' };

/** Renders /api/activity rows as feed items. */
export function feedItems(items) {
  if (!items.length) return '<div class="empty">No activity yet.</div>';
  return items.map((e) => {
    const who = `<a href="${personHref(e.actor.pubkey)}"><b>${esc(displayName(e.actor))}</b></a>`;
    const what = `<a href="${releaseHref(e.release.address)}"><b>${esc(e.release.title || 'a release')}</b></a>`;
    const text = {
      sale: `${who} bought ${what} for ${sats(e.sats)}${e.rail === 'cashu' ? ' in ecash' : ''}`,
      release: `${who} published ${esc((e.release.kindLabel || 'a release').toLowerCase())} ${what}`,
      comment: `${who} commented on ${what}`
    }[e.type];
    return `<div class="feed-item"><span class="feed-icon ${e.type}" aria-hidden="true">${ICONS[e.type]}</span>
      <div class="txt">${text}</div><span class="when">${ago(e.at)}</span></div>`;
  }).join('');
}
