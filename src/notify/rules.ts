import { withinActiveHours } from '../app/time.js';

export type NotificationKind =
  /** New BUY recommendation (once per signal). */
  | 'BUY_CANDIDATE'
  /** Heads-up, never a BUY (cooldown + daily cap). */
  | 'EARLY_WARNING'
  /** Market-observed lifecycle change of a BUY (once per transition). */
  | 'LIFECYCLE'
  /** Protective "do not enter" advice for an ACTIVE BUY (once per reason; Milestone 5D source). */
  | 'ADVICE_DO_NOT_ENTER'
  | 'MARKET_SUMMARY'
  /** Operational: failures, clock, restart. Not a trading notification. */
  | 'SYSTEM';

/** Kinds that may only be sent inside active hours (ADVICE has its own exception). */
export const TRADING_KINDS: ReadonlySet<NotificationKind> = new Set(['BUY_CANDIDATE', 'EARLY_WARNING', 'LIFECYCLE', 'MARKET_SUMMARY', 'ADVICE_DO_NOT_ENTER']);

export type SuppressReason =
  | 'OUTSIDE_ACTIVE_HOURS'
  | 'PAUSED'
  | 'NO_CHANGE'
  | 'COOLDOWN_60M'
  | 'DAILY_LIMIT'
  | 'NOT_ACTIVE_ANYMORE';

export type RuleDecision = { send: true } | { send: false; reason: SuppressReason };

export interface RuleContext {
  now: Date;
  timeZone: string;
  activeHours: { start: string; end: string };
  /** /pause: strategy scans, monitor and summaries are stopped. */
  paused: boolean;
}

export interface EarlyWarningFacts {
  /** The previous candle of this pair was also EARLY_WARNING with the same signals. */
  unchanged: boolean;
  lastSentAt: Date | null;
  sentToday: number;
}

export interface AdviceFacts {
  signalIssuedAt: Date;
  signalExpiresAt: Date;
  lifecycle: string;
}

export interface RuleConfig {
  earlyWarningCooldownMs: number;
  earlyWarningDailyMax: number;
}

export const NOTIFY_DEFAULTS: RuleConfig & { telegramMaxRetryAfterMs: number; telegram429Retries: number; minSendIntervalMs: number; stalePendingMs: number } = {
  earlyWarningCooldownMs: 60 * 60_000,
  earlyWarningDailyMax: 6,
  /** A 429 asking to wait longer than this is not retried (the message is marked FAILED). */
  telegramMaxRetryAfterMs: 60_000,
  telegram429Retries: 2,
  /** Telegram allows about one message per second per chat. */
  minSendIntervalMs: 1_100,
  /** PENDING rows older than this at startup were interrupted mid-send: never re-sent. */
  stalePendingMs: 2 * 60_000,
};

/**
 * Pure notification policy (deduplication itself is the unique key in the
 * notifications table). Order: active hours (with the protective exception),
 * pause, then the EARLY_WARNING change/cooldown/daily-cap rules.
 */
export function decide(kind: NotificationKind, ctx: RuleContext, cfg: RuleConfig, facts: { ew?: EarlyWarningFacts; advice?: AdviceFacts } = {}): RuleDecision {
  const active = withinActiveHours(ctx.now, ctx.timeZone, ctx.activeHours.start, ctx.activeHours.end);

  if (kind === 'ADVICE_DO_NOT_ENTER') {
    const a = facts.advice;
    if (!a || a.lifecycle !== 'ACTIVE' || a.signalExpiresAt <= ctx.now) return { send: false, reason: 'NOT_ACTIVE_ANYMORE' };
    // Protective exception: after 22:00 only for a BUY issued inside active hours that is still valid.
    if (!active && !withinActiveHours(a.signalIssuedAt, ctx.timeZone, ctx.activeHours.start, ctx.activeHours.end)) {
      return { send: false, reason: 'OUTSIDE_ACTIVE_HOURS' };
    }
    return { send: true };
  }

  if (TRADING_KINDS.has(kind) && !active) return { send: false, reason: 'OUTSIDE_ACTIVE_HOURS' };
  if (ctx.paused && (kind === 'BUY_CANDIDATE' || kind === 'EARLY_WARNING' || kind === 'MARKET_SUMMARY')) return { send: false, reason: 'PAUSED' };

  if (kind === 'EARLY_WARNING') {
    const e = facts.ew ?? { unchanged: false, lastSentAt: null, sentToday: 0 };
    if (e.unchanged) return { send: false, reason: 'NO_CHANGE' };
    if (e.lastSentAt && ctx.now.getTime() - e.lastSentAt.getTime() < cfg.earlyWarningCooldownMs) return { send: false, reason: 'COOLDOWN_60M' };
    if (e.sentToday >= cfg.earlyWarningDailyMax) return { send: false, reason: 'DAILY_LIMIT' };
  }
  return { send: true };
}
