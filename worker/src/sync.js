/**
 * Sliced relay sync for the Archive Durable Object.
 *
 * A *pass* re-reads Fanfares from relays in three phases, like the Node
 * crawler (sync.js): content → activity (payments, engagement, deletions for
 * every known release) → people (profiles, follows, relays, wallets). Each
 * phase is planned as a queue of single-page REQs; every alarm runs one
 * *slice* of that queue within a subrequest and time budget, so no single
 * invocation comes near the Workers limits.
 *
 * Two kinds of pass:
 *   quick  every 15 min: the Fanfares home relay, content + activity
 *   full   every hour:   every relay, all three phases
 *
 * Each relay keeps its own `since` cursor (start of its last clean pass,
 * minus an overlap for late propagation), so passes only read what is new.
 */
import { ACTIVITY_KINDS, CONTENT_KINDS, CONTENT_RELAYS, FANFARES_APP_REF, PEOPLE_KINDS, PROFILE_RELAYS } from '../../lib/constants.js';
import { queryRelay } from './relay.js';

export const HOME_RELAY = CONTENT_RELAYS[0];
export const QUICK_EVERY_SEC = 15 * 60;
export const FULL_EVERY_SEC = 60 * 60;
const OVERLAP_SEC = 6 * 3600;
const PAGE = 500;
const CHUNK = 100;
const MAX_PAGES = 40;
/** Per-slice budget: stays well under the 50-subrequest and 6-connection limits. */
const SLICE = { subrequests: 36, concurrency: 5, wallMs: 20000 };

/** Splits `values` into REQ-sized chunks. */
function chunks(values, size = CHUNK) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Starts a pass.
 * @param {'quick'|'full'} kind Which relays and phases to cover.
 * @param {number} runId sync_runs row id from Store#startRun.
 * @param {Record<string, number>} relaySince Per-relay cursor from the state table.
 */
export function newPass(kind, runId, relaySince) {
  const startedAt = Math.floor(Date.now() / 1000);
  const relays = kind === 'full' ? CONTENT_RELAYS : [HOME_RELAY];
  const since = (relay) => (relaySince[relay] ? relaySince[relay] - OVERLAP_SEC : undefined);
  return {
    runId, kind, startedAt, phase: 'content', done: 0, dirty: false,
    added: {}, relays: {}, failed: new Set(), streaks: new Map(), since,
    queue: relays.map((relay) => ({ relay, phase: 'content', filter: { kinds: CONTENT_KINDS, '#a': [FANFARES_APP_REF], limit: PAGE }, page: 0 }))
  };
}

/**
 * Queues the next phase once the current one is drained. Activity covers
 * every known release address and revision id; people covers every
 * participant, with full history for anyone we hold nothing for yet.
 * @param {object} pass The running pass (mutated).
 * @param {object} model Fresh model (rebuilt if the last phase stored anything).
 * @returns {boolean} Whether another phase was queued.
 */
export function nextPhase(pass, model) {
  const relays = pass.kind === 'full' ? CONTENT_RELAYS : [HOME_RELAY];
  if (pass.phase === 'content') {
    pass.phase = 'activity';
    const targets = [...model.targets];
    const addresses = targets.filter((t) => t.includes(':'));
    const ids = targets.filter((t) => !t.includes(':'));
    for (const relay of relays) {
      for (const c of chunks(addresses)) pass.queue.push({ relay, phase: 'activity', filter: { kinds: ACTIVITY_KINDS, '#a': c, limit: PAGE }, page: 0 });
      for (const c of chunks(ids)) pass.queue.push({ relay, phase: 'activity', filter: { kinds: ACTIVITY_KINDS, '#e': c, limit: PAGE }, page: 0 });
    }
    return true;
  }
  if (pass.phase === 'activity' && pass.kind === 'full') {
    pass.phase = 'people';
    const known = (pk) => model.replaceable.has(`${pk}:0`) || model.replaceable.has(`${pk}:10002`);
    const fresh = model.participants.filter((pk) => !known(pk));
    const seen = model.participants.filter(known);
    for (const relay of PROFILE_RELAYS) {
      for (const c of chunks(seen)) pass.queue.push({ relay, phase: 'people', filter: { kinds: PEOPLE_KINDS, authors: c, limit: PAGE }, page: 0 });
      for (const c of chunks(fresh)) pass.queue.push({ relay, phase: 'people', filter: { kinds: PEOPLE_KINDS, authors: c, limit: PAGE }, page: 0, full: true });
    }
    return true;
  }
  return false;
}

/** Records a relay's result for the Live page's relay panel. */
function note(pass, relay, phase, count, ok) {
  const prev = pass.relays[relay]?.[phase] || { count: 0, ok: true };
  pass.relays[relay] = { ...pass.relays[relay], [phase]: { count: prev.count + count, ok: prev.ok && ok } };
}

/**
 * Runs one REQ page and queues the next page when this one was full.
 * A relay that fails two requests in a row without returning anything is
 * skipped for the rest of the phase; its cursor is not advanced, so the
 * next pass retries what it missed.
 */
async function runTask(pass, task, ingest) {
  const filter = { ...task.filter };
  const since = task.full ? undefined : pass.since(task.relay);
  if (since !== undefined) filter.since = since;
  if (task.until !== undefined) filter.until = task.until;
  const res = await queryRelay(task.relay, filter);
  const added = ingest(res.events);
  for (const [role, n] of Object.entries(added)) { pass.added[role] = (pass.added[role] || 0) + n; pass.dirty = true; }
  note(pass, task.relay, task.phase, res.events.length, res.ok);
  const streakKey = `${task.relay}|${task.phase}`;
  if (!res.ok) {
    pass.failed.add(task.relay);
    const streak = res.events.length ? 0 : (pass.streaks.get(streakKey) || 0) + 1;
    pass.streaks.set(streakKey, streak);
  } else {
    pass.streaks.set(streakKey, 0);
  }
  const oldest = Math.min(...res.events.map((e) => e.created_at));
  if (res.events.length >= PAGE * 0.9 && Number.isFinite(oldest) && task.page + 1 < MAX_PAGES && oldest - 1 !== task.until) {
    pass.queue.unshift({ ...task, until: oldest - 1, page: task.page + 1 });
  }
}

/**
 * Runs one slice of the pass: up to SLICE.subrequests REQs, SLICE.concurrency
 * at a time, stopping early at the wall-time budget.
 * @param {object} pass The running pass (mutated).
 * @param {(events: object[]) => Record<string, number>} ingest Stores events; returns new counts per role.
 */
export async function runSlice(pass, ingest) {
  const deadline = Date.now() + SLICE.wallMs;
  let spent = 0;
  const worker = async () => {
    while (pass.queue.length && spent < SLICE.subrequests && Date.now() < deadline) {
      const task = pass.queue.shift();
      if ((pass.streaks.get(`${task.relay}|${task.phase}`) || 0) >= 2) continue;
      spent++;
      await runTask(pass, task, ingest);
      pass.done++;
    }
  };
  await Promise.all(Array.from({ length: SLICE.concurrency }, worker));
}

/**
 * Per-relay cursors after a pass: relays that answered every request move
 * to the pass start; relays that failed keep their old cursor.
 * @param {object} pass The finished pass.
 * @param {Record<string, number>} relaySince Previous cursors.
 */
export function advanceCursors(pass, relaySince) {
  const next = { ...relaySince };
  for (const relay of Object.keys(pass.relays)) if (!pass.failed.has(relay)) next[relay] = pass.startedAt;
  return next;
}

/** The summary stored in sync_runs and shown on the Live page. */
export function passSummary(pass) {
  return { kind: pass.kind, added: pass.added, relays: pass.relays, requests: pass.done, durationSec: Math.floor(Date.now() / 1000) - pass.startedAt };
}
