/**
 * The Archive Durable Object: one instance holds the whole Fanfares Network
 * archive in its SQLite storage, serves the API from an in-memory model, and
 * keeps itself current with an alarm that runs the sliced relay sync.
 *
 * Alarm schedule: every ALARM_IDLE_MS while idle (which also keeps the object
 * resident, so the model is not rebuilt on every request), and back-to-back
 * slices while a pass runs. A Worker cron re-arms the alarm if it is ever lost.
 */
import { DurableObject } from 'cloudflare:workers';
import { buildModel } from './model.js';
import { roleCounts } from './queries.js';
import { json, readRoute } from './routes.js';
import { Store } from './store.js';
import { FULL_EVERY_SEC, QUICK_EVERY_SEC, advanceCursors, newPass, nextPhase, passSummary, runSlice } from './sync.js';

const ALARM_IDLE_MS = 60 * 1000;
const ALARM_BUSY_MS = 1000;
const MANUAL_GAP_SEC = 120;
const LOG_LINES = 150;

export class Archive extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
    this.model = null;
    this.dirty = false;
    this.pass = null;
    this.log = [];
    this.manual = false;
  }

  /** The read model, built on first use and after any phase that stored events. */
  getModel() {
    if (!this.model || (this.dirty && !this.pass)) this.rebuild();
    return this.model;
  }

  /** Recomputes the model from every stored event (one full read of `events`). */
  rebuild() {
    const rows = [];
    this.store.eachEvent((r) => rows.push(r));
    this.model = buildModel(rows, this.store.verifiedPurchases());
    this.dirty = false;
  }

  /** Appends a line to the in-memory crawl log the Live page shows. */
  say(entry) {
    this.log.push({ ...entry, at: Date.now() });
    if (this.log.length > LOG_LINES) this.log.shift();
  }

  /**
   * Stores events through the live model so classification stays current.
   * Ingest keeps the model's targets and replaceable maps up to date itself,
   * so a stale model is fine here and no rebuild is forced per batch.
   */
  ingest(events) {
    if (!this.model) this.rebuild();
    const added = this.store.ingest(events, this.model);
    if (Object.keys(added).length) this.dirty = true;
    return added;
  }

  /** Called by the Worker cron: makes sure the alarm chain is running. */
  async ensureAlarm() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /** Decides whether a pass is due and which kind; null when none is. */
  duePass(now) {
    const last = this.store.getState('last_pass', { quick: 0, full: 0 });
    if (now - last.full >= FULL_EVERY_SEC) return 'full';
    if (this.manual || now - last.quick >= QUICK_EVERY_SEC) return 'quick';
    return null;
  }

  async alarm() {
    try {
      const now = Math.floor(Date.now() / 1000);
      if (!this.pass) {
        const kind = this.duePass(now);
        if (kind) {
          this.manual = false;
          this.pass = newPass(kind, this.store.startRun(kind, now), this.store.getState('relay_since', {}));
          this.log = [];
          this.say({ type: 'start', message: `${kind === 'full' ? 'Full' : 'Quick'} sync started` });
          this.say({ type: 'phase', phase: 'content', message: 'Reading Fanfares releases' });
        }
      }
      if (this.pass) await this.step();
    } catch (err) {
      this.say({ type: 'error', message: err.message });
      if (this.pass) { this.store.finishRun(this.pass.runId, 'error', { ...passSummary(this.pass), error: err.message }); this.pass = null; }
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + (this.pass ? ALARM_BUSY_MS : ALARM_IDLE_MS));
    }
  }

  /** Runs one slice of the current pass, advancing phases and finishing it when drained. */
  async step() {
    const pass = this.pass;
    await runSlice(pass, (events) => this.ingest(events));
    if (pass.queue.length) return;
    for (const [relay, phases] of Object.entries(pass.relays)) {
      const r = phases[pass.phase];
      if (r) this.say({ type: 'relay', relay, phase: pass.phase, count: r.count, ok: r.ok });
    }
    if (pass.dirty) { this.rebuild(); pass.dirty = false; }
    if (nextPhase(pass, this.model)) {
      this.say({ type: 'phase', phase: pass.phase, message: pass.phase === 'activity'
        ? `Reading payments and engagement for ${this.model.contents.size} releases`
        : `Reading profiles and wallets for ${this.model.participants.length} people` });
      return;
    }
    const last = this.store.getState('last_pass', { quick: 0, full: 0 });
    this.store.setState('last_pass', { quick: pass.startedAt, full: pass.kind === 'full' ? pass.startedAt : last.full });
    this.store.setState('relay_since', advanceCursors(pass, this.store.getState('relay_since', {})));
    const summary = passSummary(pass);
    this.store.finishRun(pass.runId, 'ok', summary);
    this.say({ type: 'complete', summary });
    this.pass = null;
  }

  /** Sync history, live progress, archive composition and quota use. */
  syncStatus() {
    const last = this.store.getState('last_pass', { quick: 0, full: 0 });
    return {
      lastSyncAt: last.quick || null,
      running: Boolean(this.pass),
      intervalMin: QUICK_EVERY_SEC / 60,
      fullIntervalMin: FULL_EVERY_SEC / 60,
      pass: this.pass && { kind: this.pass.kind, phase: this.pass.phase, done: this.pass.done, queued: this.pass.queue.length, startedAt: this.pass.startedAt },
      log: this.log,
      runs: this.store.recentRuns(),
      roles: roleCounts(this.getModel()),
      usage: this.store.usage
    };
  }

  /** Starts a sync now from the Live page's button, rate limited. */
  async requestSync() {
    if (this.pass) return json(409, { started: false, reason: 'A sync is already running' });
    const last = this.store.getState('last_pass', { quick: 0, full: 0 });
    if (Math.floor(Date.now() / 1000) - last.quick < MANUAL_GAP_SEC) return json(429, { started: false, reason: 'Synced moments ago; try again in a couple of minutes' });
    this.manual = true;
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return json(202, { started: true });
  }

  /**
   * Admin endpoints (Bearer ADMIN_TOKEN): the one-time import of the Node
   * archive and seeding the sync cursors. Used by worker/scripts/import.mjs.
   */
  async admin(request, url) {
    if (!this.env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${this.env.ADMIN_TOKEN}`) {
      return json(401, { error: 'unauthorized' });
    }
    const body = await request.json().catch(() => ({}));
    if (url.pathname === '/api/admin/import') {
      const added = this.ingest(Array.isArray(body.events) ? body.events : []);
      const verified = this.store.importVerified(Array.isArray(body.verified) ? body.verified : []);
      return json(200, { added, verified, usage: this.store.usage });
    }
    if (url.pathname === '/api/admin/cursors') {
      if (body.relaySince) this.store.setState('relay_since', body.relaySince);
      if (body.lastPass) this.store.setState('last_pass', body.lastPass);
      await this.ensureAlarm();
      return json(200, { relaySince: this.store.getState('relay_since', {}), lastPass: this.store.getState('last_pass') });
    }
    return json(404, { error: 'unknown admin endpoint' });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/admin/') && request.method === 'POST') return this.admin(request, url);
    if (url.pathname === '/api/sync') {
      if (request.method === 'POST') return this.requestSync();
      return json(200, this.syncStatus());
    }
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
    try {
      return readRoute(url, this.getModel(), this.store) || json(404, { error: 'unknown endpoint' });
    } catch (err) {
      console.error(url.pathname, err.stack || err.message);
      return json(500, { error: 'internal error' });
    }
  }
}
