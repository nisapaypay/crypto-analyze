import { Dec, sum } from '../app/decimal.js';
import type { Candle } from '../market/types.js';

/**
 * True range: max(H − L, |H − C_prev|, |L − C_prev|).
 * The first candle has no previous close, so its TR is H − L
 * (TradingView `ta.tr(true)` convention).
 */
export function trueRanges(candles: Candle[]): Dec[] {
  return candles.map((c, i) => {
    const range = c.high.minus(c.low);
    if (i === 0) return range;
    const prevClose = candles[i - 1]!.close;
    return Dec.max(range, c.high.minus(prevClose).abs(), c.low.minus(prevClose).abs());
  });
}

/**
 * Wilder smoothing (RMA), seeded with the SMA of the first `period` values:
 *   x̄_t = (x̄_{t−1}·(period−1) + x_t) / period
 * Returns the series aligned with `values`; entries before the seed are null.
 */
export function wilderSeries(values: Dec[], period: number): (Dec | null)[] {
  const out: (Dec | null)[] = values.map(() => null);
  if (period < 1 || values.length < period) return out;
  let avg = sum(values.slice(0, period)).div(period);
  out[period - 1] = avg;
  for (let i = period; i < values.length; i++) {
    avg = avg.times(period - 1).plus(values[i]!).div(period);
    out[i] = avg;
  }
  return out;
}

/** Wilder's ATR over all candles (standard; matches charting platforms). */
export function atrSeries(candles: Candle[], period: number): (Dec | null)[] {
  return wilderSeries(trueRanges(candles), period);
}

/**
 * ATR over candles that actually traded. Zero-volume carry-forward candles
 * have TR = 0 and pull the standard ATR down; this variant skips them.
 * TR of a traded candle still uses the previous candle's close, which for a
 * carry-forward candle equals the last traded close.
 */
export function atrTradedLast(candles: Candle[], period: number): { value: Dec | null; tradedCount: number } {
  const trs = trueRanges(candles).filter((_, i) => !candles[i]!.volume.isZero());
  return { value: wilderSeries(trs, period).at(-1) ?? null, tradedCount: trs.length };
}
