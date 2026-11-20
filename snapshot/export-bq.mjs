/**
 * Exports the crawl archive as BigQuery load files: one newline-delimited
 * JSON file and one schema file per table, ready for snapshot/load-bq.sh.
 *
 *   node --no-warnings snapshot/export-bq.mjs [--db data/fanfares.sqlite] [--out bq]
 *
 * Every table keeps its SQLite columns. Signed JSON columns become BigQuery
 * JSON columns (`events.raw`, `content.meta`, `wallets.mints`,
 * `sync_runs.summary`), and every unix-seconds time column also gets a
 * TIMESTAMP twin named `<column>_ts`, so dashboards can use dates directly.
 */
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    db: { type: 'string', default: path.join(ROOT, 'data', 'fanfares.sqlite') },
    out: { type: 'string', default: path.join(ROOT, 'bq') }
  }
});

/** Tables exported, in load order. */
const TABLES = ['events', 'content', 'payments', 'purchases', 'verified_purchases', 'profiles', 'wallets', 'follows', 'event_refs', 'sync_runs'];
/** JSON text columns, renamed to what they hold. */
const JSON_COLUMNS = { json: 'raw', meta_json: 'meta', mints_json: 'mints', summary_json: 'summary' };
/** Unix-seconds columns that also get a TIMESTAMP twin. */
const TIME_COLUMNS = new Set(['created_at', 'first_published', 'purchased_at', 'started_at', 'finished_at', 'first_seen']);
const TYPES = { INTEGER: 'INT64', REAL: 'FLOAT64', TEXT: 'STRING' };

const db = new DatabaseSync(args.db, { readOnly: true });
const out = path.resolve(args.out);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const table of TABLES) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const schema = [];
  for (const c of cols) {
    if (JSON_COLUMNS[c.name]) { schema.push({ name: JSON_COLUMNS[c.name], type: 'JSON' }); continue; }
    schema.push({ name: c.name, type: TYPES[c.type.toUpperCase()] || 'STRING', mode: c.notnull ? 'REQUIRED' : 'NULLABLE' });
    if (TIME_COLUMNS.has(c.name)) schema.push({ name: `${c.name}_ts`, type: 'TIMESTAMP' });
  }
  writeFileSync(path.join(out, `${table}.schema.json`), JSON.stringify(schema, null, 1));

  const file = createWriteStream(path.join(out, `${table}.ndjson`));
  let rows = 0;
  for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
    const o = {};
    for (const [k, v] of Object.entries(row)) {
      if (JSON_COLUMNS[k]) { o[JSON_COLUMNS[k]] = v == null ? null : JSON.parse(v); continue; }
      o[k] = v;
      // 0 means "unknown" for purchase times; leave the timestamp empty then.
      if (TIME_COLUMNS.has(k)) o[`${k}_ts`] = v > 0 ? new Date((v > 1e12 ? v : v * 1000)).toISOString() : null;
    }
    if (!file.write(`${JSON.stringify(o)}\n`)) await new Promise((r) => file.once('drain', r));
    rows++;
  }
  await new Promise((r) => file.end(r));
  console.log(`${table}: ${rows} rows`);
}
