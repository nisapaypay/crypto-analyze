import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dec } from '../app/decimal.js';
import type { Candle, PairInfo, Timeframe } from '../market/types.js';

export const BACKTEST_DIR = 'data/backtest';

/** Pair rules and a live spread sample captured when the history was fetched. */
export interface PairMeta {
  pair: string;
  tickSize: string | null;
  quantityIncrement: string | null;
  minOrderIdr: string | null;
  minOrderBase: string | null;
  /** Live spread (%) at fetch time; historical spreads are not available. */
  spreadPctSample: string | null;
}

export interface StoredSeries {
  pair: string;
  timeframe: Timeframe;
  fetchedAt: string;
  from: string;
  to: string;
  count: number;
  /** Interval gaps found when fetching (the simulator treats them as unavailable data). */
  gaps: number;
  sha256: string;
  meta: PairMeta;
  /** [openTimeSec, open, high, low, close, volume] as exact strings. */
  candles: [number, string, string, string, string, string][];
}

export function seriesPath(pair: string, timeframe: Timeframe, dir = BACKTEST_DIR): string {
  return join(dir, `${pair}-${timeframe}.json`);
}

export function hashCandles(rows: StoredSeries['candles']): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function toRows(candles: Candle[]): StoredSeries['candles'] {
  return candles.map((c) => [
    Math.floor(c.openTime.getTime() / 1000),
    c.open.toFixed(),
    c.high.toFixed(),
    c.low.toFixed(),
    c.close.toFixed(),
    c.volume.toFixed(),
  ]);
}

export function fromRows(pair: string, timeframe: Timeframe, rows: StoredSeries['candles']): Candle[] {
  return rows.map(([t, o, h, l, c, v]) => ({
    pair,
    timeframe,
    openTime: new Date(t * 1000),
    open: new Dec(o),
    high: new Dec(h),
    low: new Dec(l),
    close: new Dec(c),
    volume: new Dec(v),
  }));
}

export function saveSeries(s: StoredSeries, dir = BACKTEST_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = seriesPath(s.pair, s.timeframe, dir);
  writeFileSync(path, JSON.stringify(s));
  return path;
}

export function loadSeries(pair: string, timeframe: Timeframe, dir = BACKTEST_DIR): StoredSeries {
  const path = seriesPath(pair, timeframe, dir);
  if (!existsSync(path)) throw new Error(`Data backtest ${path} belum ada. Jalankan: pnpm backtest:fetch`);
  const s = JSON.parse(readFileSync(path, 'utf8')) as StoredSeries;
  if (hashCandles(s.candles) !== s.sha256) throw new Error(`Hash data ${path} tidak cocok; file berubah setelah diunduh.`);
  return s;
}

export function pairInfoFromMeta(m: PairMeta): PairInfo {
  const dec = (v: string | null) => (v === null ? null : new Dec(v));
  return {
    tickerId: m.pair,
    pathId: m.pair.replace('_', ''),
    symbol: m.pair.replace('_', '').toUpperCase(),
    baseAsset: m.pair.split('_')[0]!,
    quoteAsset: 'idr',
    description: m.pair.toUpperCase(),
    tickSize: dec(m.tickSize),
    quantityIncrement: dec(m.quantityIncrement),
    minOrderIdr: dec(m.minOrderIdr),
    minOrderBase: dec(m.minOrderBase),
    takerFeePct: null,
    makerFeePct: null,
    isMaintenance: false,
    isSuspended: false,
  };
}
