import { Dec } from '../app/decimal.js';
import { floorToStep } from './ticks.js';

export interface TakeProfitParams {
  /** Cap: entry + rrCap·(entry − stop). */
  rrCap: number;
  /** TP sits this many ATR below the nearest resistance edge. */
  resistanceBufferAtr: number;
}

export type TakeProfitResult =
  | { ok: true; price: Dec; method: 'rr_cap' | 'resistance'; resistanceEdge: Dec | null }
  | { ok: false; reason: string };

/**
 *   TP = floor_tick(min(nearest resistance edge − buffer·ATR, entry + rrCap·(entry − SL)))
 * `resistanceEdges`: lower edges of resistance zones above the entry.
 */
export function takeProfit(
  entry: Dec,
  stop: Dec,
  atr: Dec,
  tick: Dec | null,
  resistanceEdges: Dec[],
  p: TakeProfitParams,
): TakeProfitResult {
  const byRr = entry.plus(entry.minus(stop).times(p.rrCap));
  const above = resistanceEdges.filter((e) => e.gt(entry));
  const edge = above.length ? Dec.min(...above) : null;
  const byResistance = edge ? edge.minus(atr.times(p.resistanceBufferAtr)) : null;

  const useResistance = byResistance !== null && byResistance.lt(byRr);
  const price = floorToStep(useResistance ? byResistance : byRr, tick);
  if (price.lte(entry)) return { ok: false, reason: 'resistance terlalu dekat: take profit tidak di atas entry' };
  return { ok: true, price, method: useResistance ? 'resistance' : 'rr_cap', resistanceEdge: edge };
}
