import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import {
  analyzeCandleSeries,
  expectedLatestFinalOpenTime,
  hasValidOhlc,
  splitFinalCandles,
} from '../../src/market/candles.js';
import { LATEST_FINAL_OPEN, makeCandles, NOW } from '../helpers/market.js';

const SETTLE = 90;

describe('splitFinalCandles', () => {
  it('excludes the in-progress candle and keeps it as pending', () => {
    const candles = makeCandles(5, new Date('2026-11-02T09:15:00Z'));
    const { final, pending } = splitFinalCandles(candles, NOW, SETTLE);
    expect(final.at(-1)!.openTime).toEqual(LATEST_FINAL_OPEN);
    expect(final).toHaveLength(4);
    expect(pending!.openTime).toEqual(new Date('2026-11-02T09:15:00Z'));
  });

  it('treats a just-closed candle as pending until the settle period passes (Cloudflare caches OHLC 60 s)', () => {
    const candles = makeCandles(3, new Date('2026-11-02T09:00:00Z'));
    const justClosed = new Date('2026-11-02T09:15:30Z'); // 30 s after close
    expect(splitFinalCandles(candles, justClosed, SETTLE).pending!.openTime).toEqual(LATEST_FINAL_OPEN);
    const settled = new Date('2026-11-02T09:16:30Z'); // 90 s after close
    expect(splitFinalCandles(candles, settled, SETTLE).pending).toBeNull();
  });
});

describe('expectedLatestFinalOpenTime', () => {
  it('matches the settle rule', () => {
    expect(expectedLatestFinalOpenTime('15', NOW, SETTLE)).toEqual(LATEST_FINAL_OPEN);
    expect(expectedLatestFinalOpenTime('15', new Date('2026-11-02T09:16:29Z'), SETTLE)).toEqual(new Date('2026-11-02T08:45:00Z'));
    expect(expectedLatestFinalOpenTime('15', new Date('2026-11-02T09:16:30Z'), SETTLE)).toEqual(LATEST_FINAL_OPEN);
  });
});

describe('analyzeCandleSeries', () => {
  it('reports a clean series', () => {
    const a = analyzeCandleSeries(makeCandles(30, LATEST_FINAL_OPEN), '15', 20);
    expect(a).toMatchObject({ count: 30, duplicates: 0, misaligned: 0, missingIntervals: 0, invalidOhlc: 0, zeroVolumeRecent: 0, recentCount: 20 });
  });

  it('counts zero-volume (no-trade) candles among the most recent ones only', () => {
    const candles = makeCandles(40, LATEST_FINAL_OPEN, { zeroVolumeFromEnd: [0, 3, 7, 25, 30] });
    expect(analyzeCandleSeries(candles, '15', 20).zeroVolumeRecent).toBe(3);
  });

  it('detects gaps, duplicates and misalignment', () => {
    const candles = makeCandles(10, LATEST_FINAL_OPEN);
    const gapped = [...candles.slice(0, 4), ...candles.slice(6)];
    expect(analyzeCandleSeries(gapped, '15', 20).missingIntervals).toBe(2);

    const duplicated = [...candles.slice(0, 5), candles[4]!, ...candles.slice(5)];
    expect(analyzeCandleSeries(duplicated, '15', 20).duplicates).toBe(1);

    const shifted = candles.map((c, i) => (i === 3 ? { ...c, openTime: new Date(c.openTime.getTime() + 60_000) } : c));
    expect(analyzeCandleSeries(shifted, '15', 20).misaligned).toBe(1);
  });
});

describe('hasValidOhlc', () => {
  const [c] = makeCandles(1, LATEST_FINAL_OPEN);
  it('accepts a sane candle, including zero volume', () => {
    expect(hasValidOhlc(c!)).toBe(true);
    expect(hasValidOhlc({ ...c!, volume: new Dec(0) })).toBe(true);
  });
  it('rejects impossible values', () => {
    expect(hasValidOhlc({ ...c!, high: c!.low.minus(1) })).toBe(false);
    expect(hasValidOhlc({ ...c!, low: new Dec(0) })).toBe(false);
    expect(hasValidOhlc({ ...c!, volume: new Dec(-1) })).toBe(false);
  });
});
