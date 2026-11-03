import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { atrSeries } from '../../src/indicators/atr.js';
import { emaSeries } from '../../src/indicators/ema.js';
import { rsiSeries } from '../../src/indicators/rsi.js';
import type { Candle } from '../../src/market/types.js';
import { seededRandom } from '../helpers/random.js';

function randomCandles(seed: number, n: number, zeroVolumeShare = 0): Candle[] {
  const rand = seededRandom(seed);
  let close = 1000 + rand() * 100000;
  return Array.from({ length: n }, (_, i) => {
    const flat = rand() < zeroVolumeShare;
    const open = close;
    if (!flat) close = Math.max(1, close * (1 + (rand() - 0.5) * 0.03));
    const high = flat ? open : Math.max(open, close) * (1 + rand() * 0.01);
    const low = flat ? open : Math.min(open, close) * (1 - rand() * 0.01);
    return {
      pair: 't_idr',
      timeframe: '15',
      openTime: new Date(i * 900_000),
      open: new Dec(open.toFixed(4)),
      high: new Dec(high.toFixed(4)),
      low: new Dec(low.toFixed(4)),
      close: new Dec(close.toFixed(4)),
      volume: new Dec(flat ? 0 : (rand() * 10).toFixed(8)),
    };
  });
}

describe('indicator properties (100 seeded random series, incl. zero-volume)', () => {
  for (let s = 0; s < 100; s++) {
    const candles = randomCandles(s + 1, 80 + s * 3, (s % 5) * 0.15);
    const closes = candles.map((c) => c.close);

    it(`series ${s}`, () => {
      const min = Dec.min(...closes);
      const max = Dec.max(...closes);
      for (const period of [9, 20, 50]) {
        for (const v of emaSeries(closes, period)) {
          if (v) expect(v.gte(min) && v.lte(max)).toBe(true);
        }
      }
      for (const v of rsiSeries(closes, 14)) {
        if (v) expect(v.gte(0) && v.lte(100)).toBe(true);
      }
      for (const v of atrSeries(candles, 14)) {
        if (v) expect(v.gte(0)).toBe(true);
      }
    });
  }
});

describe('edge-case properties', () => {
  const series = (xs: number[]) => xs.map((x) => new Dec(x));

  it('constant prices: EMA = price, ATR = 0, RSI undefined (null)', () => {
    const flat = Array.from({ length: 60 }, (_, i) => ({
      pair: 't_idr', timeframe: '15' as const, openTime: new Date(i * 900_000),
      open: new Dec(500), high: new Dec(500), low: new Dec(500), close: new Dec(500), volume: new Dec(0),
    }));
    expect(emaSeries(flat.map((c) => c.close), 50).at(-1)!.toFixed()).toBe('500');
    expect(atrSeries(flat, 14).at(-1)!.toFixed()).toBe('0');
    expect(rsiSeries(flat.map((c) => c.close), 14).at(-1)).toBeNull();
  });

  it('strictly rising prices: RSI = 100; strictly falling: RSI = 0', () => {
    expect(rsiSeries(series(Array.from({ length: 30 }, (_, i) => 100 + i)), 14).at(-1)!.toFixed()).toBe('100');
    expect(rsiSeries(series(Array.from({ length: 30 }, (_, i) => 100 - i)), 14).at(-1)!.toFixed()).toBe('0');
  });

  it('insufficient data yields nulls, never guesses', () => {
    expect(emaSeries(series([1, 2, 3]), 9).every((v) => v === null)).toBe(true);
    expect(rsiSeries(series(Array(14).fill(1)), 14).every((v) => v === null)).toBe(true);
  });

  it('same input → identical output (determinism)', () => {
    const c = randomCandles(7, 300, 0.3);
    const a = atrSeries(c, 14).map((v) => v?.toFixed() ?? null);
    const b = atrSeries(c, 14).map((v) => v?.toFixed() ?? null);
    expect(a).toEqual(b);
  });
});
