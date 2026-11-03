/**
 * Long-history experiment (≈3 years). Every boundary is a fixed constant so a
 * re-fetch on another day cannot move data across the holdout line.
 */
export const LONG_DATA_DIR = 'experiments/long-history/data/dev';
export const LONG_REPORT_DIR = 'experiments/long-history/reports';

/**
 * Holdout start — identical to the boundary of the previous experiment
 * (experiments/m4-followup, holdout 2026-08-02 → 2026-11-03). Candles that do
 * not CLOSE before this instant are never requested, stored, or read here.
 */
export const HOLDOUT_START = new Date('2026-08-02T00:00:00.000Z');

/** First candle requested (warm-up: ≥ 300 × 4H candles before the first decision). */
export const FETCH_FROM = new Date('2023-11-01T00:00:00.000Z');

/** First decision of the development period. */
export const DEV_START = new Date('2024-01-01T00:00:00.000Z');

/** Walk-forward: train 12 calendar months → test the next 3, rolling by 3. */
export const WF = { trainMonths: 12, testMonths: 3, stepMonths: 3, minTrades: 30 };

/** Monthly market phase label (pair's own monthly return): ≥ +10% bullish, ≤ −10% bearish, else sideways. */
export const PHASE_THRESHOLD_PCT = 10;

export const PRIMARY = ['doge_idr', 'xrp_idr'];
export const COMPARISON = ['qnt_idr', 'link_idr'];
export const ALL_PAIRS = [...PRIMARY, ...COMPARISON];
