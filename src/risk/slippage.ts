import { Dec, ZERO } from '../app/decimal.js';
import type { OrderBookLevel } from '../market/types.js';

/**
 * Estimated slippage (percent below the best bid) of market-selling
 * `quantity` into the current bids. A snapshot only: the book at stop time
 * can be thinner. `filled` is false when the visible book cannot absorb it.
 */
export function sellSlippagePct(bids: OrderBookLevel[], quantity: Dec): { pct: Dec; filled: boolean } {
  const best = bids[0]?.price;
  if (!best || quantity.lte(0)) return { pct: ZERO, filled: quantity.lte(0) };
  let remaining = quantity;
  let value: Dec = ZERO;
  for (const level of bids) {
    const take = Dec.min(remaining, level.volume);
    value = value.plus(take.times(level.price));
    remaining = remaining.minus(take);
    if (remaining.lte(0)) break;
  }
  if (remaining.gt(0)) return { pct: ZERO, filled: false };
  const average = value.div(quantity);
  return { pct: best.minus(average).div(best).times(100), filled: true };
}
