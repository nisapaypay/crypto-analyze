import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from './types.js';

const tfMs = (tf: Timeframe) => TIMEFRAME_SECONDS[tf] * 1000;

/** A candle is final once it has closed and the settle period has passed. */
export function isFinalCandle(candle: Candle, now: Date, settleSec: number): boolean {
  return candle.openTime.getTime() + tfMs(candle.timeframe) + settleSec * 1000 <= now.getTime();
}

/**
 * Split candles into final ones (safe to store and use for indicators) and
 * the most recent non-final one (unconfirmed; never stored).
 */
export function splitFinalCandles(
  candles: Candle[],
  now: Date,
  settleSec: number,
): { final: Candle[]; pending: Candle | null } {
  const final = candles.filter((c) => isFinalCandle(c, now, settleSec));
  const pending = candles.filter((c) => !isFinalCandle(c, now, settleSec)).at(-1) ?? null;
  return { final, pending };
}

/** Open time of the newest candle that should already be final at `now`. */
export function expectedLatestFinalOpenTime(timeframe: Timeframe, now: Date, settleSec: number): Date {
  const step = tfMs(timeframe);
  const latestClosedBy = now.getTime() - settleSec * 1000 - step;
  return new Date(Math.floor(latestClosedBy / step) * step);
}

export function isZeroVolume(candle: Candle): boolean {
  return candle.volume.isZero();
}

export function hasValidOhlc(c: Candle): boolean {
  const positive = [c.open, c.high, c.low, c.close].every((v) => v.isPositive() && !v.isZero());
  return (
    positive &&
    !c.volume.isNegative() &&
    c.low.lte(c.open) &&
    c.low.lte(c.close) &&
    c.high.gte(c.open) &&
    c.high.gte(c.close)
  );
}

export interface CandleSeriesAnalysis {
  count: number;
  duplicates: number;
  misaligned: number;
  /** Number of missing intervals between consecutive candles. */
  missingIntervals: number;
  invalidOhlc: number;
  latestOpenTime: Date | null;
  /** Zero-volume candles among the last `lookback` candles. */
  zeroVolumeRecent: number;
  recentCount: number;
}

/** Structural checks on an ascending series of final candles of one timeframe. */
export function analyzeCandleSeries(candles: Candle[], timeframe: Timeframe, lookback: number): CandleSeriesAnalysis {
  const step = tfMs(timeframe);
  let duplicates = 0;
  let missingIntervals = 0;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i]!.openTime.getTime() - candles[i - 1]!.openTime.getTime();
    if (diff <= 0) duplicates++;
    else if (diff > step) missingIntervals += Math.round(diff / step) - 1;
  }
  const recent = candles.slice(-lookback);
  return {
    count: candles.length,
    duplicates,
    misaligned: candles.filter((c) => c.openTime.getTime() % step !== 0).length,
    missingIntervals,
    invalidOhlc: candles.filter((c) => !hasValidOhlc(c)).length,
    latestOpenTime: candles.at(-1)?.openTime ?? null,
    zeroVolumeRecent: recent.filter(isZeroVolume).length,
    recentCount: recent.length,
  };
}
