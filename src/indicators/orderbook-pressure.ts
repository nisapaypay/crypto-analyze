import type { Dec } from '../app/decimal.js';

export type Pressure = 'beli' | 'jual' | 'seimbang';

/**
 * Order book imbalance (−1..1, IDR-weighted, from Milestone 2) classified
 * with a symmetric threshold: ≥ +t → buy pressure, ≤ −t → sell pressure.
 */
export function classifyImbalance(imbalance: Dec, threshold: number): Pressure {
  if (imbalance.gte(threshold)) return 'beli';
  if (imbalance.lte(-threshold)) return 'jual';
  return 'seimbang';
}

/**
 * Trade-side pressure from the IDR share of buyer-initiated trades (0..1),
 * using the same threshold around 0.5 (0.20 → ≥ 0.60 buy, ≤ 0.40 sell).
 */
export function classifyTradeFlow(buyRatio: Dec, threshold: number): Pressure {
  return classifyImbalance(buyRatio.times(2).minus(1), threshold);
}

/** Opposite readings (buy vs sell) are inconsistent; anything else is not. */
export function isConsistent(a: Pressure, b: Pressure): boolean {
  return !((a === 'beli' && b === 'jual') || (a === 'jual' && b === 'beli'));
}
