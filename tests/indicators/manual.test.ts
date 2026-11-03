import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { atrSeries, atrTradedLast, trueRanges } from '../../src/indicators/atr.js';
import { emaSeries } from '../../src/indicators/ema.js';
import { rsiSeries } from '../../src/indicators/rsi.js';
import { volumeStats } from '../../src/indicators/volume.js';
import type { Candle } from '../../src/market/types.js';

/** Hand-checkable examples from the Milestone 3 plan (small periods). */

const d = (xs: (number | string)[]) => xs.map((x) => new Dec(x));
const fixed = (xs: (Dec | null)[], dp = 4) => xs.map((x) => (x ? x.toDecimalPlaces(dp).toFixed() : null));

function candle(h: number | string, l: number | string, c: number | string, volume: number | string = 1, i = 0): Candle {
  const p = (x: number | string) => new Dec(x);
  return { pair: 't_idr', timeframe: '15', openTime: new Date(i * 900_000), open: p(c), high: p(h), low: p(l), close: p(c), volume: p(volume) };
}

describe('EMA — manual example', () => {
  it('EMA(3) of [10, 11, 12, 13, 14] = SMA seed 11, then 12, 13', () => {
    expect(fixed(emaSeries(d([10, 11, 12, 13, 14]), 3))).toEqual([null, null, '11', '12', '13']);
  });

  it('is exact for a non-terminating α (2/21) to 50 significant digits and deterministic', () => {
    const values = d([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    const a = emaSeries(values, 20).at(-1)!;
    const b = emaSeries(values, 20).at(-1)!;
    expect(a.toFixed()).toBe(b.toFixed());
    // SMA(1..20) = 10.5; EMA = 2/21·21 + 19/21·10.5 = 2 + 9.5 = 11.5
    expect(a.toFixed()).toBe('11.5');
  });
});

describe('RSI (Wilder) — manual example', () => {
  const closes = d([10, 11, 10.5, 11.5, 12, 11.8]);

  it('RSI(3) = 80, 84.62, 74.32', () => {
    expect(fixed(rsiSeries(closes, 3), 2)).toEqual([null, null, null, '80', '84.62', '74.32']);
  });

  it('exact intermediate values (AG = 2/3, AL = 1/6 → RS = 4 → RSI 80)', () => {
    expect(rsiSeries(closes, 3)[3]!.toFixed()).toBe('80');
  });

  it('a zero-change (zero-volume carry-forward) candle leaves RSI unchanged', () => {
    const before = rsiSeries(closes, 3).at(-1)!;
    const after = rsiSeries([...closes, new Dec(11.8), new Dec(11.8)], 3);
    expect(after.at(-1)!.toDecimalPlaces(30).eq(before.toDecimalPlaces(30))).toBe(true);
    expect(after.at(-2)!.toDecimalPlaces(30).eq(before.toDecimalPlaces(30))).toBe(true);
  });

  it('no losses → 100; no movement at all → null (undefined, not 100)', () => {
    expect(rsiSeries(d([1, 2, 3, 4, 5]), 3).at(-1)!.toFixed()).toBe('100');
    expect(rsiSeries(d([5, 5, 5, 5, 5]), 3).at(-1)).toBeNull();
  });
});

describe('ATR (Wilder) — manual example', () => {
  const candles = [candle(12, 10, 11, 1, 0), candle(13, 11, 12, 1, 1), candle(12.5, 11.5, 12, 1, 2), candle(14, 12, 13.5, 1, 3)];

  it('true ranges use H−L for the first candle (TradingView convention)', () => {
    expect(fixed(trueRanges(candles))).toEqual(['2', '2', '1', '2']);
  });

  it('ATR(3) = 1.6667, then 1.7778', () => {
    expect(fixed(atrSeries(candles, 3))).toEqual([null, null, '1.6667', '1.7778']);
  });

  it('one zero-volume flat candle drops ATR by a third (1.7778 → 1.1852); traded-only ATR does not', () => {
    const withFlat = [...candles, candle(13.5, 13.5, 13.5, 0, 4)];
    expect(fixed(atrSeries(withFlat, 3)).at(-1)).toBe('1.1852');
    expect(atrTradedLast(withFlat, 3).value!.toDecimalPlaces(4).toFixed()).toBe('1.7778');
    expect(atrTradedLast(withFlat, 3).tradedCount).toBe(4);
  });
});

describe('Volume MA20 / ratio — manual example', () => {
  it('illiquid window: 12 × 1.0 and 8 × 0 → MA 0.6, ratio 1.5 (inflated); traded MA 1.0 → 0.9', () => {
    const window = [...Array(12).fill(1), ...Array(8).fill(0)].map((v, i) => candle(1, 1, 1, v, i));
    const s = volumeStats([...window, candle(1, 1, 1, '0.9', 20)], 20)!;
    expect(s.ma.toFixed()).toBe('0.6');
    expect(s.ratio!.toFixed()).toBe('1.5');
    expect(s.maTraded!.toFixed()).toBe('1');
    expect(s.ratioTraded!.toFixed()).toBe('0.9');
    expect(s.zeroCount).toBe(8);
  });

  it('excludes the current candle from its own average and needs period + 1 candles', () => {
    const spike = [...Array(20).fill(1).map((v, i) => candle(1, 1, 1, v, i)), candle(1, 1, 1, 5, 20)];
    expect(volumeStats(spike, 20)!.ratio!.toFixed()).toBe('5');
    expect(volumeStats(spike.slice(1), 20)).toBeNull();
  });

  it('returns a null ratio when the window has no volume at all', () => {
    const quiet = Array.from({ length: 21 }, (_, i) => candle(1, 1, 1, i === 20 ? 2 : 0, i));
    const s = volumeStats(quiet, 20)!;
    expect(s.ratio).toBeNull();
    expect(s.ratioTraded).toBeNull();
  });
});
