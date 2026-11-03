import type { PrismaClient } from '../app/database/prisma.js';

export type GapKind = 'SNAPSHOT' | 'CANDLE';
export type GapStatus = 'OPEN' | 'BACKFILLED' | 'PERMANENT';

export interface GapRecord {
  kind: GapKind;
  pair: string;
  /** Candle timeframe code, "-" for snapshots. */
  timeframe: string;
  /** Half-open interval [gapStart, gapEnd). */
  gapStart: Date;
  gapEnd: Date;
  cause: string;
  status: GapStatus;
  details?: Record<string, unknown> | null;
}

export interface GapRepository {
  /**
   * Order-book snapshots cannot be fetched historically: a missed snapshot is
   * always PERMANENT. A gap adjacent to an existing one with the same cause is
   * extended instead of creating a new row.
   */
  recordSnapshotGap(pair: string, from: Date, to: Date, cause: string, details?: Record<string, unknown>): Promise<void>;
  /** Insert or update the candle gap starting at `from` (idempotent per start). */
  upsertCandleGap(pair: string, timeframe: string, from: Date, to: Date, cause: string, status: GapStatus, details?: Record<string, unknown>): Promise<void>;
  /** PERMANENT candle gaps (not re-fetched on every pass). */
  permanentCandleGaps(pair: string, timeframe: string): Promise<{ start: Date; end: Date }[]>;
  list(since: Date): Promise<GapRecord[]>;
}

export class PrismaGapRepository implements GapRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async recordSnapshotGap(pair: string, from: Date, to: Date, cause: string, details?: Record<string, unknown>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const adjacent = await tx.dataGap.findFirst({ where: { kind: 'SNAPSHOT', pair, cause, gapEnd: { gte: from, lte: to }, gapStart: { lte: from } } });
      if (adjacent) {
        if (adjacent.gapEnd < to) await tx.dataGap.update({ where: { id: adjacent.id }, data: { gapEnd: to } });
        return;
      }
      const sameStart = await tx.dataGap.findUnique({ where: { kind_pair_timeframe_gapStart: { kind: 'SNAPSHOT', pair, timeframe: '-', gapStart: from } } });
      if (sameStart) {
        if (sameStart.gapEnd < to) await tx.dataGap.update({ where: { id: sameStart.id }, data: { gapEnd: to } });
        return;
      }
      await tx.dataGap.create({ data: { kind: 'SNAPSHOT', pair, timeframe: '-', gapStart: from, gapEnd: to, cause, status: 'PERMANENT', resolvedAt: null, details: (details ?? undefined) as object | undefined } });
    });
  }

  async upsertCandleGap(pair: string, timeframe: string, from: Date, to: Date, cause: string, status: GapStatus, details?: Record<string, unknown>): Promise<void> {
    const data = { gapEnd: to, cause, status, resolvedAt: status === 'OPEN' ? null : new Date(), details: (details ?? undefined) as object | undefined };
    await this.prisma.dataGap.upsert({
      where: { kind_pair_timeframe_gapStart: { kind: 'CANDLE', pair, timeframe, gapStart: from } },
      create: { kind: 'CANDLE', pair, timeframe, gapStart: from, ...data },
      update: data,
    });
  }

  async permanentCandleGaps(pair: string, timeframe: string): Promise<{ start: Date; end: Date }[]> {
    const rows = await this.prisma.dataGap.findMany({ where: { kind: 'CANDLE', pair, timeframe, status: 'PERMANENT' }, select: { gapStart: true, gapEnd: true } });
    return rows.map((r) => ({ start: r.gapStart, end: r.gapEnd }));
  }

  async list(since: Date): Promise<GapRecord[]> {
    const rows = await this.prisma.dataGap.findMany({ where: { gapEnd: { gt: since } }, orderBy: [{ pair: 'asc' }, { gapStart: 'asc' }] });
    return rows.map((r) => ({ kind: r.kind, pair: r.pair, timeframe: r.timeframe, gapStart: r.gapStart, gapEnd: r.gapEnd, cause: r.cause, status: r.status, details: r.details as Record<string, unknown> | null }));
  }
}

export class InMemoryGapRepository implements GapRepository {
  gaps: GapRecord[] = [];

  async recordSnapshotGap(pair: string, from: Date, to: Date, cause: string, details?: Record<string, unknown>): Promise<void> {
    const g =
      this.gaps.find((x) => x.kind === 'SNAPSHOT' && x.pair === pair && x.cause === cause && x.gapEnd >= from && x.gapEnd <= to && x.gapStart <= from) ??
      this.gaps.find((x) => x.kind === 'SNAPSHOT' && x.pair === pair && x.gapStart.getTime() === from.getTime());
    if (g) {
      if (g.gapEnd < to) g.gapEnd = to;
      return;
    }
    this.gaps.push({ kind: 'SNAPSHOT', pair, timeframe: '-', gapStart: from, gapEnd: to, cause, status: 'PERMANENT', details: details ?? null });
  }

  async upsertCandleGap(pair: string, timeframe: string, from: Date, to: Date, cause: string, status: GapStatus, details?: Record<string, unknown>): Promise<void> {
    const g = this.gaps.find((x) => x.kind === 'CANDLE' && x.pair === pair && x.timeframe === timeframe && x.gapStart.getTime() === from.getTime());
    if (g) Object.assign(g, { gapEnd: to, cause, status, details: details ?? null });
    else this.gaps.push({ kind: 'CANDLE', pair, timeframe, gapStart: from, gapEnd: to, cause, status, details: details ?? null });
  }

  async permanentCandleGaps(pair: string, timeframe: string): Promise<{ start: Date; end: Date }[]> {
    return this.gaps.filter((x) => x.kind === 'CANDLE' && x.pair === pair && x.timeframe === timeframe && x.status === 'PERMANENT').map((x) => ({ start: x.gapStart, end: x.gapEnd }));
  }

  async list(since: Date): Promise<GapRecord[]> {
    return this.gaps.filter((g) => g.gapEnd > since);
  }
}
