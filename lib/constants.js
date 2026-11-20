/**
 * Shared constants for the Fanfares Network archive: which relays are crawled,
 * which Nostr kinds count as Fanfares content, and how each kind is labelled.
 * Imported by the sync crawler, the ingest layer and the HTTP API.
 */

/**
 * Relays the crawler reads content, payments and engagement from.
 * fanfares.nostr1.com is the Fanfares home relay; the rest are the public
 * relays the Fanfares client publishes to by default (see starterRelayList.ts
 * and serverNostrFetch.ts in fanfares-next).
 */
export const CONTENT_RELAYS = [
  'wss://fanfares.nostr1.com',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io'
];

/** Relays queried for profile metadata, wallet info and relay lists. */
export const PROFILE_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://fanfares.nostr1.com',
  'wss://nos.lol',
  'wss://relay.damus.io'
];

/** The NIP-89 handler address every Fanfares-published event tags with `a`. */
export const FANFARES_APP_REF =
  '31990:d7d8109ee43657ce6056ada4653006bbb641f31e50e85243681c2724507811ec:Fanfares';

/** Kinds Fanfares publishes as sellable content. */
export const CONTENT_KINDS = [1, 30023, 31337, 31338, 31339, 36787];

/** Human labels for each content kind, used by the API and the UI. */
export const KIND_LABELS = {
  1: 'Note',
  30023: 'Article',
  31337: 'Music',
  31338: 'Podcast',
  31339: 'Audiobook',
  36787: 'Music'
};

/** Kinds stored as engagement on Fanfares content. */
export const ENGAGEMENT_KINDS = {
  reaction: [7],
  repost: [6, 16],
  comment: [1111]
};

/** Public per-user kinds stored for every known Fanfares participant. */
export const PROFILE_KINDS = {
  profile: 0,
  follows: 3,
  relayList: 10002,
  walletInfo: 10019
};

/** Zap receipt (NIP-57) and nutzap (NIP-61) kinds. */
export const ZAP_RECEIPT_KIND = 9735;
export const NUTZAP_KIND = 9321;
export const DELETION_KIND = 5;

/** Kinds the activity phase reads for every known release (payments, engagement, deletions). */
export const ACTIVITY_KINDS = [
  ZAP_RECEIPT_KIND, NUTZAP_KIND, DELETION_KIND, 1,
  ...ENGAGEMENT_KINDS.reaction, ...ENGAGEMENT_KINDS.repost, ...ENGAGEMENT_KINDS.comment
];

/** Kinds the people phase reads for every participant. */
export const PEOPLE_KINDS = [PROFILE_KINDS.profile, PROFILE_KINDS.follows, PROFILE_KINDS.relayList, PROFILE_KINDS.walletInfo];
