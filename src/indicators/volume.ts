import { sum, type Dec } from '../app/decimal.js';
import type { Candle } from '../market/types.js';

export interface VolumeStats {
  /** Volume of the last final candle (base units). */
  current: Dec;
  /** SMA of the `period` final candles before the current one, zeros included. */
  ma: Dec;
  /** Mean over the traded (volume > 0) candles of the same window; null if none. */
  maTraded: Dec | null;
  /** current / ma; null when ma = 0. */
  ratio: Dec | null;
  /** current / maTraded; null when maTraded is null. */
  ratioTraded: Dec | null;
  zeroCount: number;
  window: number;
}

/**
 * Volume Ratio = Current Volume / Average Volume(period) (PRD §7.2).
 * The current candle is excluded from its own average so a spike does not
 * dilute the baseline. Zero-volume candles count as real (zero) volume.
 * Returns null when fewer than period + 1 candles are available.
 */
export function volumeStats(candles: Candle[], period: number): VolumeStats | null {
  if (candles.length < period + 1) return null;
  const current = candles.at(-1)!.volume;
  const window = candles.slice(-(period + 1), -1).map((c) => c.volume);
  const traded = window.filter((v) => !v.isZero());

  const ma = sum(window).div(period);
  const maTraded = traded.length > 0 ? sum(traded).div(traded.length) : null;
  return {
    current,
    ma,
    maTraded,
    ratio: ma.isZero() ? null : current.div(ma),
    ratioTraded: maTraded ? current.div(maTraded) : null,
    zeroCount: window.length - traded.length,
    window: period,
  };
}
