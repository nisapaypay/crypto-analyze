import { limit } from '@grammyjs/ratelimiter';
import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { ComponentHealth } from '../app/health/health-service.js';
import { registerAnalyzeCommand, type AnalyzeCommandDeps } from './commands/analyze.js';
import { COMMANDS } from './commands/registry.js';
import { registerStrategyCommands, type StrategyCommandDeps } from './commands/strategy.js';
import { registerWatchlistCommands, type WatchlistCommandDeps } from './commands/watchlist.js';
import { helpMessage, notAvailableMessage, startMessage, statusMessage } from './messages/messages.js';
import { authGuard } from './middleware/auth.js';

export interface BotDeps extends Omit<WatchlistCommandDeps, 'clock' | 'analysis'> {
  token: string;
  analysis: WatchlistCommandDeps['analysis'] & AnalyzeCommandDeps['analysis'];
  strategy: StrategyCommandDeps['strategy'] & NonNullable<AnalyzeCommandDeps['strategy']>;
  health: { check(): Promise<ComponentHealth[]> };
  ai: { enabled: boolean; disabledReason?: string | undefined };
  clock?: () => Date;
  /** Pre-supplied bot info skips the getMe call (used in tests). */
  botInfo?: UserFromGetMe;
}

export function createBot(deps: BotDeps): Bot {
  const clock = deps.clock ?? (() => new Date());
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});

  // Rate limit first so floods are dropped before any DB work (audit) happens.
  bot.use(
    limit({
      timeFrame: 5_000,
      limit: 5,
      keyGenerator: (ctx: Context) => ctx.from?.id.toString(),
      onLimitExceeded: async (ctx: Context) => {
        if (ctx.from?.id === deps.allowedUserId) {
          await ctx.reply('Terlalu banyak perintah. Tunggu beberapa detik.');
        }
      },
    }),
  );
  bot.use(authGuard(deps.allowedUserId, deps.audit, deps.logger));

  bot.on('message::bot_command', async (ctx, next) => {
    const text = ctx.message.text ?? '';
    const command = text.split(/[\s@]/)[0]?.slice(1) ?? '';
    // The owner's own arguments, truncated; helps diagnose "command did nothing" reports.
    const args = text.slice(text.search(/\s|$/)).trim().slice(0, 50);
    await deps.audit.record({
      action: 'telegram.command',
      telegramUserId: deps.allowedUserId,
      details: args ? { command, args } : { command },
    });
    await next();
  });

  bot.command('start', (ctx) => ctx.reply(startMessage()));
  bot.command('help', (ctx) => ctx.reply(helpMessage()));

  bot.command('status', async (ctx) => {
    const components = await deps.health.check();
    await ctx.reply(statusMessage({ now: clock(), timeZone: deps.timeZone, components, ai: deps.ai }));
  });

  registerWatchlistCommands(bot, { ...deps, clock });
  registerAnalyzeCommand(bot, { ...deps, clock });
  registerStrategyCommands(bot, { ...deps, clock });

  for (const info of COMMANDS.filter((c) => c.plannedMilestone !== null)) {
    bot.command(info.command, (ctx) => ctx.reply(notAvailableMessage(info)));
  }

  bot.on('message:text', (ctx) => ctx.reply('Perintah tidak dikenal. Ketik /help untuk daftar perintah.'));

  bot.catch((err) => {
    deps.logger.error({ err: err.error, updateId: err.ctx.update.update_id }, 'Error saat memproses update Telegram');
  });

  return bot;
}

/** Publish the command list shown in Telegram's "/" menu. */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(COMMANDS.map(({ command, description }) => ({ command, description })));
}
