import type { PrismaClient } from '../app/database/prisma.js';

export interface WatchlistEntry {
  pair: string;
  enabled: boolean;
}

export type AddResult = 'added' | 'reenabled' | 'exists' | 'limit_reached';

export interface WatchlistRepository {
  listForTelegramUser(telegramUserId: number): Promise<WatchlistEntry[]>;
  /** Add (or re-enable) a pair unless the watchlist already holds `max` enabled pairs. */
  add(telegramUserId: number, pair: string, max: number): Promise<AddResult>;
  /** Returns false if the pair was not on the watchlist. */
  remove(telegramUserId: number, pair: string): Promise<boolean>;
}

export class PrismaWatchlistRepository implements WatchlistRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForTelegramUser(telegramUserId: number): Promise<WatchlistEntry[]> {
    return this.prisma.watchlistItem.findMany({
      where: { user: { telegramUserId: BigInt(telegramUserId) } },
      select: { pair: true, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async add(telegramUserId: number, pair: string, max: number): Promise<AddResult> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { telegramUserId: BigInt(telegramUserId) } });
      const existing = await tx.watchlistItem.findUnique({ where: { userId_pair: { userId: user.id, pair } } });
      if (existing?.enabled) return 'exists';

      const enabledCount = await tx.watchlistItem.count({ where: { userId: user.id, enabled: true } });
      if (enabledCount >= max) return 'limit_reached';

      if (existing) {
        await tx.watchlistItem.update({ where: { id: existing.id }, data: { enabled: true } });
        return 'reenabled';
      }
      await tx.watchlistItem.create({ data: { userId: user.id, pair } });
      return 'added';
    });
  }

  async remove(telegramUserId: number, pair: string): Promise<boolean> {
    const { count } = await this.prisma.watchlistItem.deleteMany({
      where: { pair, user: { telegramUserId: BigInt(telegramUserId) } },
    });
    return count > 0;
  }
}
