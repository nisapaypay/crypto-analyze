import type { PrismaClient } from '../database/prisma.js';
import type { Logger } from '../logger/logger.js';

export interface AuditEntry {
  action: string;
  telegramUserId?: number;
  details?: Record<string, unknown>;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * Structured audit log (PRD §15). Failures are logged but never thrown,
 * so a database outage cannot break bot command handling.
 */
export class PrismaAuditLog implements AuditLog {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const details = { ...entry.details, ...(entry.telegramUserId ? { telegramUserId: entry.telegramUserId } : {}) };
    try {
      const user = entry.telegramUserId
        ? await this.prisma.user.findUnique({
            where: { telegramUserId: BigInt(entry.telegramUserId) },
            select: { id: true },
          })
        : null;
      await this.prisma.auditLog.create({
        data: { action: entry.action, details, userId: user?.id ?? null },
      });
    } catch (error) {
      this.logger.warn({ err: error, action: entry.action }, 'Gagal menulis audit log');
    }
  }
}
