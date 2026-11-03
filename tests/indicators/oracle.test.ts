import ti from 'technicalindicators';
import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { atrSeries } from '../../src/indicators/atr.js';
import { emaSeries } from '../../src/indicators/ema.js';
import { rsiSeries } from '../../src/indicators/rsi.js';
import { FIXTURE_PAIRS, loadFixtureCandles } from '../helpers/analysis-fixtures.js';
import { seededRandom } from '../helpers/random.js';

/**
 * Independent oracle: the `technicalindicators` package (dev-only).
 * Known convention differences, verified against hand calculations:
 *  - RSI: the library rounds to 2 decimals → compare within 0.005.
 *  - RSI on a perfectly flat window: library returns 100, we return null.
 *  - ATR: the library skips the first candle's TR (we use H−L, as TradingView);
 *    the seed difference decays by (13/14)^n, so final values agree after ~300 candles.
 */

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe.each(FIXTURE_PAIRS)('oracle vs technicalindicators — %s (real fixtures)', (pair) => {
  for (const tf of ['15', '60'] as const) {
    const { candles } = loadFixtureCandles(pair, tf);
    const closes = candles.map((c) => c.close);
    const num = closes.map((c) => c.toNumber());

    it(`EMA 9/20/50 match the whole series (${tf})`, () => {
      for (const period of [9, 20, 50]) {
        const ours = emaSeries(closes, period).filter((x): x is Dec => x !== null);
        const theirs = ti.EMA.calculate({ period, values: num });
        expect(ours).toHaveLength(theirs.length);
        ours.forEach((v, i) => expect(rel(v.toNumber(), theirs[i]!)).toBeLessThan(1e-9));
      }
    });

    it(`RSI 14 matches within the library's 2-decimal rounding (${tf})`, () => {
      const ours = rsiSeries(closes, 14).slice(15).map((x) => x?.toNumber() ?? null);
      const theirs = ti.RSI.calculate({ period: 14, values: num }).slice(1);
      expect(ours).toHaveLength(theirs.length);
      ours.forEach((v, i) => {
        if (v === null) expect(theirs[i]).toBe(100); // flat window: documented difference
        else expect(Math.abs(v - theirs[i]!)).toBeLessThanOrEqual(0.005 + 1e-9);
      });
    });

    it(`ATR 14 converges to the library's value (${tf})`, () => {
      const ours = atrSeries(candles, 14).at(-1)!.toNumber();
      const theirs = ti.ATR.calculate({
        period: 14,
        high: candles.map((c) => c.high.toNumber()),
        low: candles.map((c) => c.low.toNumber()),
        close: num,
      }).at(-1)!;
      expect(rel(ours, theirs)).toBeLessThan(1e-6);
    });
  }
});

describe('oracle vs technicalindicators — 50 seeded random series', () => {
  const rand = seededRandom(20261102);
  for (let s = 0; s < 50; s++) {
    const n = 120 + Math.floor(rand() * 200);
    let price = 1000 + rand() * 1_000_000;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      price = Math.max(1, price * (1 + (rand() - 0.5) * 0.02));
      closes.push(Math.round(price));
    }

    it(`series ${s}: EMA20 and RSI14`, () => {
      const dec = closes.map((c) => new Dec(c));
      const ema = emaSeries(dec, 20).at(-1)!.toNumber();
      expect(rel(ema, ti.EMA.calculate({ period: 20, values: closes }).at(-1)!)).toBeLessThan(1e-9);
      const rsi = rsiSeries(dec, 14).at(-1)!.toNumber();
      expect(Math.abs(rsi - ti.RSI.calculate({ period: 14, values: closes }).at(-1)!)).toBeLessThanOrEqual(0.005 + 1e-9);
    });
  }
});
