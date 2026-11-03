import { createHash } from 'node:crypto';
import type { AuditLog } from '../app/audit/audit-log.js';
import type { Logger } from '../app/logger/logger.js';
import { startOfDayInZone } from '../app/time.js';
import { buyNotification, earlyWarningNotification, lifecycleNotification } from '../bot/messages/notifications.js';
import type { ScanResult } from '../strategy/strategy-service.js';
import type { NotificationKey, NotificationRepository } from './notification-repository.js';
import { decide, type AdviceFacts, type EarlyWarningFacts, type NotificationKind, type RuleConfig, type RuleContext } from './rules.js';
import type { SendResult } from './telegram-sender.js';
import type { SignalHistory } from './transitions.js';

export interface NotifierSettings {
  scanningEnabled: boolean;
  activeHours: { start: string; end: string };
}

export interface NotifierDeps {
  repo: NotificationRepository;
  send: (text: string) => Promise<SendResult>;
  history: SignalHistory;
  settings: () => Promise<NotifierSettings>;
  audit: AuditLog;
  logger: Logger;
  timeZone: string;
  config: RuleConfig;
  now?: () => Date;
}

export interface Candidate extends NotificationKey {
  render: () => string;
  ew?: Omit<EarlyWarningFacts, 'lastSentAt' | 'sentToday'>;
  advice?: AdviceFacts;
}

export type DispatchResult = 'queued' | 'duplicate' | `suppressed:${string}`;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
/** Lifecycle changes older than this are not reported (avoids a backlog on first start). */
const LIFECYCLE_LOOKBACK_MS = 24 * 3_600_000;

/**
 * Turns scheduled-scan results into Telegram notifications. Pipeline per
 * candidate: rules (active hours, pause, EARLY_WARNING change/cooldown/cap) →
 * SUPPRESSED row with reason, or PENDING claim (unique dedup key = no
 * duplicates) → queued send → SENT / FAILED. Work is serialised internally and
 * the caller never waits for Telegram (fire-and-forget from the scheduler).
 * WAIT, NO_TRADE and DATA_UNAVAILABLE never produce a notification.
 */
export class Notifier {
  private chain: Promise<unknown> = Promise.resolve();
  private sends: Promise<unknown>[] = [];

  constructor(private readonly d: NotifierDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  /** Called after every scheduled strategy scan. Never throws; never blocks the caller beyond scheduling. */
  afterStrategyScan(scan: ScanResult): Promise<void> {
    return this.enqueue(async () => {
      for (const r of scan.results) {
        const d = r.decision;
        if (d.decision === 'BUY_CANDIDATE' && r.signalId !== null && r.existingBuyId === null) {
          const signalId = r.signalId;
          await this.process({
            dedupKey: `buy:${signalId}`,
            kind: 'BUY_CANDIDATE',
            pair: d.pair,
            signalId,
            template: 'buy',
            render: () => buyNotification({ ...r, risk: scan.risk, settings: scan.settings }, signalId, this.d.timeZone),
          });
        } else if (d.decision === 'EARLY_WARNING' && d.candleOpenTime) {
          const prev = await this.d.history.previousDecision(d.pair, d.candleOpenTime);
          // Unchanged = the directly preceding candle was EARLY_WARNING with the same signals.
          const consecutive = prev && d.candleOpenTime.getTime() - prev.candleOpenTime.getTime() <= 20 * 60_000;
          const unchanged = !!consecutive && prev.decision === 'EARLY_WARNING' && sameSet(prev.earlyWarning, d.earlyWarningSignals);
          await this.process({
            dedupKey: `ew:${d.pair}:${d.candleOpenTime.toISOString()}`,
            kind: 'EARLY_WARNING',
            pair: d.pair,
            signalId: r.signalId,
            template: 'early_warning',
            ew: { unchanged },
            render: () => earlyWarningNotification(r, this.d.timeZone),
          });
        }
        // WAIT / NO_TRADE / DATA_UNAVAILABLE: no notification by design.
      }
      await this.lifecycleChanges();
    });
  }

  /** Summary, system and (5D) advice notifications go through the same rules and dedup. */
  dispatch(c: Candidate): Promise<DispatchResult> {
    return this.enqueue(() => this.process(c)) as Promise<DispatchResult>;
  }

  /** Resolves when queued processing and sends are finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await this.chain;
    await Promise.allSettled(this.sends);
  }

  /** Startup: PENDING rows from a crashed process are marked FAILED and never re-sent. */
  async recoverPending(staleMs: number): Promise<number> {
    const n = await this.d.repo.expireStalePending(new Date(this.now().getTime() - staleMs));
    if (n > 0) this.d.logger.warn({ count: n }, 'Notifikasi PENDING dari proses sebelumnya ditandai FAILED (tidak dikirim ulang)');
    return n;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T | undefined> {
    const run = this.chain.then(task).catch((error: unknown) => {
      this.d.logger.error({ err: error instanceof Error ? error.message : error }, 'Notifier gagal memproses');
      return undefined;
    });
    this.chain = run;
    return run;
  }

  private async lifecycleChanges(): Promise<void> {
    const since = new Date(this.now().getTime() - LIFECYCLE_LOOKBACK_MS);
    for (const ch of await this.d.history.lifecycleChangesSince(since)) {
      await this.process({
        dedupKey: `lifecycle:${ch.id}:${ch.lifecycle}`,
        kind: 'LIFECYCLE',
        pair: ch.pair,
        signalId: ch.id,
        template: `lifecycle_${ch.lifecycle.toLowerCase()}`,
        render: () => lifecycleNotification(ch, this.d.timeZone),
      });
    }
  }

  private async process(c: Candidate): Promise<DispatchResult> {
    const now = this.now();
    const s = await this.d.settings();
    const ctx: RuleContext = { now, timeZone: this.d.timeZone, activeHours: s.activeHours, paused: !s.scanningEnabled };
    let ew: EarlyWarningFacts | undefined;
    if (c.kind === 'EARLY_WARNING' && c.pair) {
      ew = {
        unchanged: c.ew?.unchanged ?? false,
        lastSentAt: await this.d.repo.lastSentAt('EARLY_WARNING', c.pair),
        sentToday: await this.d.repo.countSentSince('EARLY_WARNING', startOfDayInZone(now, this.d.timeZone)),
      };
    }
    const decision = decide(c.kind, ctx, this.d.config, { ew, advice: c.advice });
    if (!decision.send) {
      await this.d.repo.recordSuppressed(c, decision.reason, now);
      return `suppressed:${decision.reason}`;
    }
    if ((await this.d.repo.claim(c, now)) === 'duplicate') return 'duplicate';

    const text = c.render();
    const textHash = hash(text);
    // The send itself runs on the sender's queue; the scheduler is never blocked by Telegram.
    const send = this.d
      .send(text)
      .then(async (r) => {
        if (r.ok) {
          await this.d.repo.markSent(c.dedupKey, { now: this.now(), telegramMessageId: r.messageId, textHash, attempts: r.attempts });
          await this.d.audit.record({ action: 'notification.sent', details: { kind: c.kind, pair: c.pair ?? null, signalId: c.signalId ?? null, dedupKey: c.dedupKey, attempts: r.attempts } });
        } else {
          await this.d.repo.markFailed(c.dedupKey, { error: r.error, attempts: r.attempts, textHash });
          await this.d.audit.record({ action: 'notification.failed', details: { kind: c.kind, pair: c.pair ?? null, dedupKey: c.dedupKey, error: r.error, attempts: r.attempts } });
          this.d.logger.error({ kind: c.kind, dedupKey: c.dedupKey, err: r.error }, 'Notifikasi gagal dikirim (tidak dikirim ulang)');
        }
      })
      .catch((error: unknown) => this.d.logger.error({ err: error instanceof Error ? error.message : error, dedupKey: c.dedupKey }, 'Gagal mencatat hasil pengiriman'));
    this.sends.push(send);
    void send.finally(() => (this.sends = this.sends.filter((p) => p !== send)));
    return 'queued';
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

export type { NotificationKind };
