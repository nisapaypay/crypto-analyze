import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/app/database/prisma.js';
import { seedDefaults } from '../../src/app/database/seed-defaults.js';
import { PrismaStrategySettings } from '../../src/strategy/settings.js';
import { PrismaSignalRepository } from '../../src/strategy/signal-repository.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import { DAY_START, engineInput } from '../helpers/strategy.js';

/**
 * Milestone 4 persistence against a real, migrated PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set. Own pair names and Telegram user.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PAIR = 'sttest_idr';
const TEST_USER_ID = 900_000_004;

describe.skipIf(!TEST_DATABASE_URL)('strategy persistence (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let repo: PrismaSignalRepository;

  const cleanup = async () => {
    await prisma.tradingSignal.deleteMany({ where: { pair: PAIR } });
    await prisma.user.deleteMany({ where: { telegramUserId: BigInt(TEST_USER_ID) } });
  };
  const buy = () => ({ ...evaluateStrategy(engineInput()), pair: PAIR });
  const wait = () => ({ ...evaluateStrategy(engineInput({ scenario: { rsi: 100 } })), pair: PAIR });

  beforeAll(() => {
    prisma = createPrismaClient(TEST_DATABASE_URL!);
    repo = new PrismaSignalRepository(prisma);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('stores a BUY with exact plan values, costs and a single reservation', async () => {
    const d = buy();
    expect(d.decision).toBe('BUY_CANDIDATE');
    const s = d.plan!.sizing;
    if (!s.ok) throw new Error('sizing');
    const r = await repo.record(d, { snapshotId: null, reservedRisk: s.atStop.netLoss });
    expect(r).toMatchObject({ storedDecision: 'BUY_CANDIDATE', issuedNow: true });

    const row = await prisma.tradingSignal.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.quantity!.toString()).toBe('0.33408581');
    expect(row.entryMin!.toString()).toBe('3572500');
    expect(row.entryMax!.toString()).toBe('3580000');
    expect(row.stopLoss!.toString()).toBe('3532500');
    expect(row.takeProfit!.toString()).toBe('3722500');
    expect(row.reservedRisk!.toString()).toBe('25000'); // 24.999,99992… rounded UP, never down
    expect(row.estimatedRisk!.toString()).toBe('25000');
    expect(row.estimatedReward!.toString()).toBe('40044.27'); // rounded DOWN
    expect(row.netRr!.toString()).toBe('1.601771');
    expect(row).toMatchObject({ lifecycleStatus: 'ACTIVE', executionStatus: 'UNKNOWN', status: 'ISSUED', engineVersion: '4.0.0', regime: 'BULLISH' });
    expect(row.costAssumptions).toMatchObject({ buyFeePct: '0.2', buyTaxPct: '0.11', verified: false });
    expect((row.gates as unknown[]).length).toBe(12);
  });

  it('re-recording the same candle never issues or reserves twice; a stored BUY is immutable', async () => {
    const first = await repo.record(buy(), { snapshotId: null, reservedRisk: null });
    const again = await repo.record(buy(), { snapshotId: null, reservedRisk: null });
    const thenWait = await repo.record(wait(), { snapshotId: null, reservedRisk: null });
    expect(again).toEqual({ id: first.id, storedDecision: 'BUY_CANDIDATE', issuedNow: false });
    expect(thenWait).toEqual({ id: first.id, storedDecision: 'BUY_CANDIDATE', issuedNow: false });
    expect(await prisma.tradingSignal.count({ where: { pair: PAIR } })).toBe(1);
    expect((await repo.buySignalsSince(DAY_START)).filter((s) => s.pair === PAIR)).toHaveLength(1);
  });

  it('a WAIT row for the candle can be upgraded to BUY once', async () => {
    const w = await repo.record(wait(), { snapshotId: null, reservedRisk: null });
    expect(w).toMatchObject({ storedDecision: 'WAIT', issuedNow: false });
    const b = await repo.record(buy(), { snapshotId: null, reservedRisk: null });
    expect(b).toMatchObject({ id: w.id, storedDecision: 'BUY_CANDIDATE', issuedNow: true });
  });

  it('lifecycle updates are stored; open signals exclude terminal states', async () => {
    const { id } = await repo.record(buy(), { snapshotId: null, reservedRisk: null });
    expect((await repo.openBuySignals()).some((s) => s.id === id)).toBe(true);
    await repo.updateLifecycle(id, 'POSSIBLY_FILLED', new Date('2026-11-02T04:30:00Z'), null);
    const filled = (await repo.openBuySignals()).find((s) => s.id === id)!;
    expect(filled.lifecycle).toBe('POSSIBLY_FILLED');
    expect(filled.reservedRisk.toFixed()).toBe('25000');
    await repo.updateLifecycle(id, 'EXPIRED_UNFILLED', new Date('2026-11-02T04:45:00Z'), null);
    expect((await repo.openBuySignals()).some((s) => s.id === id)).toBe(false);
    const row = await prisma.tradingSignal.findUniqueOrThrow({ where: { id } });
    expect(row.executionStatus).toBe('UNKNOWN'); // M4 never marks anything as executed
  });

  it('settings are read from user_settings (capital and limits unchanged); costs fall back to defaults', async () => {
    await seedDefaults(prisma, TEST_USER_ID);
    const provider = new PrismaStrategySettings(prisma, TEST_USER_ID);
    const s = await provider.load();
    expect(s.limits.capital.toFixed()).toBe('5000000');
    expect(s.limits.riskPerTradePct.toFixed()).toBe('0.5');
    expect(s.limits.dailyLossLimitPct.toFixed()).toBe('1.5');
    expect(s.limits.maxDailyRecommendations).toBe(3);
    expect(s.limits.maxActivePositions).toBe(1);
    expect(s.maxAllocPct.toFixed()).toBe('50');
    expect(s.costs.buyTaxPct.toFixed()).toBe('0.11');
    expect(s.costs.verified).toBe(false);

    await prisma.userSettings.updateMany({ where: { user: { telegramUserId: BigInt(TEST_USER_ID) } }, data: { sellTaxPct: '0.21' } });
    const changed = await provider.load();
    expect(changed.costs.sellTaxPct.toFixed()).toBe('0.21');
    expect(changed.costs.buyTaxPct.toFixed()).toBe('0.11');
  });
});
