/**
 * Minimal Nostr relay client used by the sync crawler. One short-lived
 * WebSocket per query; pagination walks `until` backwards so relays that cap
 * results per REQ (fanfares.nostr1.com caps at 500) are fully drained.
 */

/**
 * Sends one REQ to one relay and collects events until EOSE, CLOSED, an error
 * or the timeout. Never rejects: a failing relay yields what it sent so far,
 * and `ok` says whether the relay finished cleanly.
 * @param {string} url Relay websocket URL from CONTENT_RELAYS / PROFILE_RELAYS.
 * @param {object} filter A single NIP-01 filter built by the crawler.
 * @param {number} [timeoutMs] How long to wait for EOSE before giving up.
 * @returns {Promise<{events: object[], ok: boolean, error?: string}>}
 */
export function queryRelay(url, filter, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const events = [];
    let settled = false;
    let ws;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* socket already closed */ }
      resolve({ events, ok, error });
    };
    const timer = setTimeout(() => finish(events.length > 0, 'timeout'), timeoutMs);
    const subId = 'ffn' + Math.random().toString(36).slice(2, 10);
    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish(false, err.message);
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
    ws.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }
      if (data[0] === 'EVENT' && data[1] === subId && data[2]?.id) events.push(data[2]);
      else if (data[0] === 'EOSE' && data[1] === subId) finish(true);
      else if (data[0] === 'CLOSED' && data[1] === subId) finish(false, String(data[2] || 'closed'));
    };
    ws.onerror = () => finish(false, 'connection error');
    ws.onclose = () => finish(events.length > 0, 'closed');
  });
}

/**
 * Retries a REQ that failed before returning anything. Busy public relays
 * (relay.damus.io especially) drop bursts of connections and then answer
 * the same filter fine a moment later.
 * @param {string} url Relay websocket URL.
 * @param {object} filter NIP-01 filter.
 * @param {number} [attempts] Total tries, with 1s, 2s, ... backoff between them.
 */
async function queryWithRetry(url, filter, attempts = 3) {
  let res;
  for (let i = 0; i < attempts; i++) {
    res = await queryRelay(url, filter);
    if (res.ok || res.events.length) return res;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return res;
}

/**
 * Drains a filter from one relay page by page, newest first, by moving
 * `until` to just below the oldest event of each full page.
 * @param {string} url Relay websocket URL.
 * @param {object} filter NIP-01 filter; `limit` is the page size.
 * @param {object} [opts]
 * @param {number} [opts.maxPages] Safety cap on pages per filter.
 * @param {number} [opts.since] Lower bound (unix seconds) for incremental syncs.
 * @returns {Promise<{events: object[], ok: boolean, error?: string}>}
 */
export async function paginate(url, filter, { maxPages = 40, since } = {}) {
  const pageSize = filter.limit || 500;
  const all = new Map();
  let until = filter.until;
  let lastError;
  let ok = true;
  for (let page = 0; page < maxPages; page++) {
    const f = { ...filter, limit: pageSize };
    if (until !== undefined) f.until = until;
    if (since !== undefined) f.since = since;
    const res = await queryWithRetry(url, f);
    if (!res.ok) { ok = res.events.length > 0 && ok; lastError = res.error; }
    let oldest = Infinity;
    let fresh = 0;
    for (const ev of res.events) {
      if (!all.has(ev.id)) { all.set(ev.id, ev); fresh++; }
      if (ev.created_at < oldest) oldest = ev.created_at;
    }
    // A short page or a page with nothing new means the relay is drained.
    if (res.events.length < pageSize * 0.9 || fresh === 0 || !Number.isFinite(oldest)) break;
    until = oldest - 1;
  }
  return { events: [...all.values()], ok, error: lastError };
}

/**
 * Runs a filter whose tag/author list is too long for one REQ by splitting
 * the list into chunks and paginating each chunk.
 * @param {string} url Relay websocket URL.
 * @param {object} baseFilter Filter without the chunked key.
 * @param {string} key The filter key to chunk, e.g. '#a', '#e' or 'authors'.
 * @param {string[]} values Every value for that key.
 * @param {number} [chunkSize] Values per REQ; relays reject very long filters.
 * @param {object} [opts]
 * @param {number} [opts.since] Lower bound passed through to {@link paginate}.
 * @param {number} [opts.concurrency] Chunks in flight per relay at once.
 * @returns {Promise<{events: object[], failures: number, abandoned: boolean}>}
 */
export async function paginateChunked(url, baseFilter, key, values, chunkSize = 100, { since, concurrency = 3 } = {}) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) chunks.push(values.slice(i, i + chunkSize));
  const all = new Map();
  let failures = 0;
  let emptyFailStreak = 0;
  let abandoned = false;
  let next = 0;
  // A relay that refuses two chunks in a row (and returned nothing) is
  // having a bad day; skip the rest of its chunks rather than wait out
  // every timeout. The next scheduled sync tries it again.
  const worker = async () => {
    while (next < chunks.length && !abandoned) {
      const chunk = chunks[next++];
      const res = await paginate(url, { ...baseFilter, [key]: chunk }, { since });
      for (const ev of res.events) all.set(ev.id, ev);
      if (res.ok) { emptyFailStreak = 0; continue; }
      failures++;
      emptyFailStreak = res.events.length ? 0 : emptyFailStreak + 1;
      if (emptyFailStreak >= 2) abandoned = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return { events: [...all.values()], failures, abandoned };
}
