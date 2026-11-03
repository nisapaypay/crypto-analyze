import { DEFAULT_SETTINGS, DEFAULT_WATCHLIST } from '../config/defaults.js';
import type { PrismaClient } from './prisma.js';

/**
 * Idempotently create the single bot owner with default settings and
 * watchlist. Existing settings and watchlist entries are left untouched.
 */
export async function seedDefaults(prisma: PrismaClient, telegramUserId: number): Promise<{ userId: number }> {
  const user = await prisma.user.upsert({
    where: { telegramUserId: BigInt(telegramUserId) },
    update: {},
    create: { telegramUserId: BigInt(telegramUserId), timezone: DEFAULT_SETTINGS.timezone },
  });

  await prisma.userSettings.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      capital: DEFAULT_SETTINGS.capital,
      riskPerTrade: DEFAULT_SETTINGS.riskPerTradePercent,
      dailyLossLimit: DEFAULT_SETTINGS.dailyLossLimitPercent,
      maxDailyTrades: DEFAULT_SETTINGS.maxDailyTrades,
      maxActivePositions: DEFAULT_SETTINGS.maxActivePositions,
      activeHoursStart: DEFAULT_SETTINGS.activeHoursStart,
      activeHoursEnd: DEFAULT_SETTINGS.activeHoursEnd,
      scanIntervalMinutes: DEFAULT_SETTINGS.scanIntervalMinutes,
      mainTimeframe: DEFAULT_SETTINGS.mainTimeframe,
      entryTimeframe: DEFAULT_SETTINGS.entryTimeframe,
    },
  });

  const existing = await prisma.watchlistItem.count({ where: { userId: user.id } });
  if (existing === 0) {
    await prisma.watchlistItem.createMany({
      data: DEFAULT_WATCHLIST.map((pair) => ({ userId: user.id, pair })),
      skipDuplicates: true,
    });
  }

  return { userId: user.id };
}
