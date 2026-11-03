import type { Bot } from 'grammy';
import type { AuditLog } from '../../app/audit/audit-log.js';
import type { Logger } from '../../app/logger/logger.js';
import type { SchedulerControl } from '../../scheduler/scheduler-settings.js';

export interface SchedulerCommandDeps {
  allowedUserId: number;
  logger: Logger;
  audit: AuditLog;
  schedulerControl: Pick<SchedulerControl, 'setScanning'>;
}

export const PAUSED_MESSAGE = [
  'SCAN OTOMATIS DIJEDA',
  '',
  'Dihentikan: scan strategi, monitor entry, dan ringkasan pasar.',
  'Tetap berjalan: pengumpulan data pasar 24/7 (tanpa notifikasi).',
  '',
  'Lanjutkan dengan /resume.',
].join('\n');

export const RESUMED_MESSAGE = ['SCAN OTOMATIS DILANJUTKAN', '', 'Scan strategi berikutnya berjalan pada slot candle 15m berikutnya (dalam jam aktif).'].join('\n');

/** /pause and /resume (PRD §11.1). Only the scanning flag changes. */
export function registerSchedulerCommands(bot: Bot, deps: SchedulerCommandDeps): void {
  const toggle = (enabled: boolean) => async (ctx: { reply(text: string): Promise<unknown> }) => {
    try {
      await deps.schedulerControl.setScanning(enabled);
    } catch (error) {
      deps.logger.error({ err: error }, 'Gagal mengubah status scan otomatis');
      await ctx.reply('Gagal mengubah status scan otomatis: database tidak tersedia. Cek /status.');
      return;
    }
    await deps.audit.record({ action: enabled ? 'scheduler.resumed' : 'scheduler.paused', telegramUserId: deps.allowedUserId });
    await ctx.reply(enabled ? RESUMED_MESSAGE : PAUSED_MESSAGE);
  };
  bot.command('pause', toggle(false));
  bot.command('resume', toggle(true));
}
