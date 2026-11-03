import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dec } from '../../src/app/decimal.js';
import { parseLosslessJson } from '../../src/exchange/indodax/lossless-json.js';
import { ohlcSchema } from '../../src/exchange/indodax/types.js';
import type { PairMarketData } from '../../src/market/market-data-service.js';
import type { Candle, Timeframe } from '../../src/market/types.js';

export const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'analysis');
export const GOLDEN_DIR = join(FIXTURE_DIR, 'golden');
export const FIXTURE_PAIRS = ['qnt_idr', 'doge_idr', 'xrp_idr', 'link_idr'] as const;

/** Real, frozen Indodax candles, parsed exactly like production does. */
export function loadFixtureCandles(pair: string, timeframe: Timeframe): { candles: Candle[]; recordedAt: Date } {
  const raw = parseLosslessJson(readFileSync(join(FIXTURE_DIR, `${pair}-${timeframe}.json`), 'utf8')) as {
    recordedAt: string;
    candles: unknown;
  };
  const candles = ohlcSchema.parse(raw.candles).map((c) => ({
    pair,
    timeframe,
    openTime: new Date(Number(c.Time) * 1000),
    open: new Dec(c.Open),
    high: new Dec(c.High),
    low: new Dec(c.Low),
    close: new Dec(c.Close),
    volume: new Dec(c.Volume),
  }));
  return { candles, recordedAt: new Date(Number(raw.recordedAt) * 1000) };
}

/** Market data built from fixtures only (no live ticker/order book). */
export function fixtureMarketData(pair: string): { data: PairMarketData; now: Date } {
  const main = loadFixtureCandles(pair, '15');
  const trend = loadFixtureCandles(pair, '60');
  const now = main.recordedAt;
  return {
    now,
    data: {
      pair,
      pairInfo: null,
      fetchedAt: now,
      timeframe: '15',
      ticker: null,
      orderBook: null,
      metrics: null,
      tradeActivity: null,
      finalCandles: main.candles,
      pendingCandle: null,
      quality: { status: 'OK', issues: [], checkedAt: now },
      trendTimeframe: '60',
      trendCandles: trend.candles,
      trendError: null,
      snapshotId: null,
    },
  };
}
