import type { Bot } from 'grammy';
import type { Logger } from '../../app/logger/logger.js';
import type { RiskState } from '../../risk/risk-ledger.js';
import type { StrategySettings } from '../../strategy/settings.js';
import type { ScanResult } from '../../strategy/strategy-service.js';
import type { WatchlistRepository } from '../../watchlist/watchlist-repository.js';
import { riskMessage, scanMessage } from '../messages/strategy.js';

export interface StrategyCommandDeps {
  allowedUserId: number;
  timeZone: string;
  logger: Logger;
  watchlist: WatchlistRepository;
  strategy: {
    scan(pairs: string[]): Promise<ScanResult>;
    riskOverview(): Promise<{ risk: RiskState; settings: StrategySettings }>;
  };
  clock: () => Date;
}

/** /scan (immediate watchlist scan) and /risk (read-only risk configuration). */
export function registerStrategyCommands(bot: Bot, deps: StrategyCommandDeps): void {
  bot.command('scan', async (ctx) => {
    let pairs: string[];
    try {
      pairs = (await deps.watchlist.listForTelegramUser(deps.allowedUserId)).filter((e) => e.enabled).map((e) => e.pair);
    } catch (error) {
      deps.logger.error({ err: error }, 'Gagal membaca watchlist');
      await ctx.reply('Gagal membaca watchlist: database tidak tersedia. Cek /status.');
      return;
    }
    if (pairs.length === 0) {
      await ctx.reply('Watchlist kosong. Tambahkan koin dengan /addcoin.');
      return;
    }
    await ctx.replyWithChatAction('typing');
    try {
      await ctx.reply(scanMessage(await deps.strategy.scan(pairs), deps.timeZone));
    } catch (error) {
      deps.logger.error({ err: error }, 'Gagal menjalankan scan');
      await ctx.reply('Scan gagal. Tidak ada rekomendasi yang diterbitkan. Cek /status lalu coba lagi.');
    }
  });

  bot.command('risk', async (ctx) => {
    try {
      await ctx.reply(riskMessage(await deps.strategy.riskOverview(), deps.clock(), deps.timeZone));
    } catch (error) {
      deps.logger.error({ err: error }, 'Gagal membaca konfigurasi risiko');
      await ctx.reply('Gagal membaca konfigurasi risiko. Cek /status.');
    }
  });
}
