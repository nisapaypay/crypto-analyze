import type { PrismaClient } from '../app/database/prisma.js';
import { Dec } from '../app/decimal.js';

/** An issued BUY recommendation as stored by M4, read for monitoring only. */
export interface ActiveBuy {
  id: number;
  pair: string;
  createdAt: Date;
  expiresAt: Date;
  /** Last final candle the recommendation was based on. */
  candleOpenTime: Date;
  entryMin: Dec;
  entryMax: Dec;
  stopLoss: Dec;
  /** M4 plan.chaseLimit = entry max + chaseAtr × effective ATR (reconstructed exactly from stored values). */
  chaseLimit: Dec | null;
}

export interface ActiveBuyReader {
  /** BUY_CANDIDATE signals whose lifecycle is still ACTIVE and whose validity has not ended. */
  activeBuys(now: Date): Promise<ActiveBuy[]>;
}

/**
 * Effective ATR as M4 computes it (max of ATR14 and traded-candle ATR, both
 * positive) from the decision's stored indicator snapshot.
 */
export function chaseLimitFrom(entryMax: Dec, indicators: unknown, chaseAtr: number): Dec | null {
  const s = (indicators ?? {}) as Record<string, unknown>;
  const atrs = [s.atr14, s.atr14Traded]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => new Dec(v))
    .filter((v) => v.gt(0));
  return atrs.length ? entryMax.plus(Dec.max(...atrs).times(chaseAtr)) : null;
}

/**
 * READ-ONLY access to trading_signals for the entry monitor. It has no write
 * method on purpose: the monitor can never change a decision or a lifecycle.
 */
export class PrismaActiveBuyReader implements ActiveBuyReader {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chaseAtr: number,
  ) {}

  async activeBuys(now: Date): Promise<ActiveBuy[]> {
    const rows = await this.prisma.tradingSignal.findMany({
      where: { decision: 'BUY_CANDIDATE', lifecycleStatus: 'ACTIVE', expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, pair: true, createdAt: true, expiresAt: true, candleOpenTime: true, entryMin: true, entryMax: true, stopLoss: true, indicatorSnapshot: true },
    });
    return rows
      .filter((r) => r.expiresAt && r.entryMin && r.entryMax && r.stopLoss && r.candleOpenTime)
      .map((r) => {
        const entryMax = new Dec(r.entryMax!.toString());
        return {
          id: r.id,
          pair: r.pair,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt!,
          candleOpenTime: r.candleOpenTime!,
          entryMin: new Dec(r.entryMin!.toString()),
          entryMax,
          stopLoss: new Dec(r.stopLoss!.toString()),
          chaseLimit: chaseLimitFrom(entryMax, r.indicatorSnapshot, this.chaseAtr),
        };
      });
  }
}
