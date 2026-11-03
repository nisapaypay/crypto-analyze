import type { Bot, Context } from 'grammy';
import type { AuditLog } from '../../app/audit/audit-log.js';
import type { Logger } from '../../app/logger/logger.js';
import { cleanPairInput } from '../../exchange/indodax/pair-id.js';
import type { AnalysisResult } from '../../analysis/technical-analysis-service.js';
import { isPairActive, type ResolveResult } from '../../market/pair-registry.js';
import type { WatchlistRepository } from '../../watchlist/watchlist-repository.js';
import { formatPair } from '../messages/format.js';
import { watchlistMarketMessage } from '../messages/messages.js';

export interface WatchlistCommandDeps {
  allowedUserId: number;
  timeZone: string;
  watchlistMax: number;
  logger: Logger;
  audit: AuditLog;
  watchlist: WatchlistRepository;
  pairs: { resolve(input: string): Promise<ResolveResult> };
  analysis: { analyzeMany(pairs: string[]): Promise<AnalysisResult[]> };
  clock: () => Date;
}

const DB_ERROR = 'Gagal membaca watchlist: database tidak tersedia. Cek /status.';

export function registerWatchlistCommands(bot: Bot, deps: WatchlistCommandDeps): void {
  const owner = deps.allowedUserId;

  bot.command('watchlist', async (ctx) => {
    let entries;
    try {
      entries = await deps.watchlist.listForTelegramUser(owner);
    } catch (error) {
      deps.logger.error({ err: error }, 'Gagal membaca watchlist');
      await ctx.reply(DB_ERROR);
      return;
    }
    await ctx.replyWithChatAction('typing');
    const enabled = entries.filter((e) => e.enabled).map((e) => e.pair);
    const results = await deps.analysis.analyzeMany(enabled);
    await ctx.reply(
      watchlistMarketMessage({
        entries,
        market: new Map(results.map((r) => [r.market.pair, r.market])),
        analysis: new Map(results.map((r) => [r.market.pair, r.analysis])),
        now: deps.clock(),
        timeZone: deps.timeZone,
      }),
    );
  });

  const addCoin = async (ctx: Context, input: string) => {
    let resolved: ResolveResult;
    try {
      resolved = await deps.pairs.resolve(input);
    } catch (error) {
      deps.logger.warn({ err: error instanceof Error ? error.message : error }, 'Gagal memuat daftar pair Indodax');
      await ctx.reply('Gagal menghubungi Indodax untuk memverifikasi pair. Coba lagi sebentar lagi.');
      return;
    }

    switch (resolved.status) {
      case 'invalid_input':
        await ctx.reply('Nama koin tidak valid. Gunakan huruf/angka saja, contoh: /addcoin sol');
        return;
      case 'not_found':
        await ctx.reply(`Pair ${resolved.input.toUpperCase()} tidak ditemukan di Indodax.`);
        return;
      case 'not_idr':
        await ctx.reply(`Hanya pair IDR yang didukung (${formatPair(resolved.pair.tickerId)} bukan pair IDR).`);
        return;
    }

    const { pair } = resolved;
    const label = formatPair(pair.tickerId);
    if (!isPairActive(pair)) {
      const reason = pair.isMaintenance ? 'sedang maintenance' : 'pasarnya disuspend';
      await ctx.reply(`${label} ${reason} di Indodax, tidak ditambahkan.`);
      return;
    }

    let result;
    try {
      result = await deps.watchlist.add(owner, pair.tickerId, deps.watchlistMax);
    } catch (error) {
      deps.logger.error({ err: error }, 'Gagal menambah watchlist');
      await ctx.reply(DB_ERROR);
      return;
    }
    await deps.audit.record({ action: 'watchlist.add', telegramUserId: owner, details: { pair: pair.tickerId, result } });

    const replies = {
      added: `${label} ditambahkan ke watchlist.`,
      reenabled: `${label} diaktifkan kembali di watchlist.`,
      exists: `${label} sudah ada di watchlist.`,
      limit_reached: `Watchlist sudah berisi ${deps.watchlistMax} pair (maksimum). Hapus dulu dengan /removecoin.`,
    } as const;
    await ctx.reply(replies[result]);
  };

  const removeCoin = async (ctx: Context, input: string) => {
    const cleaned = cleanPairInput(input);
    if (!cleaned) {
      await ctx.reply('Nama koin tidak valid. Gunakan huruf/angka saja, contoh: /removecoin doge');
      return;
    }
    try {
      const entries = await deps.watchlist.listForTelegramUser(owner);
      const match = entries.find(
        (e) => e.pair === cleaned || e.pair === `${cleaned}_idr` || e.pair.replace('_', '') === cleaned,
      );
      if (!match) {
        await ctx.reply(`${cleaned.toUpperCase()} tidak ada di watchlist. Lihat /watchlist.`);
        return;
      }
      await deps.watchlist.remove(owner, match.pair);
      await deps.audit.record({ action: 'watchlist.remove', telegramUserId: owner, details: { pair: match.pair } });
      await ctx.reply(`${formatPair(match.pair)} dihapus dari watchlist.`);
    } catch (error) {
      deps.logger.error({ err: error }, 'Gagal menghapus watchlist');
      await ctx.reply(DB_ERROR);
    }
  };

  // Picking a command from Telegram's menu sends it immediately, without an
  // argument. Ask for the coin with a force-reply prompt instead of failing.
  bot.command('addcoin', async (ctx) => {
    const input = ctx.match.trim();
    if (input) await addCoin(ctx, input);
    else await askForCoin(ctx, ADD_PROMPT);
  });

  bot.command('removecoin', async (ctx) => {
    const input = ctx.match.trim();
    if (input) await removeCoin(ctx, input);
    else await askForCoin(ctx, REMOVE_PROMPT);
  });

  // Answers to those prompts: plain text replying to the bot's own prompt.
  bot.on('message:text', async (ctx, next) => {
    const prompt = ctx.message.reply_to_message;
    if (prompt?.from?.id === ctx.me.id && !ctx.message.text.startsWith('/')) {
      if (prompt.text?.startsWith(ADD_PROMPT)) return addCoin(ctx, ctx.message.text.trim());
      if (prompt.text?.startsWith(REMOVE_PROMPT)) return removeCoin(ctx, ctx.message.text.trim());
    }
    return next();
  });
}

export const ADD_PROMPT = 'Koin apa yang ingin ditambahkan ke watchlist?';
export const REMOVE_PROMPT = 'Koin apa yang ingin dihapus dari watchlist?';

function askForCoin(ctx: Context, prompt: string) {
  return ctx.reply(`${prompt}\nBalas pesan ini dengan nama koin, contoh: SOL atau SOL/IDR`, {
    reply_markup: { force_reply: true, input_field_placeholder: 'contoh: SOL' },
  });
}
