import type { PrismaClient } from '../app/database/prisma.js';

export type RunKind = 'STRATEGY_SCAN' | 'COLLECT' | 'MONITOR' | 'SUMMARY' | 'BACKUP';
export type RunTrigger = 'SCHEDULED' | 'MANUAL' | 'RECOVERY';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'INTERRUPTED' | 'MISSED';

export interface RunKey {
  kind: RunKind;
  /** "ALL" for watchlist-wide runs, else the pair. */
  scope: string;
  slotAt: Date;
}

export interface RunItem {
  pair: string;
  status: 'OK' | 'FAILED' | 'SKIPPED';
  decision?: string | null;
  signalId?: number | null;
  marketSnapshotId?: bigint | null;
  qualityStatus?: string | null;
  error?: string | null;
}

export interface RunRecord extends RunKey {
  id: number;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  cause: string | null;
  error: string | null;
  retryCount: number;
}

export interface SchedulerStateRecord {
  instanceId: string;
  startedAt: Date;
  lastHeartbeatAt: Date;
  lastSlotAt: Date | null;
  clockStatus: string | null;
  clockSkewMs: number | null;
}

export interface SchedulerRepository {
  /** Claim a slot (status RUNNING). Null if a run for this (kind, scope, slot) already exists. */
  claim(key: RunKey, trigger: RunTrigger, now: Date): Promise<number | null>;
  finish(id: number, status: Exclude<RunStatus, 'RUNNING'>, fields: { now: Date; cause?: string | null; error?: string | null; summary?: unknown; retryCount?: number }): Promise<void>;
  /** Record a slot that did not run (SKIPPED / MISSED). Idempotent: existing rows are left alone. */
  recordNotRun(key: RunKey, status: 'SKIPPED' | 'MISSED', cause: string, now: Date, trigger?: RunTrigger): Promise<boolean>;
  addItems(runId: number, items: RunItem[]): Promise<void>;
  /** RUNNING rows left by a previous process → INTERRUPTED. Returns how many. */
  interruptRunning(now: Date): Promise<number>;
  /** Latest slot time of any slot run (STRATEGY_SCAN or COLLECT), whatever its status. */
  lastSlotAt(): Promise<Date | null>;
  recentRuns(limit: number): Promise<RunRecord[]>;
  readState(): Promise<SchedulerStateRecord | null>;
  writeState(s: SchedulerStateRecord): Promise<void>;
}

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

export class PrismaSchedulerRepository implements SchedulerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(key: RunKey, trigger: RunTrigger, now: Date): Promise<number | null> {
    try {
      const row = await this.prisma.scheduledScan.create({
        select: { id: true },
        data: {
          kind: key.kind,
          scope: key.scope,
          pair: key.scope === 'ALL' ? null : key.scope,
          scheduledAt: key.slotAt,
          trigger,
          status: 'RUNNING',
          startedAt: now,
        },
      });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async finish(id: number, status: Exclude<RunStatus, 'RUNNING'>, f: { now: Date; cause?: string | null; error?: string | null; summary?: unknown; retryCount?: number }): Promise<void> {
    await this.prisma.scheduledScan.update({
      where: { id },
      data: {
        status,
        finishedAt: f.now,
        cause: f.cause ?? null,
        error: f.error ? f.error.slice(0, 1000) : null,
        ...(f.summary !== undefined ? { summary: f.summary as object } : {}),
        ...(f.retryCount !== undefined ? { retryCount: f.retryCount } : {}),
      },
    });
  }

  async recordNotRun(key: RunKey, status: 'SKIPPED' | 'MISSED', cause: string, now: Date, trigger: RunTrigger = 'SCHEDULED'): Promise<boolean> {
    try {
      await this.prisma.scheduledScan.create({
        data: {
          kind: key.kind,
          scope: key.scope,
          pair: key.scope === 'ALL' ? null : key.scope,
          scheduledAt: key.slotAt,
          trigger,
          status,
          cause,
          finishedAt: now,
        },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async addItems(runId: number, items: RunItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.prisma.scanRunItem.createMany({
      data: items.map((i) => ({
        scanId: runId,
        pair: i.pair,
        status: i.status,
        decision: (i.decision ?? null) as never,
        signalId: i.signalId ?? null,
        marketSnapshotId: i.marketSnapshotId ?? null,
        qualityStatus: (i.qualityStatus ?? null) as never,
        error: i.error ? i.error.slice(0, 500) : null,
      })),
    });
  }

  async interruptRunning(now: Date): Promise<number> {
    const { count } = await this.prisma.scheduledScan.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'INTERRUPTED', finishedAt: now, cause: 'PROCESS_STOPPED' },
    });
    return count;
  }

  async lastSlotAt(): Promise<Date | null> {
    const row = await this.prisma.scheduledScan.findFirst({
      where: { kind: { in: ['STRATEGY_SCAN', 'COLLECT'] }, trigger: { not: 'RECOVERY' } },
      orderBy: { scheduledAt: 'desc' },
      select: { scheduledAt: true },
    });
    return row?.scheduledAt ?? null;
  }

  async recentRuns(limit: number): Promise<RunRecord[]> {
    const rows = await this.prisma.scheduledScan.findMany({ orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }], take: limit });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      scope: r.scope,
      slotAt: r.scheduledAt,
      trigger: r.trigger,
      status: r.status as RunStatus,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      cause: r.cause,
      error: r.error,
      retryCount: r.retryCount,
    }));
  }

  async readState(): Promise<SchedulerStateRecord | null> {
    const r = await this.prisma.schedulerState.findUnique({ where: { id: 1 } });
    return r
      ? { instanceId: r.instanceId, startedAt: r.startedAt, lastHeartbeatAt: r.lastHeartbeatAt, lastSlotAt: r.lastSlotAt, clockStatus: r.clockStatus, clockSkewMs: r.clockSkewMs }
      : null;
  }

  async writeState(s: SchedulerStateRecord): Promise<void> {
    await this.prisma.schedulerState.upsert({ where: { id: 1 }, create: { id: 1, ...s }, update: s });
  }
}

/** Same rules in memory (unit tests). */
export class InMemorySchedulerRepository implements SchedulerRepository {
  runs: (RunRecord & { summary?: unknown })[] = [];
  items: (RunItem & { runId: number })[] = [];
  state: SchedulerStateRecord | null = null;
  private nextId = 1;

  private find(key: RunKey) {
    return this.runs.find((r) => r.kind === key.kind && r.scope === key.scope && r.slotAt.getTime() === key.slotAt.getTime());
  }

  async claim(key: RunKey, trigger: RunTrigger, now: Date): Promise<number | null> {
    if (this.find(key)) return null;
    const id = this.nextId++;
    this.runs.push({ ...key, id, trigger, status: 'RUNNING', startedAt: now, finishedAt: null, cause: null, error: null, retryCount: 0 });
    return id;
  }

  async finish(id: number, status: Exclude<RunStatus, 'RUNNING'>, f: { now: Date; cause?: string | null; error?: string | null; summary?: unknown; retryCount?: number }): Promise<void> {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, { status, finishedAt: f.now, cause: f.cause ?? null, error: f.error ?? null, summary: f.summary, ...(f.retryCount !== undefined ? { retryCount: f.retryCount } : {}) });
  }

  async recordNotRun(key: RunKey, status: 'SKIPPED' | 'MISSED', cause: string, now: Date, trigger: RunTrigger = 'SCHEDULED'): Promise<boolean> {
    if (this.find(key)) return false;
    this.runs.push({ ...key, id: this.nextId++, trigger, status, startedAt: null, finishedAt: now, cause, error: null, retryCount: 0 });
    return true;
  }

  async addItems(runId: number, items: RunItem[]): Promise<void> {
    this.items.push(...items.map((i) => ({ ...i, runId })));
  }

  async interruptRunning(now: Date): Promise<number> {
    const running = this.runs.filter((r) => r.status === 'RUNNING');
    for (const r of running) Object.assign(r, { status: 'INTERRUPTED', finishedAt: now, cause: 'PROCESS_STOPPED' });
    return running.length;
  }

  async lastSlotAt(): Promise<Date | null> {
    const slots = this.runs.filter((r) => (r.kind === 'STRATEGY_SCAN' || r.kind === 'COLLECT') && r.trigger !== 'RECOVERY').map((r) => r.slotAt.getTime());
    return slots.length ? new Date(Math.max(...slots)) : null;
  }

  async recentRuns(limit: number): Promise<RunRecord[]> {
    return [...this.runs].sort((a, b) => b.slotAt.getTime() - a.slotAt.getTime() || b.id - a.id).slice(0, limit);
  }

  async readState(): Promise<SchedulerStateRecord | null> {
    return this.state;
  }

  async writeState(s: SchedulerStateRecord): Promise<void> {
    this.state = { ...s };
  }
}
