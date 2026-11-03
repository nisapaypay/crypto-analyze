import type { PrismaClient } from '../app/database/prisma.js';
import type { NotificationKind } from './rules.js';

export interface NotificationKey {
  dedupKey: string;
  kind: NotificationKind;
  pair?: string | null;
  signalId?: number | null;
  template: string;
}

export interface SuppressedRecord {
  kind: string;
  pair: string | null;
  signalId: number | null;
  reason: string;
  createdAt: Date;
  template: string;
}

export interface NotificationRepository {
  /** Insert a PENDING row. 'duplicate' if the dedup key already exists (sent, suppressed or pending). */
  claim(k: NotificationKey, now: Date): Promise<'claimed' | 'duplicate'>;
  /** Insert a SUPPRESSED row with its reason. False if the key already exists. */
  recordSuppressed(k: NotificationKey, reason: string, now: Date): Promise<boolean>;
  markSent(dedupKey: string, f: { now: Date; telegramMessageId: number; textHash: string; attempts: number; aiUsed?: boolean }): Promise<void>;
  markFailed(dedupKey: string, f: { error: string; attempts: number; textHash?: string }): Promise<void>;
  /** Latest SENT/PENDING notification of a kind for a pair. */
  lastSentAt(kind: NotificationKind, pair: string): Promise<Date | null>;
  /** SENT/PENDING notifications of a kind since `since`. */
  countSentSince(kind: NotificationKind, since: Date): Promise<number>;
  /** PENDING rows older than `before` → FAILED (UNKNOWN_DELIVERY); they are never re-sent. */
  expireStalePending(before: Date): Promise<number>;
  suppressedSince(since: Date): Promise<SuppressedRecord[]>;
  sentCountsSince(since: Date): Promise<Record<string, number>>;
}

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private data(k: NotificationKey) {
    return { dedupKey: k.dedupKey, kind: k.kind, pair: k.pair ?? null, signalId: k.signalId ?? null, template: k.template };
  }

  async claim(k: NotificationKey, now: Date): Promise<'claimed' | 'duplicate'> {
    try {
      await this.prisma.notification.create({ data: { ...this.data(k), status: 'PENDING', createdAt: now } });
      return 'claimed';
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  async recordSuppressed(k: NotificationKey, reason: string, now: Date): Promise<boolean> {
    try {
      await this.prisma.notification.create({ data: { ...this.data(k), status: 'SUPPRESSED', suppressedReason: reason, createdAt: now } });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async markSent(dedupKey: string, f: { now: Date; telegramMessageId: number; textHash: string; attempts: number; aiUsed?: boolean }): Promise<void> {
    await this.prisma.notification.update({
      where: { dedupKey },
      data: { status: 'SENT', sentAt: f.now, telegramMessageId: BigInt(f.telegramMessageId), textHash: f.textHash, attempts: f.attempts, aiUsed: f.aiUsed ?? false, error: null },
    });
  }

  async markFailed(dedupKey: string, f: { error: string; attempts: number; textHash?: string }): Promise<void> {
    await this.prisma.notification.update({ where: { dedupKey }, data: { status: 'FAILED', error: f.error.slice(0, 500), attempts: f.attempts, ...(f.textHash ? { textHash: f.textHash } : {}) } });
  }

  async lastSentAt(kind: NotificationKind, pair: string): Promise<Date | null> {
    const row = await this.prisma.notification.findFirst({ where: { kind, pair, status: { in: ['SENT', 'PENDING'] } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }

  async countSentSince(kind: NotificationKind, since: Date): Promise<number> {
    return this.prisma.notification.count({ where: { kind, status: { in: ['SENT', 'PENDING'] }, createdAt: { gte: since } } });
  }

  async expireStalePending(before: Date): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({ where: { status: 'PENDING', createdAt: { lt: before } }, data: { status: 'FAILED', error: 'UNKNOWN_DELIVERY: proses berhenti saat mengirim; tidak dikirim ulang agar tidak ganda' } });
    return count;
  }

  async suppressedSince(since: Date): Promise<SuppressedRecord[]> {
    const rows = await this.prisma.notification.findMany({ where: { status: 'SUPPRESSED', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ kind: r.kind, pair: r.pair, signalId: r.signalId, reason: r.suppressedReason ?? '-', createdAt: r.createdAt, template: r.template }));
  }

  async sentCountsSince(since: Date): Promise<Record<string, number>> {
    const rows = await this.prisma.notification.groupBy({ by: ['kind'], where: { status: 'SENT', createdAt: { gte: since } }, _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.kind, r._count._all]));
  }
}

interface Row extends NotificationKey {
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';
  reason: string | null;
  createdAt: Date;
  sentAt: Date | null;
  messageId: number | null;
  textHash: string | null;
  attempts: number;
  error: string | null;
}

export class InMemoryNotificationRepository implements NotificationRepository {
  rows: Row[] = [];

  async claim(k: NotificationKey, now: Date): Promise<'claimed' | 'duplicate'> {
    if (this.rows.some((r) => r.dedupKey === k.dedupKey)) return 'duplicate';
    this.rows.push({ ...k, status: 'PENDING', reason: null, createdAt: now, sentAt: null, messageId: null, textHash: null, attempts: 0, error: null });
    return 'claimed';
  }

  async recordSuppressed(k: NotificationKey, reason: string, now: Date): Promise<boolean> {
    if (this.rows.some((r) => r.dedupKey === k.dedupKey)) return false;
    this.rows.push({ ...k, status: 'SUPPRESSED', reason, createdAt: now, sentAt: null, messageId: null, textHash: null, attempts: 0, error: null });
    return true;
  }

  async markSent(dedupKey: string, f: { now: Date; telegramMessageId: number; textHash: string; attempts: number }): Promise<void> {
    Object.assign(this.rows.find((r) => r.dedupKey === dedupKey)!, { status: 'SENT', sentAt: f.now, messageId: f.telegramMessageId, textHash: f.textHash, attempts: f.attempts });
  }

  async markFailed(dedupKey: string, f: { error: string; attempts: number }): Promise<void> {
    Object.assign(this.rows.find((r) => r.dedupKey === dedupKey)!, { status: 'FAILED', error: f.error, attempts: f.attempts });
  }

  async lastSentAt(kind: NotificationKind, pair: string): Promise<Date | null> {
    const xs = this.rows.filter((r) => r.kind === kind && r.pair === pair && (r.status === 'SENT' || r.status === 'PENDING'));
    return xs.length ? new Date(Math.max(...xs.map((r) => r.createdAt.getTime()))) : null;
  }

  async countSentSince(kind: NotificationKind, since: Date): Promise<number> {
    return this.rows.filter((r) => r.kind === kind && (r.status === 'SENT' || r.status === 'PENDING') && r.createdAt >= since).length;
  }

  async expireStalePending(before: Date): Promise<number> {
    const stale = this.rows.filter((r) => r.status === 'PENDING' && r.createdAt < before);
    for (const r of stale) Object.assign(r, { status: 'FAILED', error: 'UNKNOWN_DELIVERY' });
    return stale.length;
  }

  async suppressedSince(since: Date): Promise<SuppressedRecord[]> {
    return this.rows
      .filter((r) => r.status === 'SUPPRESSED' && r.createdAt >= since)
      .map((r) => ({ kind: r.kind, pair: r.pair ?? null, signalId: r.signalId ?? null, reason: r.reason ?? '-', createdAt: r.createdAt, template: r.template }));
  }

  async sentCountsSince(since: Date): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rows) if (r.status === 'SENT' && r.createdAt >= since) out[r.kind] = (out[r.kind] ?? 0) + 1;
    return out;
  }
}
