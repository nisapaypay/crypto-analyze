import type { Dec } from '../app/decimal.js';
import type { TechnicalAnalysis, TrendAnalysis } from '../analysis/types.js';
import { atrSeries, trueRanges } from '../indicators/atr.js';
import type { Candle } from '../market/types.js';
import type { StrategyConfig } from './config.js';
import type { RegimeResult } from './types.js';

function median(values: Dec[]): Dec | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]!.plus(sorted[mid]!).div(2);
}

const usable = (t: TrendAnalysis | null): t is TrendAnalysis => !!t && !t.unavailableReason && t.stack.value !== null;

/**
 * Market regime from final candles only. Priority:
 *   1. HIGH_VOLATILITY — ATR% > k × its 24 h median, or a recent shock candle (TR > 3 ATR)
 *   2. BULLISH — 1H EMA9>EMA20>EMA50, 1H close > EMA50, 1H EMA20 slope ≥ 0, 15m close > EMA50
 *   3. BEARISH — 1H EMA9<EMA20<EMA50 and 1H close < EMA50, or 15m stack down with 1H slope < 0
 *   4. SIDEWAYS — anything else
 * Without usable 1H data the regime comes from 15m only and is unconfirmed.
 */
export function detectRegime(a: TechnicalAnalysis, candles: Candle[], cfg: StrategyConfig['regime'], atrPeriod: number): RegimeResult {
  const notes: string[] = [];
  const atr = atrSeries(candles, atrPeriod);
  const atrPcts: Dec[] = [];
  candles.forEach((c, i) => {
    const v = atr[i];
    if (v && c.close.gt(0)) atrPcts.push(v.div(c.close).times(100));
  });
  const atrPct = atrPcts.at(-1) ?? null;
  const atrPctMedian = median(atrPcts.slice(-cfg.highVolLookback));

  const trs = trueRanges(candles);
  let shock = false;
  for (let back = 1; back <= cfg.shockLookback; back++) {
    const i = candles.length - back;
    const tr = trs[i];
    const prevAtr = atr[i - 1];
    if (tr && prevAtr && prevAtr.gt(0) && tr.gt(prevAtr.times(cfg.shockTrMultiple))) shock = true;
  }

  const main = a.main;
  const h1 = usable(a.trend) ? a.trend : null;
  const confirmed1h = h1 !== null;
  if (!confirmed1h) notes.push(`konfirmasi 1 jam tidak tersedia${a.trend?.unavailableReason ? `: ${a.trend.unavailableReason}` : ''}`);

  const highVol = !!(atrPct && atrPctMedian && atrPctMedian.gt(0) && atrPct.gt(atrPctMedian.times(cfg.highVolAtrMultiple)));
  if (highVol || shock) {
    if (highVol) notes.push(`ATR% ${atrPct!.toFixed(2)} > ${cfg.highVolAtrMultiple}× median 24 jam (${atrPctMedian!.toFixed(2)})`);
    if (shock) notes.push(`candle dengan true range > ${cfg.shockTrMultiple}× ATR dalam ${cfg.shockLookback} candle terakhir`);
    return { regime: 'HIGH_VOLATILITY', confirmed1h, notes, atrPct, atrPctMedian, shock };
  }

  const above50 = (t: TrendAnalysis) => !!t.closeVsEma50Pct && t.closeVsEma50Pct.gt(0);
  const below50 = (t: TrendAnalysis) => !!t.closeVsEma50Pct && t.closeVsEma50Pct.lt(0);
  const slope = (t: TrendAnalysis) => t.ema20SlopePct.value;

  if (h1 && main) {
    const s1 = slope(h1);
    if (h1.stack.value === 'naik' && above50(h1) && s1 && s1.gte(0) && above50(main)) {
      return { regime: 'BULLISH', confirmed1h, notes, atrPct, atrPctMedian, shock };
    }
    if ((h1.stack.value === 'turun' && below50(h1)) || (main.stack.value === 'turun' && s1 && s1.lt(0))) {
      return { regime: 'BEARISH', confirmed1h, notes, atrPct, atrPctMedian, shock };
    }
    return { regime: 'SIDEWAYS', confirmed1h, notes, atrPct, atrPctMedian, shock };
  }

  // 15m only (unconfirmed).
  if (main && main.stack.value === 'naik' && above50(main) && slope(main)?.gte(0)) {
    return { regime: 'BULLISH', confirmed1h, notes, atrPct, atrPctMedian, shock };
  }
  if (main && main.stack.value === 'turun') return { regime: 'BEARISH', confirmed1h, notes, atrPct, atrPctMedian, shock };
  return { regime: 'SIDEWAYS', confirmed1h, notes, atrPct, atrPctMedian, shock };
}
