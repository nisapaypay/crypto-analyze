import type { PrismaClient } from '../app/database/prisma.js';
import type { SchedulerSettings } from './scan-scheduler.js';

export interface SchedulerControl {
  load(): Promise<SchedulerSettings>;
  /** /pause and /resume. Only `scanning_enabled` changes; capital, risk and watchlist are untouched. */
  setScanning(enabled: boolean): Promise<void>;
}

/** Reads the owner's user_settings (scan interval, active hours, pause flag). */
export class PrismaSchedulerControl implements SchedulerControl {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegramUserId: number,
  ) {}

  async load(): Promise<SchedulerSettings> {
    const s = await this.prisma.userSettings.findFirst({ where: { user: { telegramUserId: BigInt(this.telegramUserId) } } });
    if (!s) throw new Error('Pengaturan pengguna belum ada. Jalankan `pnpm db:seed`.');
    return {
      scanningEnabled: s.scanningEnabled,
      intervalMinutes: s.scanIntervalMinutes,
      activeHours: { start: s.activeHoursStart, end: s.activeHoursEnd },
    };
  }

  async setScanning(enabled: boolean): Promise<void> {
    const { count } = await this.prisma.userSettings.updateMany({
      where: { user: { telegramUserId: BigInt(this.telegramUserId) } },
      data: { scanningEnabled: enabled },
    });
    if (count === 0) throw new Error('Pengaturan pengguna belum ada. Jalankan `pnpm db:seed`.');
  }
}

export class InMemorySchedulerControl implements SchedulerControl {
  constructor(public settings: SchedulerSettings) {}

  async load(): Promise<SchedulerSettings> {
    return { ...this.settings, activeHours: { ...this.settings.activeHours } };
  }

  async setScanning(enabled: boolean): Promise<void> {
    this.settings.scanningEnabled = enabled;
  }
}
