import { Dec } from '../app/decimal.js';
import type { OrderBookLevel } from '../market/types.js';
import { buyCostRate, buyCosts, sellCostRate, sellProceeds, type CostAssumptions } from './costs.js';
import { sellSlippagePct } from './slippage.js';
import { floorToStep } from './ticks.js';

export interface SizingInput {
  /** Upper bound of the entry range (worst case for risk). */
  entry: Dec;
  stop: Dec;
  takeProfit: Dec;
  costs: CostAssumptions;
  /** min(capital × risk %, remaining planned daily risk). */
  riskBudget: Dec;
  capital: Dec;
  maxAllocPct: Dec;
  quantityIncrement: Dec | null;
  minOrderIdr: Dec | null;
  minOrderBase: Dec | null;
  liquidity: {
    /** Ask volume (base units) within the ±1% band; null = unknown. */
    askDepthBase: Dec | null;
    volumeIdr24h: Dec | null;
    depthShare: number;
    volumeShare: number;
  };
  /** Current bids, for the stop-exit slippage estimate; null = use the configured minimum only. */
  bids: OrderBookLevel[] | null;
}

export type CapReason = 'risiko' | 'alokasi' | 'likuiditas';

export interface SizingBreakdown {
  quantity: Dec;
  cappedBy: CapReason;
  entryFill: Dec;
  positionValue: Dec;
  allocationPct: Dec;
  /** Effective stop slippage: max(configured, order book estimate). */
  stopSlippagePct: Dec;
  lossPerCoin: Dec;
  winPerCoin: Dec;
  buy: { notional: Dec; fee: Dec; tax: Dec; total: Dec };
  atStop: { gross: Dec; slippage: Dec; fee: Dec; tax: Dec; net: Dec; grossLoss: Dec; netLoss: Dec };
  atTarget: { gross: Dec; slippage: Dec; fee: Dec; tax: Dec; net: Dec; grossWin: Dec; netWin: Dec };
  grossRr: Dec;
  netRr: Dec;
  notes: string[];
}

export type SizingResult =
  | ({ ok: true } & SizingBreakdown)
  | { ok: false; kind: 'min_order' | 'liquidity' | 'invalid'; reason: string; partial: SizingBreakdown | null };

const fraction = (pct: Dec) => pct.div(100);

/**
 * Risk-based position size. All fees, taxes and slippage are inside the loss
 * per coin, so q·lossPerCoin ≤ riskBudget; rounding q DOWN keeps it there:
 *
 *   entryFill   = entry·(1 + entrySlip)
 *   lossPerCoin = entryFill·(1 + fb) − SL·(1 − ss)·(1 − fs)
 *   winPerCoin  = TP·(1 − tpSlip)·(1 − fs) − entryFill·(1 + fb)
 *   q = floor_inc(min(R / lossPerCoin, capital·alloc / (entryFill·(1+fb)), liquidity caps))
 *
 * This holds under the simulated normal conditions only; gaps, thin books and
 * unfilled stops can make the real loss larger.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const { entry, stop, takeProfit, costs } = input;
  if (!(stop.gt(0) && stop.lt(entry) && takeProfit.gt(entry))) {
    return { ok: false, kind: 'invalid', reason: 'harga tidak valid (butuh 0 < SL < entry < TP)', partial: null };
  }

  const first = compute(input, costs.stopSlippagePct);
  let breakdown = first;
  if (input.bids) {
    const depth = sellSlippagePct(input.bids, first.quantity);
    if (!depth.filled) {
      return { ok: false, kind: 'liquidity', reason: 'order book bid tidak cukup untuk menyerap exit di stop loss', partial: first };
    }
    // A larger slippage only lowers q, so the second estimate stays conservative.
    if (depth.pct.gt(costs.stopSlippagePct)) breakdown = compute(input, depth.pct);
  } else {
    breakdown.notes.push('slippage stop memakai nilai minimum (order book tidak tersedia)');
  }

  const q = breakdown.quantity;
  if (q.lte(0)) return { ok: false, kind: 'min_order', reason: 'jumlah koin 0 setelah pembulatan', partial: breakdown };
  if (input.minOrderIdr && breakdown.positionValue.lt(input.minOrderIdr)) {
    return { ok: false, kind: 'min_order', reason: `nilai order di bawah minimum Rp${input.minOrderIdr.toFixed()}`, partial: breakdown };
  }
  if (input.minOrderBase && q.lt(input.minOrderBase)) {
    return { ok: false, kind: 'min_order', reason: `jumlah koin di bawah minimum ${input.minOrderBase.toFixed()}`, partial: breakdown };
  }
  return { ok: true, ...breakdown };
}

function compute(input: SizingInput, stopSlippagePct: Dec): SizingBreakdown {
  const { entry, stop, takeProfit, costs, liquidity } = input;
  const fb = buyCostRate(costs);
  const fs = sellCostRate(costs);
  const entryFill = entry.times(Dec.add(1, fraction(costs.entrySlippagePct)));
  const buyPerCoin = entryFill.times(Dec.add(1, fb));
  const lossPerCoin = buyPerCoin.minus(stop.times(Dec.sub(1, fraction(stopSlippagePct))).times(Dec.sub(1, fs)));
  const winPerCoin = takeProfit.times(Dec.sub(1, fraction(costs.tpSlippagePct))).times(Dec.sub(1, fs)).minus(buyPerCoin);

  const notes: string[] = [];
  const caps: { reason: CapReason; q: Dec }[] = [
    { reason: 'risiko', q: input.riskBudget.div(lossPerCoin) },
    { reason: 'alokasi', q: input.capital.times(fraction(input.maxAllocPct)).div(buyPerCoin) },
  ];
  if (liquidity.askDepthBase) caps.push({ reason: 'likuiditas', q: liquidity.askDepthBase.times(liquidity.depthShare) });
  else notes.push('kedalaman ask tidak diketahui; batas likuiditas order book tidak diterapkan');
  if (liquidity.volumeIdr24h) caps.push({ reason: 'likuiditas', q: liquidity.volumeIdr24h.times(liquidity.volumeShare).div(entryFill) });
  else notes.push('volume 24 jam tidak diketahui; batas likuiditas volume tidak diterapkan');

  const binding = caps.reduce((a, b) => (b.q.lt(a.q) ? b : a));
  const quantity = Dec.max(floorToStep(binding.q, input.quantityIncrement), 0);

  const buy = buyCosts(quantity, entryFill, costs);
  const s = sellProceeds(quantity, stop, stopSlippagePct, costs);
  const t = sellProceeds(quantity, takeProfit, costs.tpSlippagePct, costs);
  const netLoss = buy.total.minus(s.net);
  const netWin = t.net.minus(buy.total);
  const grossLoss = quantity.times(entryFill.minus(stop));
  const grossWin = quantity.times(takeProfit.minus(entryFill));

  return {
    quantity,
    cappedBy: binding.reason,
    entryFill,
    positionValue: buy.notional,
    allocationPct: input.capital.gt(0) ? buy.notional.div(input.capital).times(100) : new Dec(0),
    stopSlippagePct,
    lossPerCoin,
    winPerCoin,
    buy,
    atStop: { gross: s.gross, slippage: s.slippage, fee: s.fee, tax: s.tax, net: s.net, grossLoss, netLoss },
    atTarget: { gross: t.gross, slippage: t.slippage, fee: t.fee, tax: t.tax, net: t.net, grossWin, netWin },
    grossRr: takeProfit.minus(entryFill).div(entryFill.minus(stop)),
    netRr: netLoss.gt(0) ? netWin.div(netLoss) : winPerCoin.div(lossPerCoin),
    notes,
  };
}
