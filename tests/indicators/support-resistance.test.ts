import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { classifyImbalance, classifyTradeFlow, isConsistent } from '../../src/indicators/orderbook-pressure.js';
import { findPivots, supportResistance } from '../../src/indicators/support-resistance.js';
import type { Candle } from '../../src/market/types.js';

/** Candles from (high, low) pairs; close = midpoint; volume 1 unless listed as zero. */
function series(points: [number, number][], zeroVolume: number[] = []): Candle[] {
  return points.map(([h, l], i) => ({
    pair: 't_idr',
    timeframe: '15',
    openTime: new Date(Date.UTC(2026, 10, 2) + i * 900_000),
    open: new Dec((h + l) / 2),
    high: new Dec(h),
    low: new Dec(l),
    close: new Dec((h + l) / 2),
    volume: new Dec(zeroVolume.includes(i) ? 0 : 1),
  }));
}

const params = { k: 3, toleranceAtr: 0.5, freshCandles: 12, maxPerSide: 2 };

describe('findPivots (fractal k = 3)', () => {
  // index:          0        1        2        3         4        5        6        7        8
  const pts: [number, number][] = [[105, 95], [106, 96], [107, 97], [110, 100], [107, 97], [106, 96], [105, 90], [104, 94], [103, 93]];

  it('finds a swing high confirmed k candles later and never the newest k candles', () => {
    const pivots = findPivots(series(pts), 3);
    expect(pivots).toEqual([
      expect.objectContaining({ type: 'high', index: 3, confirmedAt: series(pts)[6]!.openTime }),
    ]);
    expect(pivots.every((p) => p.index <= pts.length - 1 - 3)).toBe(true);
  });

  it('never uses a zero-volume candle as a pivot', () => {
    expect(findPivots(series(pts, [3]), 3).filter((p) => p.index === 3)).toEqual([]);
  });

  it('resolves equal highs to the earlier candle (no double pivot)', () => {
    const tie: [number, number][] = [[100, 90], [101, 91], [102, 92], [110, 100], [110, 100], [102, 92], [101, 91], [100, 90]];
    expect(findPivots(series(tie), 3).map((p) => p.index)).toEqual([3]);
  });
});

describe('supportResistance', () => {
  // Two swing lows near 100 (zone), one swing high near 120; price at the end ≈ 110.
  const pts: [number, number][] = [
    [112, 108], [111, 106], [110, 104], [106, 100], [110, 104], [114, 108], [118, 112],
    [120, 114], [118, 112], [114, 108], [110, 104], [106, 100.4], [110, 104], [112, 106],
    [113, 107], [112, 108], [111, 109], [112, 108], [111, 109], [112, 108],
  ];
  const candles = series(pts);
  const price = new Dec(110);
  const atr = new Dec(4); // tolerance = 2
  const sr = supportResistance(candles, price, atr, params);

  it('clusters nearby pivots into a zone with touches, price/ATR distance and pivot times', () => {
    const s = sr.supports[0]!;
    expect(s.zone.low.toFixed()).toBe('100');
    expect(s.zone.high.toFixed()).toBe('100.4');
    expect(s.zone.touches).toBe(2);
    expect(s.zone.swingLows).toBe(2);
    expect(s.distance.toFixed()).toBe('9.6');
    expect(s.distancePct.toDecimalPlaces(4).toFixed()).toBe('8.7273');
    expect(s.distanceAtr!.toFixed()).toBe('2.4');
    expect(s.zone.firstPivotAt).toEqual(candles[3]!.openTime);
    expect(s.zone.lastPivotAt).toEqual(candles[11]!.openTime);
    expect(s.zone.lastConfirmedAt).toEqual(candles[14]!.openTime);
  });

  it('reports resistances above price, nearest first', () => {
    // swing high 113 at index 14, then the older swing high 120 at index 7
    expect(sr.resistances.map((r) => [r.zone.low.toFixed(), r.distance.toFixed()])).toEqual([
      ['113', '3'],
      ['120', '10'],
    ]);
  });

  it('distinguishes newly confirmed zones from old ones', () => {
    // last support pivot at index 11, confirmed at 14; newest index 19 → 5 candles ago → "baru"
    expect(sr.supports[0]!.zone.candlesSinceConfirmed).toBe(5);
    expect(sr.supports[0]!.zone.freshness).toBe('baru');
    const old = supportResistance(candles, price, atr, { ...params, freshCandles: 4 });
    expect(old.supports[0]!.zone.freshness).toBe('lama');
  });

  it('is deterministic', () => {
    const again = supportResistance(candles, price, atr, params);
    expect(JSON.stringify(again, (_k, v) => (v instanceof Dec ? v.toFixed() : v))).toBe(
      JSON.stringify(sr, (_k, v) => (v instanceof Dec ? v.toFixed() : v)),
    );
  });
});

describe('order book pressure', () => {
  it('classifies imbalance with the ±0.20 threshold', () => {
    expect(classifyImbalance(new Dec('0.2'), 0.2)).toBe('beli');
    expect(classifyImbalance(new Dec('-0.2'), 0.2)).toBe('jual');
    expect(classifyImbalance(new Dec('0.19'), 0.2)).toBe('seimbang');
  });

  it('classifies trade flow around 50% buy share and checks consistency', () => {
    expect(classifyTradeFlow(new Dec('0.6'), 0.2)).toBe('beli');
    expect(classifyTradeFlow(new Dec('0.4'), 0.2)).toBe('jual');
    expect(classifyTradeFlow(new Dec('0.5'), 0.2)).toBe('seimbang');
    expect(isConsistent('beli', 'jual')).toBe(false);
    expect(isConsistent('beli', 'seimbang')).toBe(true);
  });
});
