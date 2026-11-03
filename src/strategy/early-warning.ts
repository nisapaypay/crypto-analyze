import type { Dec } from '../app/decimal.js';
import type { TechnicalAnalysis } from '../analysis/types.js';
import { rsiSeries } from '../indicators/rsi.js';
import { volumeStats } from '../indicators/volume.js';
import type { Candle } from '../market/types.js';
import type { StrategyConfig } from './config.js';

/**
 * EARLY_WARNING signals (PRD §8.2): promising but unconfirmed. Never a BUY.
 * Returns the human-readable signals that are present.
 */
export function earlyWarningSignals(
  a: TechnicalAnalysis,
  candles: Candle[],
  atr: Dec | null,
  cfg: StrategyConfig['earlyWarning'],
  rsiPeriod: number,
  volumePeriod: number,
): string[] {
  const m = a.main;
  if (!m) return [];
  const out: string[] = [];

  if (m.crossover?.direction === 'ke_atas') {
    out.push(`EMA9 baru menyilang ke atas EMA20 (${m.crossover.candlesAgo === 0 ? 'candle terakhir' : `${m.crossover.candlesAgo} candle lalu`})`);
  }

  const rsi = rsiSeries(candles.map((c) => c.close), rsiPeriod);
  const now = rsi.at(-1);
  const before = rsi.slice(-1 - cfg.rsiLookback, -1).filter((v): v is Dec => v !== null);
  if (now && now.gte(cfg.rsiRecoverFrom) && now.lte(cfg.rsiRecoverTo) && before.some((v) => v.lt(cfg.rsiRecoverFrom))) {
    out.push(`RSI pulih dari < ${cfg.rsiRecoverFrom} ke ${now.toFixed(1)}`);
  }

  const ratio = a.volume?.ratio.value;
  const prev = volumeStats(candles.slice(0, -1), volumePeriod)?.ratio ?? null;
  if (ratio && ratio.gte(cfg.volumeRatioMin) && prev && ratio.gt(prev)) {
    out.push(`volume mulai meningkat (${ratio.toFixed(2)}× dari ${prev.toFixed(2)}×)`);
  }

  if (atr && m.close) {
    const r = a.levels?.resistances[0];
    const s = a.levels?.supports[0];
    const e20 = m.ema20.value;
    const aboveEma20Atr = e20 ? m.close.minus(e20).div(atr) : null;
    if (r?.distanceAtr && r.distanceAtr.lte(cfg.nearZoneAtr)) out.push('harga mendekati area breakout (resistance)');
    else if (s?.distanceAtr && s.distanceAtr.lte(cfg.nearZoneAtr)) out.push('harga mendekati area support (pullback)');
    else if (aboveEma20Atr && aboveEma20Atr.gte(0) && aboveEma20Atr.lte(cfg.nearZoneAtr)) out.push('harga dekat EMA20 (pullback)');
  }
  return out;
}
