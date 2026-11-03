import type { Dec } from '../app/decimal.js';
import { findEntry, findExit, type PlannedOrder } from '../backtest/fill-model.js';
import type { Candle } from '../market/types.js';
import type { CostAssumptions } from '../risk/costs.js';
import { tradePnl } from '../risk/pnl.js';
import type { LifecycleStatus } from '../risk/risk-ledger.js';

export interface LifecycleSignal {
  lifecycle: LifecycleStatus;
  /** Last final candle the recommendation was based on. */
  candleOpenTime: Date;
  expiresAt: Date;
  order: PlannedOrder;
}

export interface HypotheticalResult {
  label: 'hipotetis';
  entryFill: string;
  entryKind: string;
  entryAt: string;
  exitReason: string;
  exitPrice: string;
  exitAt: string;
  netPnl: string;
  note: string;
}

export type LifecycleUpdate = { lifecycle: LifecycleStatus; at: Date; hypo: HypotheticalResult | null } | null;

/**
 * Advance a BUY recommendation's lifecycle from final candles observed in the
 * market. It never assumes the user executed it:
 *   ACTIVE → POSSIBLY_FILLED   a trade happened inside the entry range while valid
 *   ACTIVE → EXPIRED_UNFILLED  validity ended and every candle in the window is known, none in range
 *   POSSIBLY_FILLED → HYPO_CLOSED  hypothetical SL/TP/time stop reached (paper result only)
 * Missing candles never trigger EXPIRED_UNFILLED (the lock is kept). Transitions are one-way.
 */
export function advanceLifecycle(
  s: LifecycleSignal,
  candles: Candle[],
  tfMs: number,
  timeStopCandles: number,
  costs: CostAssumptions,
): LifecycleUpdate {
  if (s.lifecycle === 'EXPIRED_UNFILLED' || s.lifecycle === 'HYPO_CLOSED') return null;

  const firstOpen = s.candleOpenTime.getTime() + tfMs;
  const after = candles.filter((c) => c.openTime.getTime() >= firstOpen);
  const window = after.filter((c) => c.openTime < s.expiresAt);
  const entry = findEntry(window, s.order, { requireVolumeForQuantity: false, inclusive: true });

  if (!entry) {
    if (s.lifecycle !== 'ACTIVE') return null;
    const expected = Math.round((s.expiresAt.getTime() - firstOpen) / tfMs);
    const complete = window.length === expected && window.every((c, i) => c.openTime.getTime() === firstOpen + i * tfMs);
    return complete ? { lifecycle: 'EXPIRED_UNFILLED', at: s.expiresAt, hypo: null } : null;
  }

  const entryCandle = window[entry.index]!;
  const entryAt = new Date(entryCandle.openTime.getTime() + tfMs);
  const hypo = (exitPrice: Dec, exitReason: string, stopType: boolean, exitAt: Date): HypotheticalResult => {
    const pnl = tradePnl(s.order.quantity, entry.fillPrice, exitPrice, stopType ? costs.stopSlippagePct : costs.tpSlippagePct, costs);
    return {
      label: 'hipotetis',
      entryFill: entry.fillPrice.toFixed(),
      entryKind: entry.kind,
      entryAt: entryAt.toISOString(),
      exitReason,
      exitPrice: exitPrice.toFixed(),
      exitAt: exitAt.toISOString(),
      netPnl: pnl.netPnl.toDecimalPlaces(2).toFixed(),
      note: 'hasil hipotetis dari data pasar, bukan P/L Anda; eksekusi tidak diketahui',
    };
  };

  if (entry.immediateExit) {
    return { lifecycle: 'HYPO_CLOSED', at: entryAt, hypo: hypo(entry.immediateExit, entry.kind, true, entryAt) };
  }
  const rest = after.slice(after.indexOf(entryCandle) + 1);
  const exit = findExit(rest, s.order, timeStopCandles);
  if (exit) {
    const exitAt = new Date(rest[exit.index]!.openTime.getTime() + tfMs);
    return { lifecycle: 'HYPO_CLOSED', at: exitAt, hypo: hypo(exit.price, exit.reason, exit.stopType, exitAt) };
  }
  return s.lifecycle === 'ACTIVE' ? { lifecycle: 'POSSIBLY_FILLED', at: entryAt, hypo: null } : null;
}
