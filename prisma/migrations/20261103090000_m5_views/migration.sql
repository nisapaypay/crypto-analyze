-- Milestone 5B: read-only views for paper-trading evaluation (M7) and data
-- continuity. Additive only; no table is changed. All timestamp columns are
-- stored in UTC (timestamp without time zone).

-- Order book / trade metrics already stored by M2 in JSON, as columns.
CREATE VIEW "v_market_snapshot_metrics" AS
SELECT
  s.id,
  s.pair,
  s."timestamp"                                                        AS fetched_at,
  s.server_time,
  s.order_book_age_sec,
  s.quality_status,
  s.last_price,
  s.best_bid,
  s.best_ask,
  s.spread                                                             AS spread_idr,
  s.spread_pct,
  s.volume_idr_24h,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 1)') ->> 'imbalance')::numeric      AS imbalance_1pct,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 2)') ->> 'imbalance')::numeric      AS imbalance_2pct,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 1)') ->> 'bidValueIdr')::numeric    AS bid_value_idr_1pct,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 1)') ->> 'askValueIdr')::numeric    AS ask_value_idr_1pct,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 2)') ->> 'bidValueIdr')::numeric    AS bid_value_idr_2pct,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 2)') ->> 'askValueIdr')::numeric    AS ask_value_idr_2pct,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 1)') ->> 'truncated')::boolean      AS depth_truncated_1pct,
  (jsonb_path_query_first(s.order_book_data, '$.bands[*] ? (@.pct == 2)') ->> 'truncated')::boolean      AS depth_truncated_2pct,
  (s.trade_activity ->> 'count')::integer                              AS trades_60m,
  (s.trade_activity ->> 'buyRatio')::numeric                           AS trade_buy_ratio_60m,
  (s.trade_activity ->> 'buyValueIdr')::numeric                        AS trade_buy_value_idr_60m,
  (s.trade_activity ->> 'sellValueIdr')::numeric                       AS trade_sell_value_idr_60m,
  (s.trade_activity ->> 'newestTradeAt')::timestamptz                  AS newest_trade_at,
  i.scan_id,
  sc.kind                                                              AS scan_kind,
  sc.scheduled_at                                                      AS scan_slot_at,
  i.signal_id
FROM "market_snapshots" s
LEFT JOIN "scan_run_items" i ON i.market_snapshot_id = s.id
LEFT JOIN "scheduled_scans" sc ON sc.id = i.scan_id;

-- Snapshot coverage per pair per WIB day: every 15m slot since the scheduler's
-- first slot (and since the pair's first scheduled item) is expected; a slot is
-- covered only by an on-slot run with a stored snapshot for that pair.
-- Recovery runs (off-slot) never cover a missed slot.
CREATE VIEW "v_data_coverage" AS
WITH first_slot AS (
  SELECT min(scheduled_at) AS t FROM "scheduled_scans" WHERE kind IN ('STRATEGY_SCAN', 'COLLECT')
),
slots AS (
  SELECT generate_series(f.t, (now() AT TIME ZONE 'UTC'), interval '15 minutes') AS slot
  FROM first_slot f WHERE f.t IS NOT NULL
),
pairs AS (
  SELECT i.pair, min(s.scheduled_at) AS first_at
  FROM "scan_run_items" i JOIN "scheduled_scans" s ON s.id = i.scan_id
  WHERE s.kind IN ('STRATEGY_SCAN', 'COLLECT') AND s.trigger <> 'RECOVERY'
  GROUP BY i.pair
),
covered AS (
  SELECT DISTINCT i.pair, s.scheduled_at AS slot
  FROM "scan_run_items" i JOIN "scheduled_scans" s ON s.id = i.scan_id
  WHERE s.kind IN ('STRATEGY_SCAN', 'COLLECT') AND s.trigger <> 'RECOVERY'
    AND i.status = 'OK' AND i.market_snapshot_id IS NOT NULL
)
SELECT
  p.pair,
  ((sl.slot AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date AS day_wib,
  count(*)::integer                                               AS expected_slots,
  count(c.slot)::integer                                          AS covered_slots,
  (count(*) - count(c.slot))::integer                             AS missing_slots,
  round(100.0 * count(c.slot) / count(*), 2)                      AS coverage_pct
FROM pairs p
JOIN slots sl ON sl.slot >= p.first_at
LEFT JOIN covered c ON c.pair = p.pair AND c.slot = sl.slot
GROUP BY p.pair, day_wib;
