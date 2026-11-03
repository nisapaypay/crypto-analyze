import { describe, expect, it } from 'vitest';
import { ANALYSIS_DEFAULTS } from '../../src/analysis/config.js';
import { analyzeTrend, analyzeVolatility, analyzeVolume } from '../../src/analysis/engine.js';
import { Dec } from '../../src/app/decimal.js';
import { findPivots } from '../../src/indicators/support-resistance.js';
import type { Candle } from '../../src/market/types.js';
import { loadFixtureCandles } from '../helpers/analysis-fixtures.js';
import { LATEST_FINAL_OPEN, makeCandles } from '../helpers/market.js';

const cfg = ANALYSIS_DEFAULTS;

/** Replace candles at the given indexes with zero-volume carry-forward candles, as Indodax does. */
function withCarryForward(candles: Candle[], indexes: number[]): Candle[] {
  const out = [...candles];
  for (const i of [...indexes].sort((a, b) => a - b)) {
    const prev = out[i - 1]!.close;
    out[i] = { ...out[i]!, open: prev, high: prev, low: prev, close: prev, volume: new Dec(0) };
  }
  return out;
}

describe('zero-volume candles are kept and handled per indicator', () => {
  const base = makeCandles(300, LATEST_FINAL_OPEN);

  it('no candle is ever removed: every indicator sees the full window', () => {
    const lots = withCarryForward(base, Array.from({ length: 120 }, (_, i) => 150 + i));
    expect(analyzeTrend(lots, '15', cfg).candleCount).toBe(300);
  });

  it('EMA follows the carried price (time-based), it is not compressed', () => {
    const flatTail = withCarryForward(base, Array.from({ length: 30 }, (_, i) => 270 + i));
    const t = analyzeTrend(flatTail, '15', cfg);
    const carried = flatTail.at(-1)!.close;
    // after 30 flat candles EMA9 has converged towards the last traded price
    expect(t.ema9.value!.minus(carried).abs().div(carried).lt('0.0001')).toBe(true);
  });

  it('RSI is unchanged by appending carry-forward candles', () => {
    const real = loadFixtureCandles('qnt_idr', '15').candles;
    const before = analyzeTrend(real.slice(0, -3), '15', cfg).rsi14.value!;
    const extended = [...real.slice(0, -3)];
    for (let i = 0; i < 3; i++) {
      const prev = extended.at(-1)!;
      extended.push({ ...prev, openTime: new Date(prev.openTime.getTime() + 900_000), open: prev.close, high: prev.close, low: prev.close, volume: new Dec(0) });
    }
    expect(analyzeTrend(extended, '15', cfg).rsi14.value!.toDecimalPlaces(20).eq(before.toDecimalPlaces(20))).toBe(true);
  });

  it('ATR shrinks on flat candles; the traded-only ATR does not, and ATR is flagged', () => {
    const recentFlat = withCarryForward(base, [290, 292, 294, 296, 298]); // 5 of last 14 > 30%
    const v = analyzeVolatility(recentFlat, cfg);
    const clean = analyzeVolatility(base, cfg);
    expect(v.atr14.value!.lt(clean.atr14.value!)).toBe(true);
    expect(v.atr14Traded.value!.gte(v.atr14.value!)).toBe(true);
    expect(v.atr14.reliability).toBe('kurang_andal');
    expect(v.zeroVolumeCount).toBe(5);
  });

  it('Volume MA20 counts zeros; the ratio is flagged above 30% zero-volume', () => {
    const atLimit = withCarryForward(base, [280, 282, 284, 286, 288, 290]); // 6/20 = 30%
    expect(analyzeVolume(atLimit, cfg).ratio.reliability).toBe('andal');
    const above = withCarryForward(base, [280, 282, 284, 286, 288, 290, 292]); // 7/20 = 35%
    const vol = analyzeVolume(above, cfg);
    expect(vol.stats!.zeroCount).toBe(7);
    expect(vol.stats!.ma.toFixed()).toBe('0.325'); // 13 × 0.5 / 20
    expect(vol.ratio.reliability).toBe('kurang_andal');
    expect(vol.stats!.ratioTraded!.toFixed()).toBe('1');
  });

  it('zero-volume candles never become support/resistance pivots', () => {
    const real = loadFixtureCandles('link_idr', '15').candles;
    const zeroTimes = new Set(real.filter((c) => c.volume.isZero()).map((c) => c.openTime.getTime()));
    expect(zeroTimes.size).toBeGreaterThan(50);
    expect(findPivots(real, 3).every((p) => !zeroTimes.has(p.time.getTime()))).toBe(true);
  });
});
