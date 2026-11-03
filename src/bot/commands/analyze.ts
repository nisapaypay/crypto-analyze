import type { Bot, Context } from 'grammy';
import type { AnalysisResult } from '../../analysis/technical-analysis-service.js';
import type { AuditLog } from '../../app/audit/audit-log.js';
import type { Logger } from '../../app/logger/logger.js';
import { isPairActive, type ResolveResult } from '../../market/pair-registry.js';
import type { RiskState } from '../../risk/risk-ledger.js';
import type { StrategySettings } from '../../strategy/settings.js';
import type { PairStrategyResult } from '../../strategy/strategy-service.js';
import { analysisMessage } from '../messages/analysis.js';
import { formatPair } from '../messages/format.js';
import { strategyMessage } from '../messages/strategy.js';

export interface AnalyzeCommandDeps {
  timeZone: string;
  logger: Logger;
  audit: AuditLog;
  pairs: { resolve(input: string): Promise<ResolveResult> };
  analysis: { analyze(pair: string): Promise<AnalysisResult> };
  /** Milestone 4: when present, /analyze also shows the strategy decision. */
  strategy?: { evaluate(pair: string): Promise<PairStrategyResult & { risk: RiskState; settings: StrategySettings }> };
  clock: () => Date;
}

export const ANALYZE_PROMPT = 'Koin apa yang ingin dianalisis?';

/** /analyze <koin>: detailed technical indicators (and, from M4, the strategy decision) for any active IDR pair. */
export function registerAnalyzeCommand(bot: Bot, deps: AnalyzeCommandDeps): void {
  const analyze = async (ctx: Context, input: string) => {
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
        await ctx.reply('Nama koin tidak valid. Gunakan huruf/angka saja, contoh: /analyze qnt');
        return;
      case 'not_found':
        await ctx.reply(`Pair ${resolved.input.toUpperCase()} tidak ditemukan di Indodax.`);
        return;
      case 'not_idr':
        await ctx.reply(`Hanya pair IDR yang didukung (${formatPair(resolved.pair.tickerId)} bukan pair IDR).`);
        return;
    }
    const { pair } = resolved;
    if (!isPairActive(pair)) {
      await ctx.reply(`${formatPair(pair.tickerId)} ${pair.isMaintenance ? 'sedang maintenance' : 'pasarnya disuspend'} di Indodax; analisis tidak tersedia.`);
      return;
    }

    await ctx.replyWithChatAction('typing');
    try {
      if (deps.strategy) {
        const result = await deps.strategy.evaluate(pair.tickerId);
        // Two messages: the indicator report (unchanged) and the strategy decision.
        await ctx.reply(analysisMessage(result.analysis, deps.clock(), deps.timeZone));
        await ctx.reply(strategyMessage(result, deps.timeZone));
      } else {
        const { analysis } = await deps.analysis.analyze(pair.tickerId);
        await ctx.reply(analysisMessage(analysis, deps.clock(), deps.timeZone));
      }
    } catch (error) {
      deps.logger.error({ err: error, pair: pair.tickerId }, 'Gagal menghitung analisis teknikal');
      await ctx.reply('Gagal menghitung analisis teknikal. Cek /status lalu coba lagi.');
    }
  };

  bot.command('analyze', async (ctx) => {
    const input = ctx.match.trim();
    if (input) await analyze(ctx, input);
    else {
      await ctx.reply(`${ANALYZE_PROMPT}\nBalas pesan ini dengan nama koin, contoh: QNT atau QNT/IDR`, {
        reply_markup: { force_reply: true, input_field_placeholder: 'contoh: QNT' },
      });
    }
  });

  bot.on('message:text', async (ctx, next) => {
    const prompt = ctx.message.reply_to_message;
    if (prompt?.from?.id === ctx.me.id && prompt.text?.startsWith(ANALYZE_PROMPT) && !ctx.message.text.startsWith('/')) {
      return analyze(ctx, ctx.message.text.trim());
    }
    return next();
  });
}
