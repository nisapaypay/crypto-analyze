import { sum, ZERO, type Dec } from '../app/decimal.js';
import type { Trade } from './types.js';

export interface TradeActivity {
  windowMinutes: number;
  count: number;
  buyCount: number;
  sellCount: number;
  buyVolumeBase: Dec;
  sellVolumeBase: Dec;
  buyValueIdr: Dec;
  sellValueIdr: Dec;
  /** Share of IDR value traded on the buy side (0..1); null without trades. */
  buyRatio: Dec | null;
  newestTradeAt: Date | null;
  /** String on purpose: Indodax trade ids exceed Number.MAX_SAFE_INTEGER. */
  newestTradeId: string | null;
  newestTradeAgeSec: number | null;
}

/** Buyer/seller activity over the last `windowMinutes`, from public trades. */
export function summarizeTrades(trades: Trade[], now: Date, windowMinutes: number): TradeActivity {
  const since = now.getTime() - windowMinutes * 60_000;
  const recent = trades.filter((t) => t.time.getTime() >= since && t.time.getTime() <= now.getTime());
  const buys = recent.filter((t) => t.side === 'buy');
  const sells = recent.filter((t) => t.side === 'sell');
  const value = (ts: Trade[]) => sum(ts.map((t) => t.price.times(t.amount)));

  const buyValueIdr = value(buys);
  const sellValueIdr = value(sells);
  const total = buyValueIdr.plus(sellValueIdr);
  const newestTrade = trades.reduce<Trade | null>((max, t) => (max === null || t.time > max.time ? t : max), null);
  const newest = newestTrade?.time ?? null;

  return {
    windowMinutes,
    count: recent.length,
    buyCount: buys.length,
    sellCount: sells.length,
    buyVolumeBase: sum(buys.map((t) => t.amount)),
    sellVolumeBase: sum(sells.map((t) => t.amount)),
    buyValueIdr,
    sellValueIdr,
    buyRatio: total.gt(ZERO) ? buyValueIdr.div(total) : null,
    newestTradeAt: newest,
    newestTradeId: newestTrade?.tid ?? null,
    newestTradeAgeSec: newest ? Math.round((now.getTime() - newest.getTime()) / 1000) : null,
  };
}
