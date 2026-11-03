/** Approved Milestone 3 parameters. */
export const ANALYSIS_DEFAULTS = {
  /** Bump whenever a formula or parameter changes; stored with every result. */
  engineVersion: '3.0.0',

  emaPeriods: [9, 20, 50] as const,
  rsiPeriod: 14,
  atrPeriod: 14,
  volumePeriod: 20,

  /** EMA20 slope measured over this many candles (4 × 15m = 1 hour). */
  slopeCandles: 4,
  /** EMA9/EMA20 crossovers reported if they happened within this many candles. */
  crossoverLookback: 3,

  /** Order book imbalance threshold (±0.20) for buy/sell pressure. */
  imbalanceThreshold: 0.2,

  /** Support/resistance. */
  fractalK: 3,
  srToleranceAtr: 0.5,
  /** A zone is "baru" if its last pivot was confirmed within 12 candles (3 h on 15m). */
  srFreshCandles: 12,
  srMaxPerSide: 2,
  /** Candles for the recent-range reference levels (96 × 15m = 24 h). */
  rangeCandles: 96,

  /** An indicator is "kurang andal" when more than 30% of its window has zero volume. */
  zeroVolumeReliabilityThreshold: 0.3,
  /** Below this many candles (× period) an EMA is still warming up. */
  warmupMultiple: 3,
};

export type AnalysisConfig = typeof ANALYSIS_DEFAULTS;
