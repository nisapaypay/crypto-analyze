import type { PrismaClient } from '../app/database/prisma.js';
import { Dec } from '../app/decimal.js';
import type { Logger } from '../app/logger/logger.js';
import { startOfDayInZone } from '../app/time.js';
import { summaryNotification, type SummaryView } from '../bot/messages/notifications.js';
import type { RiskState } from '../risk/risk-ledger.js';
import type { ClockGuard } from '../scheduler/clock-guard.js';
import type { JobRunner } from '../scheduler/job-runner.js';
import type { SchedulerSettings } from '../scheduler/scan-scheduler.js';
import type { SchedulerRepository } from '../scheduler/scheduler-repository.js';
import { nextDailyAt } from '../scheduler/slots.js';
import type { StrategySettings } from '../strategy/settings.js';
import type { Decision } from '../strategy/types.js';
import type { NotificationRepository } from './notification-repository.js';
import type { Candidate, DispatchResult } from './notifier.js';

export interface SummarySchedulerDeps {
  /** Local "HH:MM" times (approved: 09:05 and 21:30 WIB). */
  times: readonly string[];
  repo: SchedulerRepository;
  runner: JobRunner;
  clock: ClockGuard;
  settings: () => Promise<SchedulerSettings>;
  build: (at: Date, label: SummaryView['label']) => Promise<SummaryView>;
  dispatch: (c: Candidate) => Promise<DispatchResult>;
  isLockHeld: () => boolean;
  logger: Logger;
  timeZone: string;
  /** A summary may still run this late after its time (e.g. after a restart). */
  graceMs: number;
  now?: () => Date;
}

const labelOf = (hhmm: string): SummaryView['label'] => (Number(hhmm.split(':')[0]) < 12 ? 'PAGI' : 'MALAM');

/**
 * Daily market summaries. Each occurrence is one SUMMARY run (unique per
 * time): COMPLETED, SKIPPED (PAUSED / CLOCK_SKEW / LOCK_LOST) or MISSED
 * (OFFLINE, when the process was down past the grace period). /pause stops them.
 */
export class SummaryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly d: SummarySchedulerDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  async start(): Promise<void> {
    this.started = true;
    await this.catchUp();
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Occurrences in the last 24 h without a record: run if within grace, else MISSED (OFFLINE). */
  async catchUp(): Promise<void> {
    const now = this.now();
    for (const hhmm of this.d.times) {
      const at = new Date(nextDailyAt(hhmm, new Date(now.getTime() - 86_400_000), this.d.timeZone).getTime());
      for (const occurrence of [at, new Date(at.getTime() + 86_400_000)]) {
        if (occurrence > now) continue;
        if (now.getTime() - occurrence.getTime() <= this.d.graceMs) await this.runAt(occurrence, hhmm);
        else await this.d.repo.recordNotRun({ kind: 'SUMMARY', scope: 'ALL', slotAt: occurrence }, 'MISSED', 'OFFLINE', now);
      }
    }
  }

  private scheduleNext(): void {
    if (!this.started) return;
    const now = this.now();
    const next = this.d.times.map((t) => ({ t, at: nextDailyAt(t, now, this.d.timeZone) })).sort((a, b) => a.at.getTime() - b.at.getTime())[0]!;
    this.timer = setTimeout(() => {
      void this.runAt(next.at, next.t)
        .catch((error: unknown) => this.d.logger.error({ err: error instanceof Error ? error.message : error }, 'Ringkasan pasar gagal'))
        .finally(() => this.scheduleNext());
    }, Math.max(0, next.at.getTime() - now.getTime()));
  }

  async runAt(at: Date, hhmm: string): Promise<void> {
    const now = this.now();
    const key = { kind: 'SUMMARY' as const, scope: 'ALL', slotAt: at };
    if (!this.d.isLockHeld()) {
      await this.d.repo.recordNotRun(key, 'SKIPPED', 'LOCK_LOST', now);
      return;
    }
    const s = await this.d.settings();
    if (!s.scanningEnabled) {
      await this.d.repo.recordNotRun(key, 'SKIPPED', 'PAUSED', now);
      return;
    }
    if (!this.d.clock.isValid) {
      await this.d.repo.recordNotRun(key, 'SKIPPED', 'CLOCK_SKEW', now);
      return;
    }
    const label = labelOf(hhmm);
    await this.d.runner.run(key, 'SCHEDULED', async () => {
      const view = await this.d.build(at, label);
      const result = await this.d.dispatch({ dedupKey: `summary:${at.toISOString()}`, kind: 'MARKET_SUMMARY', template: `summary_${label.toLowerCase()}`, render: () => summaryNotification(view) });
      return result === 'queued'
        ? { status: 'COMPLETED', summary: { result } }
        : { status: 'SKIPPED', cause: result.toUpperCase().replace(':', '_'), summary: { result } };
    });
  }
}

export interface SummarySourceDeps {
  prisma: PrismaClient;
  watchlist: () => Promise<string[]>;
  riskOverview: () => Promise<{ risk: RiskState; settings: StrategySettings }>;
  openBuys: () => Promise<{ id: number; pair: string; lifecycle: string }[]>;
  notifications: NotificationRepository;
  schedulerHealth: () => SummaryView['scheduler'];
  timeZone: string;
}

/** Builds the summary from stored data only (no market request, no decision). */
export async function buildSummaryView(d: SummarySourceDeps, at: Date, label: SummaryView['label']): Promise<SummaryView> {
  const pairs = await d.watchlist();
  const recentSince = new Date(at.getTime() - 45 * 60_000);
  const windowStart = new Date(at.getTime() - 12 * 3_600_000);
  const rows = await Promise.all(
    pairs.map(async (pair) => {
      const sig = await d.prisma.tradingSignal.findFirst({ where: { pair, createdAt: { gte: recentSince, lte: at } }, orderBy: { createdAt: 'desc' }, select: { decision: true, createdAt: true, regime: true } });
      const snap = await d.prisma.marketSnapshot.findFirst({ where: { pair, timestamp: { lte: at } }, orderBy: { timestamp: 'desc' }, select: { lastPrice: true, spreadPct: true, qualityStatus: true, timestamp: true } });
      return {
        pair,
        decision: (sig?.decision ?? null) as Decision | null,
        decidedAt: sig?.createdAt ?? null,
        regime: sig?.regime ?? null,
        price: snap ? new Dec(snap.lastPrice.toString()) : null,
        spreadPct: snap?.spreadPct ? new Dec(snap.spreadPct.toString()) : null,
        quality: snap?.qualityStatus ?? null,
        snapshotAt: snap?.timestamp ?? null,
      };
    }),
  );
  const risk = await d.riskOverview().catch(() => null);
  const gaps = await d.prisma.dataGap.findMany({ where: { gapEnd: { gt: windowStart }, gapStart: { lt: at }, status: { not: 'BACKFILLED' } } });
  return {
    at,
    label,
    timeZone: d.timeZone,
    pairs: rows,
    risk: risk?.risk ?? null,
    settings: risk?.settings ?? null,
    openBuys: await d.openBuys().catch(() => []),
    sentToday: await d.notifications.sentCountsSince(startOfDayInZone(at, d.timeZone)),
    suppressed: (await d.notifications.suppressedSince(windowStart)).map((s) => ({ kind: s.kind, pair: s.pair, signalId: s.signalId, reason: s.reason, at: s.createdAt })),
    gaps: gaps.map((g) => ({
      pair: g.pair,
      kind: g.kind === 'SNAPSHOT' ? 'snapshot' : `candle ${g.timeframe}m`,
      minutes: Math.round((Math.min(g.gapEnd.getTime(), at.getTime()) - Math.max(g.gapStart.getTime(), windowStart.getTime())) / 60_000),
      cause: g.cause,
    })),
    scheduler: d.schedulerHealth(),
  };
}
