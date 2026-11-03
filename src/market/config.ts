import type { Timeframe } from './types.js';

/** Approved Milestone 2 defaults. All values are plain constants, easy to tune. */
export const MARKET_DATA_DEFAULTS = {
  timeframe: '15' as Timeframe,
  /** Higher timeframe used only to confirm the trend (Milestone 3). */
  trendTimeframe: '60' as Timeframe,

  /** Ticker `server_time` older than this is stale (Cloudflare caches up to 30 s). */
  tickerMaxAgeSec: 90,
  /** Order book has no timestamp: age = time since fetch + Cloudflare `Age`. */
  orderBookMaxAgeSec: 60,
  /** Ticker time further in the future than this indicates a clock/data problem. */
  maxFutureSkewSec: 10,

  /** Minimum finished candles required for analysis (EMA 50 warm-up ×3). */
  minFinalCandles: 150,
  /** Finished candles loaded from the database for analysis. */
  candleLoadLimit: 300,
  /** Indodax returns at most ~865 candles per request. */
  candleBackfillCount: 860,
  /** Re-fetch this many already-stored candles to pick up late corrections. */
  candleOverlapCount: 2,
  /**
   * A candle counts as final only this long after it closed. Must exceed the
   * Cloudflare cache max-age for OHLC (60 s), otherwise a cached, still-forming
   * candle could be stored as final.
   */
  candleSettleSec: 90,

  /** Liquidity check: share of zero-volume candles among the last N. */
  liquidityLookback: 20,
  maxZeroVolumeRatio: 0.3,

  /** Order book depth bands around the mid price, in percent. */
  depthBandsPct: [1, 2] as const,
  tradeWindowMinutes: 60,

  watchlistMax: 10,
  /** Reuse a pair's market data for this long (protects the rate limit). */
  cacheTtlMs: 30_000,
};

export type MarketDataConfig = typeof MARKET_DATA_DEFAULTS;
