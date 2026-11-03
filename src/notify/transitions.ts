import type { PrismaClient } from '../app/database/prisma.js';

export interface PreviousDecision {
  decision: string;
  candleOpenTime: Date;
  earlyWarning: string[];
}

export interface LifecycleChange {
  id: number;
  pair: string;
  lifecycle: 'EXPIRED_UNFILLED' | 'POSSIBLY_FILLED' | 'HYPO_CLOSED';
  lifecycleAt: Date;
  createdAt: Date;
  expiresAt: Date | null;
  hypo: { exitReason?: string; netPnl?: string; entryFill?: string; exitPrice?: string; note?: string } | null;
}

/**
 * Read-only view of stored M4 signals (trading_signals is read, never
 * written, by the notifier). Lifecycle changes are made by M4 during
 * scheduled strategy scans; the notifier only reports them.
 */
export interface SignalHistory {
  previousDecision(pair: string, beforeCandle: Date): Promise<PreviousDecision | null>;
  lifecycleChangesSince(since: Date): Promise<LifecycleChange[]>;
}

const NOTIFIED_LIFECYCLES = ['EXPIRED_UNFILLED', 'POSSIBLY_FILLED', 'HYPO_CLOSED'] as const;

export class PrismaSignalHistory implements SignalHistory {
  constructor(private readonly prisma: PrismaClient) {}

  async previousDecision(pair: string, beforeCandle: Date): Promise<PreviousDecision | null> {
    const row = await this.prisma.tradingSignal.findFirst({
      where: { pair, candleOpenTime: { lt: beforeCandle } },
      orderBy: { candleOpenTime: 'desc' },
      select: { decision: true, candleOpenTime: true, reasons: true },
    });
    if (!row?.candleOpenTime) return null;
    const ew = (row.reasons as { earlyWarning?: unknown } | null)?.earlyWarning;
    return { decision: row.decision, candleOpenTime: row.candleOpenTime, earlyWarning: Array.isArray(ew) ? ew.map(String) : [] };
  }

  async lifecycleChangesSince(since: Date): Promise<LifecycleChange[]> {
    const rows = await this.prisma.tradingSignal.findMany({
      where: { decision: 'BUY_CANDIDATE', lifecycleStatus: { in: [...NOTIFIED_LIFECYCLES] }, lifecycleAt: { gte: since } },
      orderBy: { lifecycleAt: 'asc' },
      select: { id: true, pair: true, lifecycleStatus: true, lifecycleAt: true, createdAt: true, expiresAt: true, hypoResult: true },
    });
    return rows.map((r) => ({
      id: r.id,
      pair: r.pair,
      lifecycle: r.lifecycleStatus as LifecycleChange['lifecycle'],
      lifecycleAt: r.lifecycleAt!,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      hypo: (r.hypoResult as LifecycleChange['hypo']) ?? null,
    }));
  }
}
