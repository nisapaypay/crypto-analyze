import { TIMEFRAME_SECONDS, type Candle, type Timeframe } from '../market/types.js';

export interface CandleSource {
  getCandles(tickerId: string, timeframe: Timeframe, from: Date, to: Date): Promise<Candle[]>;
}

/** Candles per request: Indodax returns at most ~865 (15m) / ~649 (1H) per call. */
export const CHUNK_CANDLES: Partial<Record<Timeframe, number>> = { '15': 800, '60': 600 };

/**
 * Page through Indodax `history_v2` (Public API, GET only) from `from` to `to`.
 * Returns ascending, de-duplicated candles plus the number of missing intervals.
 * Non-final candles at the end are the caller's responsibility to drop.
 */
export async function fetchHistory(
  source: CandleSource,
  pair: string,
  timeframe: Timeframe,
  from: Date,
  to: Date,
  onProgress?: (fetched: number) => void,
): Promise<{ candles: Candle[]; gaps: number }> {
  const stepMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  const chunkMs = (CHUNK_CANDLES[timeframe] ?? 500) * stepMs;
  const byTime = new Map<number, Candle>();
  for (let start = from.getTime(); start < to.getTime(); start += chunkMs) {
    const end = Math.min(start + chunkMs - stepMs, to.getTime());
    const batch = await source.getCandles(pair, timeframe, new Date(start), new Date(end));
    for (const c of batch) byTime.set(c.openTime.getTime(), c);
    onProgress?.(byTime.size);
  }
  const candles = [...byTime.values()].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    gaps += Math.max(0, Math.round((candles[i]!.openTime.getTime() - candles[i - 1]!.openTime.getTime()) / stepMs) - 1);
  }
  return { candles, gaps };
}
