-- BigQuery model of the Fanfares Index, run after every table load
-- (snapshot/load-bq.sh). Safe to run any number of times:
--   * views are recreated from this file, so it is their source of truth;
--   * daily_* tables get one row set per UTC day (the first run of the day);
--   * event_history keeps every profile, follow list, relay list and wallet
--     version ever seen, which the archive itself replaces with the newest.
--
-- History builds up from the day this runs; relays keep only the newest
-- version of those events, so it cannot be backfilled.

DECLARE need_daily BOOL DEFAULT FALSE;

-- Views ---------------------------------------------------------------------

-- One row per purchase of a listed (non-test, non-deleted) release.
CREATE OR REPLACE VIEW fanfares.sales AS
SELECT p.purchased_at_ts AS purchased_at, p.amount_msats / 1000 AS sats, p.source, p.rail,
  c.address, c.title, c.kind, c.price_sats,
  c.pubkey AS creator_pubkey, COALESCE(NULLIF(cp.display_name, ''), cp.name) AS creator,
  p.buyer AS buyer_pubkey, COALESCE(NULLIF(bp.display_name, ''), bp.name) AS buyer
FROM fanfares.purchases p
JOIN fanfares.content c USING (address)
LEFT JOIN fanfares.profiles cp ON cp.pubkey = c.pubkey
LEFT JOIN fanfares.profiles bp ON bp.pubkey = p.buyer
WHERE c.is_test = 0 AND c.deleted = 0;

-- Sales, sats and distinct buyers per month.
CREATE OR REPLACE VIEW fanfares.monthly_sales AS
SELECT DATE_TRUNC(DATE(purchased_at), MONTH) AS month, COUNT(*) AS sales, SUM(sats) AS sats,
  COUNT(DISTINCT buyer_pubkey) AS buyers, COUNT(DISTINCT creator_pubkey) AS creators_paid
FROM fanfares.sales
WHERE purchased_at IS NOT NULL
GROUP BY month;

-- Per creator: listed releases, sales, sats earned, distinct buyers, followers.
CREATE OR REPLACE VIEW fanfares.creators AS
WITH rel AS (
  SELECT pubkey, COUNT(*) AS releases FROM fanfares.content WHERE is_test = 0 AND deleted = 0 GROUP BY pubkey
), s AS (
  SELECT creator_pubkey AS pubkey, COUNT(*) AS sales, SUM(sats) AS sats, COUNT(DISTINCT buyer_pubkey) AS buyers
  FROM fanfares.sales GROUP BY pubkey
), f AS (
  SELECT followee AS pubkey, COUNT(*) AS followers FROM fanfares.follows GROUP BY pubkey
)
SELECT rel.pubkey AS creator_pubkey, COALESCE(NULLIF(p.display_name, ''), p.name) AS creator,
  rel.releases, IFNULL(s.sales, 0) AS sales, IFNULL(s.sats, 0) AS sats, IFNULL(s.buyers, 0) AS buyers,
  IFNULL(f.followers, 0) AS followers
FROM rel
LEFT JOIN s USING (pubkey)
LEFT JOIN f USING (pubkey)
LEFT JOIN fanfares.profiles p USING (pubkey);

-- Per listed release: sales, payments and engagement (comments, reactions,
-- reposts pointing at its address or any of its revision ids).
CREATE OR REPLACE VIEW fanfares.release_stats AS
WITH revisions AS (
  SELECT id, address FROM fanfares.events WHERE role = 'content'
), refs AS (
  SELECT DISTINCT r.event_id, COALESCE(c.address, rv.address) AS address
  FROM fanfares.event_refs r
  LEFT JOIN fanfares.content c ON r.tag IN ('a', 'A') AND r.value = c.address
  LEFT JOIN revisions rv ON r.tag IN ('e', 'E') AND r.value = rv.id
  WHERE COALESCE(c.address, rv.address) IS NOT NULL
), eng AS (
  SELECT refs.address, COUNTIF(e.role = 'comment') AS comments, COUNTIF(e.role = 'reaction') AS reactions,
    COUNTIF(e.role = 'repost') AS reposts
  FROM refs JOIN fanfares.events e ON e.id = refs.event_id
  GROUP BY refs.address
), pay AS (
  SELECT address, COUNT(*) AS payments, SUM(amount_msats) / 1000 AS payment_sats FROM fanfares.payments GROUP BY address
), s AS (
  SELECT address, COUNT(*) AS sales, SUM(sats) AS sats, COUNT(DISTINCT buyer_pubkey) AS buyers FROM fanfares.sales GROUP BY address
)
SELECT c.address, c.title, c.kind, c.pubkey AS creator_pubkey, c.price_sats, c.first_published_ts AS published_at,
  IFNULL(s.sales, 0) AS sales, IFNULL(s.sats, 0) AS sats, IFNULL(s.buyers, 0) AS buyers,
  IFNULL(pay.payments, 0) AS payments, IFNULL(pay.payment_sats, 0) AS payment_sats,
  IFNULL(eng.comments, 0) AS comments, IFNULL(eng.reactions, 0) AS reactions, IFNULL(eng.reposts, 0) AS reposts
FROM fanfares.content c
LEFT JOIN s USING (address)
LEFT JOIN pay USING (address)
LEFT JOIN eng USING (address)
WHERE c.is_test = 0 AND c.deleted = 0;

-- Index-wide totals right now (one row).
CREATE OR REPLACE VIEW fanfares.totals AS
SELECT
  (SELECT COUNT(*) FROM fanfares.content WHERE is_test = 0 AND deleted = 0) AS releases,
  (SELECT COUNT(DISTINCT pubkey) FROM fanfares.content WHERE is_test = 0 AND deleted = 0) AS creators,
  (SELECT COUNT(*) FROM fanfares.sales) AS sales,
  (SELECT IFNULL(SUM(sats), 0) FROM fanfares.sales) AS sales_sats,
  (SELECT COUNT(DISTINCT buyer_pubkey) FROM fanfares.sales) AS buyers,
  (SELECT COUNT(*) FROM fanfares.payments) AS payments,
  (SELECT IFNULL(SUM(amount_msats), 0) / 1000 FROM fanfares.payments) AS payment_sats,
  (SELECT COUNT(*) FROM fanfares.events) AS events,
  (SELECT COUNT(*) FROM fanfares.profiles) AS profiles,
  (SELECT COUNT(*) FROM fanfares.follows) AS follow_edges;

-- Daily snapshots (first run of each UTC day) -------------------------------

-- Every statement here scans the tables behind the views, so only the first
-- run of the day enters this block; the three inserts land together or not at all.
IF NOT EXISTS (SELECT 1 FROM fanfares.INFORMATION_SCHEMA.TABLES WHERE table_name = 'daily_totals') THEN
  CREATE TABLE fanfares.daily_totals AS
  SELECT CURRENT_DATE() AS day, CURRENT_TIMESTAMP() AS captured_at, * FROM fanfares.totals WHERE FALSE;
  CREATE TABLE IF NOT EXISTS fanfares.daily_creator_stats AS
  SELECT CURRENT_DATE() AS day, 0 AS rank_by_sats, * FROM fanfares.creators WHERE FALSE;
  CREATE TABLE IF NOT EXISTS fanfares.daily_release_stats AS
  SELECT CURRENT_DATE() AS day, * EXCEPT (title, kind, creator_pubkey, price_sats, published_at)
  FROM fanfares.release_stats WHERE FALSE;
END IF;
SET need_daily = NOT EXISTS (SELECT 1 FROM fanfares.daily_totals WHERE day = CURRENT_DATE());
IF need_daily THEN
  BEGIN TRANSACTION;
  INSERT INTO fanfares.daily_creator_stats
  SELECT CURRENT_DATE(), RANK() OVER (ORDER BY sats DESC), * FROM fanfares.creators;
  INSERT INTO fanfares.daily_release_stats
  SELECT CURRENT_DATE(), * EXCEPT (title, kind, creator_pubkey, price_sats, published_at) FROM fanfares.release_stats;
  INSERT INTO fanfares.daily_totals
  SELECT CURRENT_DATE(), CURRENT_TIMESTAMP(), * FROM fanfares.totals;
  COMMIT TRANSACTION;
END IF;

-- Version history of replaceable events -------------------------------------

CREATE TABLE IF NOT EXISTS fanfares.event_history (
  captured_at TIMESTAMP NOT NULL, id STRING NOT NULL, kind INT64 NOT NULL, pubkey STRING NOT NULL,
  created_at INT64 NOT NULL, created_at_ts TIMESTAMP, role STRING NOT NULL, raw JSON
);
INSERT INTO fanfares.event_history
SELECT CURRENT_TIMESTAMP(), id, kind, pubkey, created_at, created_at_ts, role, raw
FROM fanfares.events
WHERE role IN ('profile', 'follows', 'relays', 'wallet')
  AND id NOT IN (SELECT id FROM fanfares.event_history);
