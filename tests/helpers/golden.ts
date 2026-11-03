import { toJsonSafe, type TechnicalAnalysis } from '../../src/analysis/types.js';

/** The candle-derived part of an analysis, as exact JSON (decimals as strings). */
export function goldenView(a: TechnicalAnalysis): unknown {
  return toJsonSafe({
    engineVersion: a.engineVersion,
    main: a.main,
    trend: a.trend,
    volatility: a.volatility,
    volume: a.volume,
    levels: a.levels && {
      reliability: a.levels.reliability,
      notes: a.levels.notes,
      reference: a.levels.reference,
      supports: a.levels.supports,
      resistances: a.levels.resistances,
      inside: a.levels.inside,
      pivotCount: a.levels.pivotCount,
      rangeHigh: a.levels.rangeHigh,
      rangeLow: a.levels.rangeLow,
    },
  });
}
