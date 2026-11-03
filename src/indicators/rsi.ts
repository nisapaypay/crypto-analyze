import { Dec, sum, ZERO } from '../app/decimal.js';

/**
 * Wilder's RSI.
 *   Δ_t = close_t − close_{t−1}; gain = max(Δ, 0); loss = max(−Δ, 0)
 *   seed: AG, AL = mean of the first `period` gains/losses
 *   AG_t = (AG_{t−1}·(period−1) + gain_t) / period   (same for AL)
 *   RSI = 100 − 100 / (1 + AG/AL)
 *
 * Conventions:
 *  - AL = 0 and AG > 0 → 100 (no losses in the smoothing window)
 *  - AG = AL = 0       → null (no price movement at all; RSI is undefined)
 *  - A zero-change candle (e.g. a zero-volume carry-forward candle) scales AG
 *    and AL by the same factor, so it leaves the RSI value unchanged.
 */
export function rsiSeries(closes: Dec[], period: number): (Dec | null)[] {
  const out: (Dec | null)[] = closes.map(() => null);
  if (period < 1 || closes.length < period + 1) return out;

  const gains: Dec[] = [];
  const losses: Dec[] = [];
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i]!.minus(closes[i - 1]!);
    gains.push(delta.gt(0) ? delta : ZERO);
    losses.push(delta.lt(0) ? delta.neg() : ZERO);
  }

  let avgGain = sum(gains.slice(0, period)).div(period);
  let avgLoss = sum(losses.slice(0, period)).div(period);
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period; i < gains.length; i++) {
    avgGain = avgGain.times(period - 1).plus(gains[i]!).div(period);
    avgLoss = avgLoss.times(period - 1).plus(losses[i]!).div(period);
    out[i + 1] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: Dec, avgLoss: Dec): Dec | null {
  if (avgLoss.isZero()) return avgGain.isZero() ? null : new Dec(100);
  const rs = avgGain.div(avgLoss);
  return new Dec(100).minus(new Dec(100).div(rs.plus(1)));
}
