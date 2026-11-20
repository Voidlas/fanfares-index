/**
 * Thin client for the archive's JSON API. Every call carries the
 * "include test releases" preference so all views stay consistent.
 *
 * Works against both deployments: when the site serves the prebuilt static
 * API (/api/v1/meta.json exists, see snapshot/build.mjs) calls are answered
 * from those files by static-api.js; otherwise they go to the dynamic API
 * (server.js or the fanfares-network Worker).
 */
import { probe, staticGet } from './static-api.js';

const state = { includeTest: false };
try { state.includeTest = localStorage.getItem('ffn-test') === '1'; } catch { /* storage blocked */ }

/** Whether staging/test releases are shown. */
export const includeTest = () => state.includeTest;

/** Persists the test-release preference. */
export function setIncludeTest(on) {
  state.includeTest = on;
  try { localStorage.setItem('ffn-test', on ? '1' : '0'); } catch { /* storage blocked */ }
}

/**
 * GETs an API path with query params; throws with the server's message on failure.
 * @param {string} path e.g. '/api/releases'
 * @param {Record<string, string|number|undefined>} [params]
 */
export async function get(path, params = {}) {
  if (await isStatic()) return staticGet(path, { ...params, ...(state.includeTest ? { test: '1' } : {}) });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== null) qs.set(k, v);
  if (state.includeTest) qs.set('test', '1');
  const res = await fetch(`${path}${qs.size ? `?${qs}` : ''}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}

let mode;
/** Whether this site serves the static API; decided once per page load. */
export function isStatic() {
  mode ??= probe().then(Boolean);
  return mode;
}

/** Every row of a paged list endpoint (100 per request; the static API serves one file). */
export async function every(path, params = {}) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const res = await get(path, { ...params, limit: 100, offset });
    out.push(...res.items);
    if (!res.items.length || out.length >= res.total) return out;
  }
}
