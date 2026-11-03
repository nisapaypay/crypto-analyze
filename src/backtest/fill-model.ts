import { Dec } from '../app/decimal.js';
import type { Candle } from '../market/types.js';

/**
 * Conservative fill model shared by backtests and hypothetical outcomes of
 * live recommendations. ALL fills are ESTIMATES: there is no historical
 * order-queue data, so a candle trading through the limit price does not
 * prove a resting limit order would have filled (and enough volume does not
 * either). Exits are pessimistic.
 */

export interface PlannedOrder {
  entryMax: Dec;
  stop: Dec;
  takeProfit: Dec;
  quantity: Dec;
}

export type EntryKind =
  /** Price traded below the limit; filled at min(open, entryMax). */
  | 'normal'
  /** Candle opened at/below the stop while the order was pending: filled at the open, stopped immediately. */
  | 'gap_sebelum_entry'
  /** Filled and the same candle reached the stop: assumed stopped (pessimistic). */
  | 'sl_di_candle_entry';

export interface EntryFill {
  index: number;
  fillPrice: Dec;
  kind: EntryKind;
  /** Set for immediate stop-outs inside the entry candle (price before slippage). */
  immediateExit: Dec | null;
}

export interface EntryOptions {
  /** Backtest: require candle volume ≥ order quantity (still only an estimate). */
  requireVolumeForQuantity: boolean;
  /**
   * Lifecycle (lock) mode: any trade at or below entryMax counts as a possible
   * fill (≤ instead of <). Conservative for the position slot.
   */
  inclusive: boolean;
}

/** First candle (in order) where the pending limit buy is assumed filled, or null. */
export function findEntry(candles: Candle[], order: PlannedOrder, opts: EntryOptions): EntryFill | null {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.volume.isZero()) continue; // zero-volume carry-forward candle: no trade happened
    if (opts.requireVolumeForQuantity && c.volume.lt(order.quantity)) continue;

    if (c.open.lte(order.stop)) {
      return { index: i, fillPrice: c.open, kind: 'gap_sebelum_entry', immediateExit: c.open };
    }
    const touched = opts.inclusive ? c.low.lte(order.entryMax) : c.low.lt(order.entryMax);
    if (touched) {
      const fillPrice = Dec.min(c.open, order.entryMax);
      if (c.low.lte(order.stop)) return { index: i, fillPrice, kind: 'sl_di_candle_entry', immediateExit: order.stop };
      return { index: i, fillPrice, kind: 'normal', immediateExit: null };
    }
  }
  return null;
}

export type ExitReason = 'sl' | 'gap_sl' | 'tp' | 'waktu' | 'gap_sebelum_entry' | 'sl_di_candle_entry';

export interface ExitFill {
  index: number;
  /** Price before slippage. */
  price: Dec;
  reason: ExitReason;
  /** Stop-type exits are market sells and pay stop slippage; TP is a limit sell. */
  stopType: boolean;
}

/**
 * First exit after the entry candle. `candles` start right AFTER the entry
 * candle. Per candle: gap through stop → open; stop touched → stop (even if
 * TP was also touched); high strictly above TP → TP (no positive slippage on
 * gaps up); time stop after `maxCandles` → close.
 */
export function findExit(candles: Candle[], order: PlannedOrder, maxCandles: number): ExitFill | null {
  let held = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    held++;
    if (c.volume.isZero()) continue;
    if (c.open.lte(order.stop)) return { index: i, price: c.open, reason: 'gap_sl', stopType: true };
    if (c.low.lte(order.stop)) return { index: i, price: order.stop, reason: 'sl', stopType: true };
    if (c.high.gt(order.takeProfit)) return { index: i, price: order.takeProfit, reason: 'tp', stopType: false };
    if (held >= maxCandles) return { index: i, price: c.close, reason: 'waktu', stopType: true };
  }
  return null;
}
