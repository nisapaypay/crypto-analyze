import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/app/database/prisma.js';
import { PrismaNotificationRepository } from '../../src/notify/notification-repository.js';
import { buildSummaryView } from '../../src/notify/summary.js';
import { PrismaSignalHistory } from '../../src/notify/transitions.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { riskState } from '../helpers/strategy.js';

/**
 * Milestone 5C notification persistence against a real PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set. Own dedup-key prefix and pair names.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PREFIX = 'zztest:';
const PAIR = 'zznotif_idr';

describe.skipIf(!TEST_DATABASE_URL)('notification persistence (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let repo: PrismaNotificationRepository;
  const cleanup = async () => {
    await prisma.notification.deleteMany({ where: { dedupKey: { startsWith: PREFIX } } });
    await prisma.tradingSignal.deleteMany({ where: { pair: PAIR } });
  };
  const key = (k: string) => ({ dedupKey: `${PREFIX}${k}`, kind: 'EARLY_WARNING' as const, pair: PAIR, signalId: null, template: 'early_warning' });

  beforeAll(() => {
    prisma = createPrismaClient(TEST_DATABASE_URL!);
    repo = new PrismaNotificationRepository(prisma);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('dedup: concurrent claims of one key → exactly one PENDING row (no double message)', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => repo.claim(key('a'), new Date())));
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(await prisma.notification.count({ where: { dedupKey: `${PREFIX}a` } })).toBe(1);
    expect(await repo.recordSuppressed(key('a'), 'COOLDOWN_60M', new Date())).toBe(false);
  });

  it('suppressed rows keep the reason; sent rows keep message id, attempts and text hash', async () => {
    await repo.recordSuppressed(key('s'), 'OUTSIDE_ACTIVE_HOURS', new Date());
    await repo.claim(key('ok'), new Date());
    await repo.markSent(`${PREFIX}ok`, { now: new Date(), telegramMessageId: 987, textHash: 'abc', attempts: 2 });
    const rows = await prisma.notification.findMany({ where: { dedupKey: { startsWith: PREFIX } }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.status, r.suppressedReason, r.telegramMessageId?.toString() ?? null, r.attempts])).toEqual([
      ['SUPPRESSED', 'OUTSIDE_ACTIVE_HOURS', null, 0],
      ['SENT', null, '987', 2],
    ]);
  });

  it('cooldown/daily counters count SENT and PENDING; stale PENDING becomes FAILED and stays deduplicated', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await repo.claim(key('p'), old);
    expect(await repo.lastSentAt('EARLY_WARNING', PAIR)).toEqual(old);
    expect(await repo.countSentSince('EARLY_WARNING', new Date(old.getTime() - 1))).toBeGreaterThanOrEqual(1);
    expect(await repo.expireStalePending(new Date(Date.now() - 2 * 60_000))).toBeGreaterThanOrEqual(1);
    const row = await prisma.notification.findUniqueOrThrow({ where: { dedupKey: `${PREFIX}p` } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/UNKNOWN_DELIVERY/);
    expect(await repo.claim(key('p'), new Date())).toBe('duplicate');
  });

  it('signal history and the summary source read stored data only', async () => {
    const candle = new Date('2001-01-01T03:00:00Z');
    await prisma.tradingSignal.create({ data: { pair: PAIR, decision: 'EARLY_WARNING', indicatorSnapshot: {}, status: 'INFO', candleOpenTime: candle, engineVersion: 'test', reasons: { earlyWarning: ['volume naik'] } } });
    const history = new PrismaSignalHistory(prisma);
    expect(await history.previousDecision(PAIR, new Date(candle.getTime() + 900_000))).toEqual({ decision: 'EARLY_WARNING', candleOpenTime: candle, earlyWarning: ['volume naik'] });
    expect(await history.previousDecision(PAIR, candle)).toBeNull();
    const v = await buildSummaryView(
      {
        prisma,
        watchlist: async () => [PAIR],
        riskOverview: async () => ({ risk: riskState(), settings: defaultStrategySettings() }),
        openBuys: async () => [],
        notifications: repo,
        schedulerHealth: () => ({ consecutiveFailures: 0, clock: 'VALID', serverTimeTrusted: true }),
        timeZone: 'Asia/Jakarta',
      },
      new Date(),
      'PAGI',
    );
    // The signal was just stored (created_at = now): it is the latest decision; no snapshot → no price.
    expect(v.pairs).toEqual([expect.objectContaining({ pair: PAIR, decision: 'EARLY_WARNING', price: null, snapshotAt: null })]);
  });
});
