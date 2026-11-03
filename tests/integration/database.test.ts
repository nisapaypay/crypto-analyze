import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaAuditLog } from '../../src/app/audit/audit-log.js';
import { DEFAULT_WATCHLIST } from '../../src/app/config/defaults.js';
import { createPrismaClient, type PrismaClient } from '../../src/app/database/prisma.js';
import { seedDefaults } from '../../src/app/database/seed-defaults.js';
import { createLogger } from '../../src/app/logger/logger.js';
import { PrismaWatchlistRepository } from '../../src/watchlist/watchlist-repository.js';

/**
 * Runs against a real, migrated PostgreSQL database.
 * Skipped unless TEST_DATABASE_URL is set (see README → Testing).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_USER_ID = 900_000_001;

describe.skipIf(!TEST_DATABASE_URL)('database integration', () => {
  let prisma: PrismaClient;

  const cleanup = async () => {
    await prisma.user.deleteMany({ where: { telegramUserId: BigInt(TEST_USER_ID) } });
    await prisma.auditLog.deleteMany({ where: { action: { startsWith: 'test.' } } });
  };

  beforeAll(async () => {
    prisma = createPrismaClient(TEST_DATABASE_URL!);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('seeds default settings and watchlist idempotently', async () => {
    const first = await seedDefaults(prisma, TEST_USER_ID);
    const second = await seedDefaults(prisma, TEST_USER_ID);
    expect(second.userId).toBe(first.userId);

    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: first.userId } });
    expect(settings.capital.toString()).toBe('5000000');
    expect(settings.riskPerTrade.toString()).toBe('0.5');
    expect(settings.entryTimeframe).toBe('15');

    const watchlist = await new PrismaWatchlistRepository(prisma).listForTelegramUser(TEST_USER_ID);
    expect(watchlist.map((w) => w.pair)).toEqual([...DEFAULT_WATCHLIST]);
  });

  it('writes audit logs linked to the user', async () => {
    const audit = new PrismaAuditLog(prisma, createLogger({ level: 'silent' }));
    await audit.record({ action: 'test.command', telegramUserId: TEST_USER_ID, details: { command: 'status' } });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'test.command' }, include: { user: true } });
    expect(log.user?.telegramUserId).toBe(BigInt(TEST_USER_ID));
    expect(log.details).toEqual({ command: 'status', telegramUserId: TEST_USER_ID });
  });
});
