import { Dec, sum } from '../app/decimal.js';

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * values (TradingView-compatible):
 *   α = 2 / (period + 1)
 *   EMA_t = α·x_t + (1 − α)·EMA_{t−1}
 * Returns a series aligned with `values`; entries before the seed are null.
 */
export function emaSeries(values: Dec[], period: number): (Dec | null)[] {
  const out: (Dec | null)[] = values.map(() => null);
  if (period < 1 || values.length < period) return out;

  const alpha = new Dec(2).div(period + 1);
  const keep = new Dec(1).minus(alpha);
  let ema = sum(values.slice(0, period)).div(period);
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = alpha.times(values[i]!).plus(keep.times(ema));
    out[i] = ema;
  }
  return out;
}
