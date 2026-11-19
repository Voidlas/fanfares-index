/**
 * Decides which archive role a raw relay event is stored under. Shared by
 * the Node store (lib/db.js) and the Cloudflare Durable Object
 * (worker/src/store.js) so both keep exactly the same events.
 */
import { DELETION_KIND, ENGAGEMENT_KINDS, NUTZAP_KIND, PROFILE_KINDS, ZAP_RECEIPT_KIND } from './constants.js';
import { isFanfaresContent } from './parse.js';

/** Roles whose events are replaceable: only the newest per author+kind is kept. */
export const REPLACEABLE_ROLES = new Set(['profile', 'follows', 'relays', 'wallet']);

/**
 * Every content address or revision id an event points at through its
 * `a`/`e`/`A`/`E` tags (NIP-01 and NIP-22 reference tags).
 * @param {object} ev Raw relay event.
 * @returns {string[]}
 */
export function referenceTargets(ev) {
  return (ev.tags || [])
    .filter((t) => (t[0] === 'a' || t[0] === 'e' || t[0] === 'A' || t[0] === 'E') && typeof t[1] === 'string' && t[1])
    .map((t) => t[1]);
}

/**
 * Classifies a raw event into the role the archive stores it under, or null
 * when the archive does not keep it. Payments and engagement are only kept
 * when they point at known Fanfares content.
 * @param {object} ev Raw relay event.
 * @param {Set<string>} knownTargets Addresses and revision ids of stored Fanfares content.
 * @returns {string | null}
 */
export function classify(ev, knownTargets) {
  if (isFanfaresContent(ev)) return 'content';
  const targetsContent = referenceTargets(ev).some((r) => knownTargets.has(r));
  if (ev.kind === ZAP_RECEIPT_KIND) return targetsContent ? 'zap' : null;
  if (ev.kind === NUTZAP_KIND) return targetsContent ? 'nutzap' : null;
  if (ev.kind === DELETION_KIND) return targetsContent ? 'deletion' : null;
  if (ENGAGEMENT_KINDS.reaction.includes(ev.kind)) return targetsContent ? 'reaction' : null;
  if (ENGAGEMENT_KINDS.repost.includes(ev.kind)) return targetsContent ? 'repost' : null;
  if (ENGAGEMENT_KINDS.comment.includes(ev.kind) || ev.kind === 1) return targetsContent ? 'comment' : null;
  if (ev.kind === PROFILE_KINDS.profile) return 'profile';
  if (ev.kind === PROFILE_KINDS.follows) return 'follows';
  if (ev.kind === PROFILE_KINDS.relayList) return 'relays';
  if (ev.kind === PROFILE_KINDS.walletInfo) return 'wallet';
  return null;
}
