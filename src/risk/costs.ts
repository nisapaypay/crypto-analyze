import { Dec } from '../app/decimal.js';

/**
 * Trading cost assumptions, all in percent (0.2 = 0.2%). Fees, taxes and
 * slippage are separate parameters; none is hard-coded in any formula.
 * `verified` stays false until the owner checks them against a real receipt.
 */
export interface CostAssumptions {
  buyFeePct: Dec;
  sellFeePct: Dec;
  buyTaxPct: Dec;
  sellTaxPct: Dec;
  /** Limit entry: 0 by default, configurable. */
  entrySlippagePct: Dec;
  /** Minimum slippage for a stop-loss exit (market sell); order book depth may raise it. */
  stopSlippagePct: Dec;
  /** Limit take-profit: 0 by default. */
  tpSlippagePct: Dec;
  verified: boolean;
}

/**
 * Temporary defaults approved for Milestone 4: 0.31% per side
 * (exchange fee 0.20% + 0.11% tax reserve). The tax value is an UNVERIFIED
 * assumption and can be changed with `pnpm settings:costs`.
 */
export const DEFAULT_COSTS = {
  buyFeePct: '0.20',
  sellFeePct: '0.20',
  buyTaxPct: '0.11',
  sellTaxPct: '0.11',
  entrySlippagePct: '0',
  stopSlippagePct: '0.15',
  tpSlippagePct: '0',
} as const;

export type CostOverrides = Partial<Record<keyof typeof DEFAULT_COSTS, Dec | string | null>> & { verified?: boolean };

export function resolveCosts(overrides: CostOverrides = {}): CostAssumptions {
  const pick = (key: keyof typeof DEFAULT_COSTS) => new Dec(overrides[key] ?? DEFAULT_COSTS[key]);
  return {
    buyFeePct: pick('buyFeePct'),
    sellFeePct: pick('sellFeePct'),
    buyTaxPct: pick('buyTaxPct'),
    sellTaxPct: pick('sellTaxPct'),
    entrySlippagePct: pick('entrySlippagePct'),
    stopSlippagePct: pick('stopSlippagePct'),
    tpSlippagePct: pick('tpSlippagePct'),
    verified: overrides.verified ?? false,
  };
}

const fraction = (pct: Dec) => pct.div(100);

/** Fee + tax charged on the buy notional, as a fraction. */
export function buyCostRate(c: CostAssumptions): Dec {
  return fraction(c.buyFeePct.plus(c.buyTaxPct));
}

/** Fee + tax charged on the sell proceeds, as a fraction. */
export function sellCostRate(c: CostAssumptions): Dec {
  return fraction(c.sellFeePct.plus(c.sellTaxPct));
}

/** Round-trip cost in percent used by gate G10: both sides' fees and taxes plus entry and stop slippage. */
export function roundTripCostPct(c: CostAssumptions): Dec {
  return c.buyFeePct.plus(c.buyTaxPct).plus(c.sellFeePct).plus(c.sellTaxPct).plus(c.entrySlippagePct).plus(c.stopSlippagePct);
}

/** Itemised costs of buying `quantity` at `price` (already including entry slippage). */
export function buyCosts(quantity: Dec, price: Dec, c: CostAssumptions) {
  const notional = quantity.times(price);
  const fee = notional.times(fraction(c.buyFeePct));
  const tax = notional.times(fraction(c.buyTaxPct));
  return { notional, fee, tax, total: notional.plus(fee).plus(tax) };
}

/** Itemised result of selling `quantity` at `price` with `slippagePct` (fraction of price lost). */
export function sellProceeds(quantity: Dec, price: Dec, slippagePct: Dec, c: CostAssumptions) {
  const fillPrice = price.times(Dec.sub(1, fraction(slippagePct)));
  const gross = quantity.times(fillPrice);
  const slippage = quantity.times(price.minus(fillPrice));
  const fee = gross.times(fraction(c.sellFeePct));
  const tax = gross.times(fraction(c.sellTaxPct));
  return { fillPrice, gross, slippage, fee, tax, net: gross.minus(fee).minus(tax) };
}
