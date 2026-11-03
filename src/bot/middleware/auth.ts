import type { Context, MiddlewareFn } from 'grammy';
import type { AuditLog } from '../../app/audit/audit-log.js';
import type { Logger } from '../../app/logger/logger.js';

/**
 * Only the configured Telegram user, in a private chat, may use the bot
 * (PRD §3.4, §15). Everything else is dropped silently and audited.
 * Message content from unauthorized users is never logged.
 */
export function authGuard(allowedUserId: number, audit: AuditLog, logger: Logger): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    if (fromId === allowedUserId && chatType === 'private') {
      return next();
    }

    const details = { chatType: chatType ?? null, updateId: ctx.update.update_id };
    logger.warn({ telegramUserId: fromId, ...details }, 'Akses Telegram ditolak');
    await audit.record({
      action: 'telegram.unauthorized',
      ...(fromId !== undefined ? { telegramUserId: fromId } : {}),
      details,
    });
  };
}
