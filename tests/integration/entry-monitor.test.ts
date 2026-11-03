import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toJsonSafe } from '../../src/analysis/types.js';
import { Dec } from '../../src/app/decimal.js';
import { createPrismaClient, type PrismaClient } from '../../src/app/database/prisma.js';
import { createLogger } from '../../src/app/logger/logger.js';
import { adviceNotification } from '../../src/bot/messages/notifications.js';
import type { PairMarketData } from '../../src/market/market-data-service.js';
import { PrismaNotificationRepository } from '../../src/notify/notification-repository.js';
import { Notifier } from '../../src/notify/notifier.js';
import { NOTIFY_DEFAULTS } from '../../src/notify/rules.js';
import { PrismaSignalHistory } from '../../src/notify/transitions.js';
import { computeRiskState, type LedgerSignal } from '../../src/risk/risk-ledger.js';
import { PrismaActiveBuyReader } from '../../src/scheduler/active-buys.js';
import { EntryMonitor } from '../../src/scheduler/entry-monitor.js';
import { JobRunner } from '../../src/scheduler/job-runner.js';
import { PrismaSchedulerRepository } from '../../src/scheduler/scheduler-repository.js';
import { STRATEGY_DEFAULTS } from '../../src/strategy/config.js';
import { PrismaSignalRepository } from '../../src/strategy/signal-repository.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import { DAY_START, engineInput, EVAL_AT, LIMITS, UNAVAILABLE } from '../helpers/strategy.js';

/**
 * Milestone 5D against a real PostgreSQL database: the entry monitor reads an
 * ACTIVE BUY, writes only its own run records and protective advice, and leaves
 * trading_signals and the risk ledger exactly as they were. Skipped unless
 * TEST_DATABASE_URL is set. Own pair name.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PAIR = 'zzmon_idr';
const logger = createLogger({ level: 'silent' });
const at = (min: number) => new Date(EVAL_AT.getTime() + min * 60_000);

describe.skipIf(!TEST_DATABASE_URL)('entry monitor (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let signalId = 0;
  const cleanup = async () => {
    const ids = (await prisma.tradingSignal.findMany({ where: { pair: PAIR }, select: { id: true } })).map((r) => r.id);
    await prisma.notification.deleteMany({ where: { OR: ids.map((id) => ({ dedupKey: { startsWith: `advice:${id}:` } })) } });
    await prisma.scheduledScan.deleteMany({ where: { kind: 'MONITOR', scheduledAt: { gte: at(-5), lte: at(60) } } });
    await prisma.tradingSignal.deleteMany({ where: { pair: PAIR } });
  };

  beforeAll(async () => {
    prisma = createPrismaClient(TEST_DATABASE_URL!);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('advises once per reason and never changes trading_signals, the lifecycle or the risk ledger', async () => {
    const signals = new PrismaSignalRepository(prisma);
    const d = { ...evaluateStrategy(engineInput()), pair: PAIR };
    expect(d.decision).toBe('BUY_CANDIDATE');
    const s = d.plan!.sizing;
    if (!s.ok) throw new Error('sizing');
    signalId = (await signals.record(d, { snapshotId: null, reservedRisk: s.atStop.netLoss })).id;

    const snapshot = async () => JSON.stringify(await prisma.tradingSignal.findMany({ where: { pair: PAIR }, orderBy: { id: 'asc' } }), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const ledger = async () => {
      const all = [...(await signals.buySignalsSince(DAY_START)), ...(await signals.openBuySignals())].filter((x) => x.pair === PAIR);
      return JSON.stringify(toJsonSafe(computeRiskState(all as LedgerSignal[], LIMITS, UNAVAILABLE, DAY_START)));
    };
    const rowsBefore = await snapshot();
    const ledgerBefore = await ledger();
    const buysBefore = await prisma.tradingSignal.count({ where: { decision: 'BUY_CANDIDATE' } });

    // Market as seen on successive minutes.
    const p = d.plan!;
    const chase = p.chaseLimit;
    const base = { bid: p.entry.max.plus(1000), ask: p.entry.max.plus(1500), status: 'OK' as const, codes: [] as string[], maintenance: false };
    const scenarios = [
      { ...base, ask: chase.plus(500) }, // chase limit exceeded
      { ...base, ask: chase.plus(900) }, // same reason again
      { ...base, bid: p.stop, ask: p.stop.plus(1000) }, // bid at SL
      { ...base, status: 'UNAVAILABLE' as const, codes: ['ORDERBOOK_STALE'] },
      { ...base, status: 'UNAVAILABLE' as const, codes: ['PAIR_MAINTENANCE'], maintenance: true },
    ];
    let i = 0;
    let now = at(1);
    const refresh = async (): Promise<PairMarketData> => {
      const sc = scenarios[Math.min(i++, scenarios.length - 1)]!;
      return {
        pair: PAIR,
        timeframe: '15',
        pairInfo: { isMaintenance: sc.maintenance, isSuspended: false },
        metrics: { bestBid: new Dec(sc.bid), bestAsk: new Dec(sc.ask) },
        ticker: null,
        quality: { status: sc.status, issues: sc.codes.map((code) => ({ code, severity: 'critical', message: code })), checkedAt: now },
        finalCandles: [],
        pendingCandle: { pair: PAIR, timeframe: '15', openTime: new Date(d.candleOpenTime!.getTime() + 15 * 60_000), open: p.entry.max.plus(2000), high: p.entry.max.plus(3000), low: p.entry.max.plus(500), close: p.entry.max.plus(2000), volume: new Dec(1) },
        snapshotId: null,
      } as unknown as PairMarketData;
    };

    const sent: string[] = [];
    const notifications = new PrismaNotificationRepository(prisma);
    const notifier = new Notifier({
      repo: notifications,
      send: async (text) => (sent.push(text), { ok: true, messageId: sent.length, attempts: 1 }),
      history: new PrismaSignalHistory(prisma),
      settings: async () => ({ scanningEnabled: true, activeHours: { start: '09:00', end: '22:00' } }),
      audit: { record: async () => undefined },
      logger,
      timeZone: 'Asia/Jakarta',
      config: NOTIFY_DEFAULTS,
      now: () => now,
    });
    const repo = new PrismaSchedulerRepository(prisma);
    const monitor = new EntryMonitor({
      buys: new PrismaActiveBuyReader(prisma, STRATEGY_DEFAULTS.signal.chaseAtr),
      refresh,
      advise: ({ signal, reason, at: when }) =>
        notifier.dispatch({
          dedupKey: `advice:${signal.id}:${reason}`,
          kind: 'ADVICE_DO_NOT_ENTER',
          pair: signal.pair,
          signalId: signal.id,
          template: `advice_${reason.toLowerCase()}`,
          advice: { signalIssuedAt: signal.createdAt, signalExpiresAt: signal.expiresAt, lifecycle: 'ACTIVE' },
          render: () => adviceNotification({ signalId: signal.id, pair: signal.pair, reason, at: when }, 'Asia/Jakarta'),
        }),
      repo,
      runner: new JobRunner(repo, logger, { watchdogMs: 10_000, now: () => now }),
      isPaused: async () => false,
      isLockHeld: () => true,
      logger,
      tickMs: 60_000,
      maxTicksPerSignal: 31,
      now: () => now,
    });

    for (let m = 1; m <= 5; m++) {
      now = at(m);
      expect(await monitor.tick()).toBe('done');
    }
    await notifier.idle();

    // One advice per reason (the repeated chase-limit minute produced nothing new).
    const advice = await prisma.notification.findMany({ where: { dedupKey: { startsWith: `advice:${signalId}:` } }, orderBy: { id: 'asc' } });
    expect(advice.map((a) => `${a.dedupKey.split(':')[2]}:${a.status}`)).toEqual(['CHASE_LIMIT_EXCEEDED:SENT', 'BELOW_STOP_LOSS:SENT', 'DATA_UNAVAILABLE:SENT', 'PAIR_MAINTENANCE:SENT']);
    expect(sent).toHaveLength(4);
    for (const text of sent) expect(text).not.toMatch(/Rp\d|Entry \(|Stop loss:|Take profit:|Jumlah:/);

    // Its own records: one MONITOR run per minute, each linked to the signal.
    const runs = await prisma.scheduledScan.findMany({ where: { kind: 'MONITOR', scheduledAt: { gte: at(0), lte: at(6) } }, include: { items: true } });
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.status === 'COMPLETED' && r.items.every((x) => x.signalId === signalId))).toBe(true);

    // Nothing about the recommendation changed; no new BUY exists.
    expect(await snapshot()).toBe(rowsBefore);
    expect(await ledger()).toBe(ledgerBefore);
    expect(await prisma.tradingSignal.count({ where: { decision: 'BUY_CANDIDATE' } })).toBe(buysBefore);
    const row = await prisma.tradingSignal.findUniqueOrThrow({ where: { id: signalId } });
    expect(row).toMatchObject({ lifecycleStatus: 'ACTIVE', executionStatus: 'UNKNOWN', decision: 'BUY_CANDIDATE' });

    // After expiry the reader returns nothing: monitoring stops by itself.
    now = new Date(row.expiresAt!.getTime());
    expect(await monitor.tick()).toBe('idle');
  });
});
