import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/app/database/prisma.js';
import { createLogger } from '../../src/app/logger/logger.js';
import { missingRanges, PrismaCandleStore } from '../../src/scheduler/candle-continuity.js';
import { PrismaGapRepository } from '../../src/scheduler/data-gaps.js';
import { InstanceLock } from '../../src/scheduler/instance-lock.js';
import { PrismaSchedulerRepository } from '../../src/scheduler/scheduler-repository.js';

/**
 * Milestone 5 scheduler persistence against a real, migrated PostgreSQL.
 * Skipped unless TEST_DATABASE_URL is set. Uses its own scope and a test-only lock key.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCOPE = 'zz_sched_test';
const TEST_LOCK_KEY = 900_000_000_005n;
const slot = (min: number) => new Date(Date.UTC(2001, 0, 1, 0, min, 30));

describe.skipIf(!TEST_DATABASE_URL)('scheduler persistence (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let repo: PrismaSchedulerRepository;
  const logger = createLogger({ level: 'silent' });

  const cleanup = () => prisma.scheduledScan.deleteMany({ where: { scope: SCOPE } });

  beforeAll(() => {
    prisma = createPrismaClient(TEST_DATABASE_URL!);
    repo = new PrismaSchedulerRepository(prisma);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('a (kind, scope, slot) can be claimed only once, even concurrently', async () => {
    const key = { kind: 'COLLECT' as const, scope: SCOPE, slotAt: slot(1) };
    const ids = await Promise.all([1, 2, 3, 4].map(() => repo.claim(key, 'SCHEDULED', new Date())));
    expect(ids.filter((i) => i !== null)).toHaveLength(1);
    expect(await prisma.scheduledScan.count({ where: { scope: SCOPE } })).toBe(1);
    // Another kind for the same slot is a different run (paused strategy slot + collection).
    expect(await repo.claim({ ...key, kind: 'STRATEGY_SCAN' }, 'SCHEDULED', new Date())).not.toBeNull();
  });

  it('finish stores status, cause, retries, summary and per-pair items', async () => {
    const id = (await repo.claim({ kind: 'STRATEGY_SCAN', scope: SCOPE, slotAt: slot(2) }, 'SCHEDULED', new Date()))!;
    await repo.addItems(id, [
      { pair: 'doge_idr', status: 'OK', decision: 'WAIT', signalId: null, marketSnapshotId: null, qualityStatus: 'OK' },
      { pair: 'xrp_idr', status: 'FAILED', error: 'timeout' },
    ]);
    await repo.finish(id, 'COMPLETED', { now: new Date(), cause: 'PARTIAL_1_OF_2', retryCount: 1, summary: { pairs: 2 } });
    const row = await prisma.scheduledScan.findUniqueOrThrow({ where: { id }, include: { items: true } });
    expect(row).toMatchObject({ status: 'COMPLETED', cause: 'PARTIAL_1_OF_2', retryCount: 1, summary: { pairs: 2 } });
    expect(row.items.map((i) => [i.pair, i.status, i.decision])).toEqual([
      ['doge_idr', 'OK', 'WAIT'],
      ['xrp_idr', 'FAILED', null],
    ]);
  });

  it('missed/skipped slots are recorded once and never overwrite a real run', async () => {
    const key = { kind: 'COLLECT' as const, scope: SCOPE, slotAt: slot(3) };
    expect(await repo.recordNotRun(key, 'MISSED', 'OFFLINE', new Date())).toBe(true);
    expect(await repo.recordNotRun(key, 'MISSED', 'SLEEP', new Date())).toBe(false);
    expect(await repo.claim(key, 'SCHEDULED', new Date())).toBeNull();
    const row = await prisma.scheduledScan.findFirstOrThrow({ where: { scope: SCOPE } });
    expect(row).toMatchObject({ status: 'MISSED', cause: 'OFFLINE' });
  });

  it('runs left RUNNING by a dead process become INTERRUPTED', async () => {
    await repo.claim({ kind: 'COLLECT', scope: SCOPE, slotAt: slot(4) }, 'SCHEDULED', new Date());
    expect(await repo.interruptRunning(new Date())).toBeGreaterThanOrEqual(1);
    const row = await prisma.scheduledScan.findFirstOrThrow({ where: { scope: SCOPE } });
    expect(row).toMatchObject({ status: 'INTERRUPTED', cause: 'PROCESS_STOPPED' });
  });

  it('scheduler heartbeat state is a single upserted row', async () => {
    const before = await repo.readState();
    const s = { instanceId: 'test', startedAt: new Date(), lastHeartbeatAt: new Date(), lastSlotAt: null, clockStatus: 'VALID', clockSkewMs: 120 };
    await repo.writeState(s);
    await repo.writeState({ ...s, clockSkewMs: 80 });
    expect(await prisma.schedulerState.count()).toBe(1);
    expect(await repo.readState()).toMatchObject({ instanceId: 'test', clockSkewMs: 80 });
    if (before) await repo.writeState(before);
    else await prisma.schedulerState.deleteMany();
  });

  it('snapshot gaps are PERMANENT and adjacent slots with the same cause merge into one row', async () => {
    const gaps = new PrismaGapRepository(prisma);
    const pair = 'zzgap_idr';
    await prisma.dataGap.deleteMany({ where: { pair } });
    await gaps.recordSnapshotGap(pair, slot(0), slot(15), 'OFFLINE');
    await gaps.recordSnapshotGap(pair, slot(15), slot(30), 'OFFLINE');
    await gaps.recordSnapshotGap(pair, slot(30), slot(45), 'API_ERROR');
    await gaps.recordSnapshotGap(pair, slot(15), slot(30), 'OFFLINE'); // repeated: no change
    const rows = await prisma.dataGap.findMany({ where: { pair }, orderBy: { gapStart: 'asc' } });
    expect(rows.map((r) => [r.kind, r.gapStart.toISOString(), r.gapEnd.toISOString(), r.cause, r.status])).toEqual([
      ['SNAPSHOT', slot(0).toISOString(), slot(30).toISOString(), 'OFFLINE', 'PERMANENT'],
      ['SNAPSHOT', slot(30).toISOString(), slot(45).toISOString(), 'API_ERROR', 'PERMANENT'],
    ]);
    await gaps.upsertCandleGap(pair, '15', slot(0), slot(30), 'DETECTED', 'OPEN');
    await gaps.upsertCandleGap(pair, '15', slot(0), slot(30), 'DETECTED', 'BACKFILLED');
    expect(await prisma.dataGap.count({ where: { pair, kind: 'CANDLE' } })).toBe(1);
    expect(await gaps.permanentCandleGaps(pair, '15')).toEqual([]);
    await prisma.dataGap.deleteMany({ where: { pair } });
  });

  it('candle store reads stored open times; views are queryable', async () => {
    const store = new PrismaCandleStore(prisma);
    const pair = 'zzcandle_idr';
    await prisma.candle.deleteMany({ where: { pair } });
    const base = Date.UTC(2001, 0, 1);
    await prisma.candle.createMany({
      data: [0, 1, 3].map((i) => ({ pair, timeframe: '15', openTime: new Date(base + i * 900_000), open: '1', high: '1', low: '1', close: '1', volume: '0' })),
    });
    expect(await store.firstOpenTime(pair, '15')).toEqual(new Date(base));
    const times = await store.openTimes(pair, '15', new Date(base), new Date(base + 4 * 900_000));
    expect(missingRanges(times, new Date(base), new Date(base + 4 * 900_000), 900_000)).toEqual([{ start: new Date(base + 2 * 900_000), end: new Date(base + 3 * 900_000) }]);
    await prisma.candle.deleteMany({ where: { pair } });
    await expect(prisma.$queryRaw`SELECT * FROM v_data_coverage LIMIT 1`).resolves.toBeDefined();
    await expect(prisma.$queryRaw`SELECT imbalance_1pct, imbalance_2pct, trade_buy_ratio_60m FROM v_market_snapshot_metrics LIMIT 1`).resolves.toBeDefined();
  });

  it('advisory lock: a second instance cannot acquire it; it is released on release()/connection loss', async () => {
    const a = new InstanceLock(TEST_DATABASE_URL!, logger, TEST_LOCK_KEY);
    const b = new InstanceLock(TEST_DATABASE_URL!, logger, TEST_LOCK_KEY);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(await a.verify()).toBe(true);
    await a.release();
    expect(a.isHeld).toBe(false);
    expect(await b.acquire()).toBe(true);
    let lost = false;
    b.onLost(() => (lost = true));
    // Simulate the server killing the session (crash / power loss of the DB connection).
    await prisma.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = ${Number(TEST_LOCK_KEY & 0xffffffffn)} AND classid = ${Number(TEST_LOCK_KEY >> 32n)}`,
    );
    expect(await b.verify()).toBe(false);
    expect(lost).toBe(true);
    const c = new InstanceLock(TEST_DATABASE_URL!, logger, TEST_LOCK_KEY);
    expect(await c.acquire()).toBe(true);
    await c.release();
  });
});
