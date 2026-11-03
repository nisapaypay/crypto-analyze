/**
 * Approved Milestone 4 strategy parameters. Every value is a plain constant;
 * capital, risk per trade, daily limits and costs come from user settings.
 */
export const STRATEGY_DEFAULTS = {
  /** Bump whenever a rule or parameter changes; stored with every signal. */
  engineVersion: '4.0.0',

  regime: {
    /** HIGH_VOLATILITY: ATR% > multiple × median ATR% over the lookback (96 × 15m = 24 h). */
    highVolAtrMultiple: 2,
    highVolLookback: 96,
    /** …or a final candle within `shockLookback` with TR > shockTrMultiple × ATR. */
    shockTrMultiple: 3,
    shockLookback: 2,
  },

  gates: {
    rsiMin: 50,
    rsiMax: 70,
    volumeRatioMin: 1.2,
    maxSpreadPct: 0.4,
    maxSpreadAtr: 0.5,
    /** Spread above this is NO_TRADE regardless of the setup. */
    hardMaxSpreadPct: 1.0,
    /** Order book ±1% imbalance must stay above −threshold (not strong selling). */
    imbalanceMin: -0.2,
    minTradeBuyRatio: 0.4,
    maxExtensionAtr: 1.5,
    /** "Not declining sharply": last candle may not fall more than this many ATR. */
    maxCandleDropAtr: 1.0,
  },

  entry: { widthAtr: 0.25 },
  stop: { atrMultiple: 1.5, structuralBufferAtr: 0.25, minAtr: 1, minSpreads: 3, minTicks: 5, maxAtr: 3 },
  takeProfit: { rrCap: 3, resistanceBufferAtr: 0.1 },
  /** Net R/R after fees, taxes and slippage. */
  minNetRr: 1.5,

  sizing: {
    /** Default when user_settings.max_position_alloc_pct is empty. */
    maxAllocPct: '50',
    /** Liquidity: at most 50% of the ask depth within ±1% and 1% of the 24 h IDR volume. */
    depthShare: 0.5,
    volumeShare: 0.01,
    depthBandPct: 1,
  },

  signal: {
    /** Valid until this many further 15m candles have closed (30 min). */
    validCandles: 2,
    /** Shown to the user: do not chase above entry max + chaseAtr·ATR. */
    chaseAtr: 0.5,
    /** Hypothetical/backtest time stop: 48 × 15m = 12 h. */
    timeStopCandles: 48,
  },

  /** Remaining daily planned risk below this share of the per-trade risk → NO_TRADE. */
  minBudgetShare: 0.5,

  earlyWarning: {
    minSignals: 2,
    rsiRecoverFrom: 45,
    rsiRecoverTo: 55,
    rsiLookback: 4,
    volumeRatioMin: 1.0,
    nearZoneAtr: 0.5,
  },

  ranking: { rr: 0.4, volume: 0.2, trend: 0.2, orderBook: 0.2 },
};

export type StrategyConfig = typeof STRATEGY_DEFAULTS;

/** Deep-merge a partial override (used by backtest parameter grids). */
export function withStrategyOverrides(overrides: DeepPartial<StrategyConfig> = {}): StrategyConfig {
  const out = structuredClone(STRATEGY_DEFAULTS) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key];
    out[key] = value && typeof value === 'object' && current && typeof current === 'object' ? { ...current, ...value } : value;
  }
  return out as StrategyConfig;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };
