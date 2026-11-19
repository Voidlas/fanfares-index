# Fanfares Index

The live index of everything public about Fanfares on Nostr — releases, sales,
payments, comments and the people behind them — with a JSON API and an explorer UI.

## Run

```bash
npm start            # API + UI on http://127.0.0.1:3333, auto-sync every 15 min
npm run sync         # one incremental crawl from the CLI
npm run sync:full    # re-read every relay's full history
```

Environment: `PORT` (default 3333), `SYNC_INTERVAL_MIN` (default 15). Requires Node ≥ 22.5 (`node:sqlite`).

## What gets stored

All raw, signed events live once in `events` (verbatim JSON) with their `a/e/p/P` tags
indexed in `event_refs`. Everything else is derived from them and rebuilt after each sync.

| Role | Kinds | How it is found |
| --- | --- | --- |
| content | 1, 30023, 31337, 31338, 31339, 36787 | tagged with the Fanfares NIP-89 handler `a` tag |
| zap / nutzap | 9735 / 9321 | `#a` / `#e` pointing at Fanfares content |
| comment, reaction, repost, deletion | 1111 & 1, 7, 6 & 16, 5 | `#a` / `#e` pointing at Fanfares content |
| profile, follows, relays, wallet | 0, 3, 10002, 10019 | every creator, buyer, payer and commenter |

Relays: fanfares.nostr1.com, relay.primal.net, nos.lol, relay.damus.io (+ purplepag.es for people).
Each filter is paginated with `until`, so relay result caps don't truncate history; incremental
runs re-read a 3-day overlap.

Derived tables: `content` (latest revision per address, test/staging flag, metadata),
`payments` (one row per zap/nutzap leg with bolt11 / proof amounts), `purchases`
(`verified` = imported from the fanfares-workers feed, `receipts` = a buyer's payments to an
item adding up to its price), `profiles`, `wallets`, `follows`.

The original fanfares-workers `feed_*` tables are kept untouched and imported once.

## Layout

```
lib/constants.js   relays, kinds, labels
lib/relay.js       websocket REQ client with pagination, retries, chunking
lib/parse.js       pure parsers: content metadata, zap receipts, nutzaps, profiles
lib/db.js          schema, ingest, legacy import, derived-table rebuild
lib/queries.js     read queries behind the API
sync.js            three-phase crawler (content → activity → people)
server.js          HTTP API, SSE sync stream, scheduler, static UI
public/            explorer UI (vanilla ES modules, no build step)
snapshot/          static site build, archive re-seed, parity check, wrangler config
.github/workflows/ scheduled crawl + static deploy
```

## Static snapshot

A second way to publish the index: GitHub Actions crawls Nostr on a schedule and
publishes the explorer plus a prebuilt JSON API as plain static files. No server code
runs at request time and nothing touches a metered database, so the API scales with
Cloudflare's CDN (static asset requests are free and unlimited).

```bash
npm run snapshot          # build dist/ from data/fanfares.sqlite
npm run snapshot:parity   # check every static answer against the dynamic API
npx wrangler dev --config snapshot/wrangler.jsonc   # serve dist/ locally
```

How a run works (`.github/workflows/snapshot.yml`, hourly at :17 and on demand):

1. Restore `data/` (the SQLite crawl archive) from the Actions cache, under a rolling key.
2. If there is no cache, `snapshot/seed.mjs` rebuilds the archive from the published
   site's raw-event files (`SNAPSHOT_URL`), so relays are never re-crawled from scratch.
   With neither, the run stops: a relay crawl alone misses the worker-verified purchases
   and legacy-feed events in the original archive. Run it with `full=true` to start from
   relays anyway.
3. `node sync.js` crawls incrementally (well under a minute), and the archive is saved back to the cache.
4. `snapshot/build.mjs` computes every response with the same model and query code as
   the Worker API (`worker/src/model.js`, `worker/src/queries.js`) and writes `dist/`.
5. `wrangler deploy --config snapshot/wrangler.jsonc` publishes `dist/` to the
   assets-only Worker `fanfares-index-static` (separate from `fanfares-network`).

The explorer detects the static API (`/api/v1/meta.json`) and answers its calls from
those files in the browser (`public/js/static-api.js`), filtering, sorting and paging
with the same rules as the server. On the dynamic deployments (`server.js`,
`fanfares-network`) it keeps calling `/api/*` as before. On the static site, "Sync now"
is hidden and the Live page shows when the snapshot was built.

Static API, under `/api/v1/`:

| File | Contents |
| --- | --- |
| `meta.json` | build time, last crawl, recent sync runs with relay results, event counts by role |
| `overview.json`, `overview.test.json` | index totals and monthly series (`.test` counts test releases) |
| `activity.json`, `activity.test.json` | newest 100 sales, releases and comments |
| `releases/{all,today,week,month,year}.json` | every listed release card, stats counted in that window; test releases flagged `isTest` |
| `release/{key}.json` | one release; `key` = first 32 hex chars of `sha256(address)`; `release/ids.json` maps revision ids to keys |
| `creators/{period}[.test].json`, `supporters/{period}[.test].json` | full rankings in default order (`period` = all, today, week, month, year) |
| `people/{pubkey}.json` | one person: profile, releases, purchases, wallet, stats |
| `events/manifest.json`, `events/{role}/{n}.json` | every raw signed event by role, newest first, ~256 KB shards |
| `archive/verified.json` | worker-verified purchases (used to re-seed the archive) |

Fields starting with `_` in list files are search and sort helpers.

Setup on GitHub (repository settings → Secrets and variables → Actions):

- secret `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with **Account → Workers Scripts → Edit**
  on the personal account pinned in `snapshot/wrangler.jsonc`. Without it, runs crawl and
  build but skip the deploy.
- variable `SNAPSHOT_URL`: the deployed site's URL (for example
  `https://fanfares-index-static.<subdomain>.workers.dev`), used to re-seed a lost cache.

First publish (bootstrap): build from the full local archive and deploy once by hand, then
set `SNAPSHOT_URL`; the next run seeds its archive from that site.

```bash
npm run snapshot -- --db /path/to/fanfares.sqlite
npx wrangler deploy --config snapshot/wrangler.jsonc
```

Actions minutes: a run takes about a minute, so hourly runs fit even a private
repository's 2,000 free minutes. Public repositories have unlimited minutes.

API reference: open `/#/api` in the running app.
