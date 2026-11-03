import { Dec } from '../app/decimal.js';
import type { PrismaClient } from '../app/database/prisma.js';
import { toJsonSafe } from '../analysis/types.js';
import type { ExecutionStatus, LedgerSignal, LifecycleStatus } from '../risk/risk-ledger.js';
import type { HypotheticalResult } from './lifecycle.js';
import type { Decision, StrategyDecision } from './types.js';

export interface StoredBuySignal extends LedgerSignal {
  candleOpenTime: Date;
  entryMin: Dec;
  entryMax: Dec;
  stopLoss: Dec;
  takeProfit: Dec;
  quantity: Dec;
  hypo: unknown;
}

export interface RecordResult {
  id: number;
  /** Decision stored for this pair + candle (a stored BUY is never replaced). */
  storedDecision: Decision;
  /** True when this call issued a new BUY recommendation. */
  issuedNow: boolean;
}

export interface SignalRepository {
  /**
   * Upsert by (pair, candle, engine version). A stored BUY_CANDIDATE is
   * immutable apart from lifecycle/execution, so re-evaluating the same
   * candle never counts or reserves twice.
   */
  record(d: StrategyDecision, extra: { snapshotId: bigint | null; reservedRisk: Dec | null }): Promise<RecordResult>;
  buySignalsSince(since: Date): Promise<StoredBuySignal[]>;
  /** BUY signals still ACTIVE or POSSIBLY_FILLED, any day. */
  openBuySignals(): Promise<StoredBuySignal[]>;
  updateLifecycle(id: number, lifecycle: LifecycleStatus, at: Date, hypo: HypotheticalResult | null): Promise<void>;
}

const up2 = (v: Dec) => v.toDecimalPlaces(2, Dec.ROUND_UP);
const down2 = (v: Dec) => v.toDecimalPlaces(2, Dec.ROUND_DOWN);

/** Column values for a decision (shared by both implementations). */
export function signalColumns(d: StrategyDecision, extra: { snapshotId: bigint | null; reservedRisk: Dec | null }) {
  const p = d.plan;
  const s = p?.sizing.ok ? p.sizing : null;
  const buy = d.decision === 'BUY_CANDIDATE';
  return {
    pair: d.pair,
    decision: d.decision,
    signalScore: d.score ? d.score.toFixed() : null,
    indicatorSnapshot: toJsonSafe({ ...d.indicators, regime: d.regime?.regime ?? null }) as object,
    entryMin: buy && p ? p.entry.min.toFixed() : null,
    entryMax: buy && p ? p.entry.max.toFixed() : null,
    stopLoss: buy && p ? p.stop.toFixed() : null,
    takeProfit: buy && p ? p.takeProfit.toFixed() : null,
    estimatedRisk: buy && s ? up2(s.atStop.netLoss).toFixed() : null,
    estimatedReward: buy && s ? down2(s.atTarget.netWin).toFixed() : null,
    status: buy ? 'ISSUED' : 'INFO',
    engineVersion: d.engineVersion,
    regime: d.regime?.regime ?? null,
    candleOpenTime: d.candleOpenTime,
    marketSnapshotId: extra.snapshotId,
    quantity: buy && s ? s.quantity.toFixed() : null,
    entryFeeEst: buy && s ? up2(s.buy.fee).toFixed() : null,
    exitFeeEst: buy && s ? up2(Dec.max(s.atStop.fee, s.atTarget.fee)).toFixed() : null,
    taxEst: buy && s ? up2(s.buy.tax.plus(Dec.max(s.atStop.tax, s.atTarget.tax))).toFixed() : null,
    slippageEst: buy && s ? up2(s.atStop.slippage).toFixed() : null,
    netRr: s ? s.netRr.toDecimalPlaces(6, Dec.ROUND_DOWN).toFixed() : null,
    // A BUY always reserves its planned net loss, even if the caller omitted it.
    reservedRisk: buy && s ? up2(extra.reservedRisk ?? s.atStop.netLoss).toFixed() : null,
    gates: toJsonSafe(d.gates) as object,
    reasons: toJsonSafe({ reasons: d.reasons, restrictions: d.restrictions, earlyWarning: d.earlyWarningSignals }) as object,
    costAssumptions: toJsonSafe(d.costs) as object,
    expiresAt: buy && p ? p.expiresAt : null,
    lifecycleStatus: buy ? ('ACTIVE' as const) : null,
    lifecycleAt: buy ? d.evaluatedAt : null,
  };
}

export class PrismaSignalRepository implements SignalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(d: StrategyDecision, extra: { snapshotId: bigint | null; reservedRisk: Dec | null }): Promise<RecordResult> {
    const data = signalColumns(d, extra);
    return this.prisma.$transaction(async (tx) => {
      const existing = d.candleOpenTime
        ? await tx.tradingSignal.findFirst({
            where: { pair: d.pair, candleOpenTime: d.candleOpenTime, engineVersion: d.engineVersion },
          })
        : null;
      if (!existing) {
        const row = await tx.tradingSignal.create({ data: { ...data, createdAt: d.evaluatedAt } });
        return { id: row.id, storedDecision: row.decision, issuedNow: row.decision === 'BUY_CANDIDATE' };
      }
      if (existing.decision === 'BUY_CANDIDATE') return { id: existing.id, storedDecision: existing.decision, issuedNow: false };
      const upgraded = d.decision === 'BUY_CANDIDATE';
      await tx.tradingSignal.update({
        where: { id: existing.id },
        data: { ...data, ...(upgraded ? { createdAt: d.evaluatedAt } : {}) },
      });
      return { id: existing.id, storedDecision: d.decision, issuedNow: upgraded };
    });
  }

  async buySignalsSince(since: Date): Promise<StoredBuySignal[]> {
    const rows = await this.prisma.tradingSignal.findMany({
      where: { decision: 'BUY_CANDIDATE', createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toStored);
  }

  async openBuySignals(): Promise<StoredBuySignal[]> {
    const rows = await this.prisma.tradingSignal.findMany({
      where: { decision: 'BUY_CANDIDATE', lifecycleStatus: { in: ['ACTIVE', 'POSSIBLY_FILLED'] } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toStored);
  }

  async updateLifecycle(id: number, lifecycle: LifecycleStatus, at: Date, hypo: HypotheticalResult | null): Promise<void> {
    await this.prisma.tradingSignal.update({
      where: { id },
      data: { lifecycleStatus: lifecycle, lifecycleAt: at, ...(hypo ? { hypoResult: hypo as object } : {}) },
    });
  }
}

type Row = Awaited<ReturnType<PrismaClient['tradingSignal']['findFirstOrThrow']>>;

function toStored(r: Row): StoredBuySignal {
  const dec = (v: { toString(): string } | null) => new Dec(v ? v.toString() : 0);
  return {
    id: r.id,
    pair: r.pair,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? r.createdAt,
    reservedRisk: dec(r.reservedRisk),
    lifecycle: (r.lifecycleStatus ?? 'ACTIVE') as LifecycleStatus,
    execution: r.executionStatus as ExecutionStatus,
    candleOpenTime: r.candleOpenTime ?? r.createdAt,
    entryMin: dec(r.entryMin),
    entryMax: dec(r.entryMax),
    stopLoss: dec(r.stopLoss),
    takeProfit: dec(r.takeProfit),
    quantity: dec(r.quantity),
    hypo: r.hypoResult,
  };
}

/** In-memory implementation with the same rules (tests, `--no-save` scripts). */
export class InMemorySignalRepository implements SignalRepository {
  rows: (ReturnType<typeof signalColumns> & { id: number; createdAt: Date; execution: ExecutionStatus; hypo: unknown })[] = [];
  private nextId = 1;

  async record(d: StrategyDecision, extra: { snapshotId: bigint | null; reservedRisk: Dec | null }): Promise<RecordResult> {
    const data = signalColumns(d, extra);
    const existing = d.candleOpenTime
      ? this.rows.find((r) => r.pair === d.pair && r.candleOpenTime?.getTime() === d.candleOpenTime!.getTime() && r.engineVersion === d.engineVersion)
      : undefined;
    if (!existing) {
      const row = { ...data, id: this.nextId++, createdAt: d.evaluatedAt, execution: 'UNKNOWN' as const, hypo: null };
      this.rows.push(row);
      return { id: row.id, storedDecision: row.decision, issuedNow: row.decision === 'BUY_CANDIDATE' };
    }
    if (existing.decision === 'BUY_CANDIDATE') return { id: existing.id, storedDecision: existing.decision, issuedNow: false };
    const upgraded = d.decision === 'BUY_CANDIDATE';
    Object.assign(existing, data, upgraded ? { createdAt: d.evaluatedAt } : {});
    return { id: existing.id, storedDecision: d.decision, issuedNow: upgraded };
  }

  async buySignalsSince(since: Date): Promise<StoredBuySignal[]> {
    return this.rows.filter((r) => r.decision === 'BUY_CANDIDATE' && r.createdAt >= since).map((r) => this.toStored(r));
  }

  async openBuySignals(): Promise<StoredBuySignal[]> {
    return this.rows
      .filter((r) => r.decision === 'BUY_CANDIDATE' && (r.lifecycleStatus === 'ACTIVE' || r.lifecycleStatus === 'POSSIBLY_FILLED'))
      .map((r) => this.toStored(r));
  }

  async updateLifecycle(id: number, lifecycle: LifecycleStatus, at: Date, hypo: HypotheticalResult | null): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    Object.assign(row, { lifecycleStatus: lifecycle, lifecycleAt: at }, hypo ? { hypo } : {});
  }

  private toStored(r: InMemorySignalRepository['rows'][number]): StoredBuySignal {
    const dec = (v: string | null) => new Dec(v ?? 0);
    return {
      id: r.id,
      pair: r.pair,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt ?? r.createdAt,
      reservedRisk: dec(r.reservedRisk),
      lifecycle: (r.lifecycleStatus ?? 'ACTIVE') as LifecycleStatus,
      execution: r.execution,
      candleOpenTime: r.candleOpenTime ?? r.createdAt,
      entryMin: dec(r.entryMin),
      entryMax: dec(r.entryMax),
      stopLoss: dec(r.stopLoss),
      takeProfit: dec(r.takeProfit),
      quantity: dec(r.quantity),
      hypo: r.hypo,
    };
  }
}
