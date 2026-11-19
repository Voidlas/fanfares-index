/**
 * Nostr relay client for the Workers runtime. Workers open outbound
 * WebSockets with a `fetch` upgrade; each query uses one short-lived socket
 * (one subrequest), so a sync slice can count exactly what it spends.
 */

/**
 * Sends one REQ to one relay and collects events until EOSE, CLOSED, an
 * error or the deadline. Never rejects, and always settles within
 * `timeoutMs` — including a relay that never answers the upgrade — so one
 * silent relay cannot stall a sync slice. `ok` says whether it finished cleanly.
 * @param {string} url Relay websocket URL (wss://…) from the sync plan.
 * @param {object} filter One NIP-01 filter built by the sync planner.
 * @param {number} [timeoutMs] Deadline for the whole query, upgrade included.
 * @returns {Promise<{events: object[], ok: boolean, error?: string}>}
 */
export function queryRelay(url, filter, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const events = [];
    const subId = 'ffn' + Math.random().toString(36).slice(2, 10);
    const abort = new AbortController();
    let ws;
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.abort();
      try { ws?.close(1000); } catch { /* already closed */ }
      resolve({ events, ok, error });
    };
    const timer = setTimeout(() => finish(events.length > 0, 'timeout'), timeoutMs);
    fetch(url.replace(/^ws/, 'http'), { headers: { Upgrade: 'websocket' }, signal: abort.signal })
      .then((res) => {
        if (settled) { try { res.webSocket?.close(1000); } catch { /* ignore */ } return; }
        ws = res.webSocket;
        if (!ws) { finish(false, `upgrade refused (${res.status})`); return; }
        ws.accept();
        ws.addEventListener('message', (msg) => {
          let data;
          try { data = JSON.parse(msg.data); } catch { return; }
          if (data[0] === 'EVENT' && data[1] === subId && data[2]?.id) events.push(data[2]);
          else if (data[0] === 'EOSE' && data[1] === subId) finish(true);
          else if (data[0] === 'CLOSED' && data[1] === subId) finish(false, String(data[2] || 'closed'));
        });
        ws.addEventListener('error', () => finish(false, 'connection error'));
        ws.addEventListener('close', () => finish(events.length > 0, 'closed'));
        ws.send(JSON.stringify(['REQ', subId, filter]));
      })
      .catch((err) => finish(false, err.message));
  });
}
