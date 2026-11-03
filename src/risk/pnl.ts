import type { Dec } from '../app/decimal.js';
import { buyCosts, sellProceeds, type CostAssumptions } from './costs.js';

export interface TradePnl {
  grossPnl: Dec;
  fees: Dec;
  taxes: Dec;
  slippage: Dec;
  netPnl: Dec;
  exitFill: Dec;
}

/**
 * Net result of buying `quantity` at `entryFill` and selling at `exitPrice`
 * with `exitSlippagePct`. Used for hypothetical outcomes and backtests, with
 * the same cost formulas as position sizing.
 */
export function tradePnl(quantity: Dec, entryFill: Dec, exitPrice: Dec, exitSlippagePct: Dec, costs: CostAssumptions): TradePnl {
  const buy = buyCosts(quantity, entryFill, costs);
  const sell = sellProceeds(quantity, exitPrice, exitSlippagePct, costs);
  return {
    grossPnl: sell.gross.minus(buy.notional),
    fees: buy.fee.plus(sell.fee),
    taxes: buy.tax.plus(sell.tax),
    slippage: sell.slippage,
    netPnl: sell.net.minus(buy.total),
    exitFill: sell.fillPrice,
  };
}
