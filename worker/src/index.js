/**
 * Fanfares Index on Cloudflare Workers.
 *
 * Static explorer UI (public/) is served by Workers static assets and never
 * invokes this script. Requests under /api/* are forwarded to the single
 * Archive Durable Object, which owns the data. The cron trigger only re-arms
 * the Archive's sync alarm in case the chain was ever broken.
 */
export { Archive } from './archive.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

/** The one Archive instance every request and the cron talk to. */
const archive = (env) => env.ARCHIVE.getByName('archive');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const res = await archive(env).fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(archive(env).ensureAlarm());
  }
};
