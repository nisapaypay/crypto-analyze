import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dec } from '../../../src/app/decimal.js';
import { fromRows, loadSeries, pairInfoFromMeta } from '../../../src/backtest/dataset.js';
import type { PairSeries } from '../../../src/backtest/simulator.js';
import { planPeriods } from '../../../src/backtest/walk-forward.js';
import { TIMEFRAME_SECONDS, type Candle } from '../../../src/market/types.js';

export const EXPERIMENT_DATA_DIR = 'experiments/m4-followup/data';

/** Production PairSeries (15m + 1H) plus the 4H series used by experiment 1/2. */
export interface ExpSeries extends PairSeries {
  c240: Candle[];
}

export interface PairFees {
  takerFeePct: string | null;
  makerFeePct: string | null;
  fetchedAt: string;
}

export function loadExpSeries(pair: string, dir = EXPERIMENT_DATA_DIR): ExpSeries {
  const s15 = loadSeries(pair, '15', dir);
  return {
    pair,
    info: pairInfoFromMeta(s15.meta),
    spreadPct: new Dec(s15.meta.spreadPctSample ?? '0.3'),
    c15: fromRows(pair, '15', s15.candles),
    c60: fromRows(pair, '60', loadSeries(pair, '60', dir).candles),
    c240: fromRows(pair, '240', loadSeries(pair, '240', dir).candles),
  };
}

export function loadPairFees(dir = EXPERIMENT_DATA_DIR): Record<string, PairFees> {
  const path = join(dir, 'pair-fees.json');
  if (!existsSync(path)) throw new Error(`${path} belum ada. Jalankan experiments/m4-followup/fetch.ts`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, PairFees>;
}

/**
 * The SAME 12-block split as `pnpm backtest` (computed from the 15m + 1H
 * series only), so baseline and experiments share identical calendar periods.
 */
export function experimentPeriods(series: ExpSeries[]) {
  return planPeriods(series);
}

/**
 * Physically removes every candle that has not CLOSED before `end`, on every
 * timeframe. Stricter than the production `truncateSeries` (open time), so a
 * 1H/4H candle straddling the holdout boundary never leaks holdout prices.
 */
export function hideHoldout(series: ExpSeries[], end: Date): ExpSeries[] {
  const closedBefore = (c: Candle) => c.openTime.getTime() + TIMEFRAME_SECONDS[c.timeframe] * 1000 <= end.getTime();
  return series.map((s) => ({ ...s, c15: s.c15.filter(closedBefore), c60: s.c60.filter(closedBefore), c240: s.c240.filter(closedBefore) }));
}

/** Throws if any candle at/after the holdout start is still present (defence in depth). */
export function assertNoHoldout(series: ExpSeries[], holdoutStart: Date): void {
  for (const s of series) {
    for (const c of [...s.c15, ...s.c60, ...s.c240]) {
      if (c.openTime.getTime() + TIMEFRAME_SECONDS[c.timeframe] * 1000 > holdoutStart.getTime()) {
        throw new Error(`Holdout bocor: ${s.pair} ${c.timeframe}m ${c.openTime.toISOString()}`);
      }
    }
  }
}
