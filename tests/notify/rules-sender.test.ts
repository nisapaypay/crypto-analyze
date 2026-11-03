import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { adviceNotification, systemNotification } from '../../src/bot/messages/notifications.js';
import { decide, NOTIFY_DEFAULTS, type RuleContext } from '../../src/notify/rules.js';
import { TelegramSender } from '../../src/notify/telegram-sender.js';

const wib = (hhmm: string, day = '2026-11-03') => new Date(`${day}T${hhmm}:00+07:00`);
const ctx = (hhmm: string, paused = false): RuleContext => ({ now: wib(hhmm), timeZone: 'Asia/Jakarta', activeHours: { start: '09:00', end: '22:00' }, paused });
const cfg = NOTIFY_DEFAULTS;

describe('rules: active hours', () => {
  it('trading notifications only 09:00–22:00 WIB', () => {
    for (const kind of ['BUY_CANDIDATE', 'EARLY_WARNING', 'LIFECYCLE', 'MARKET_SUMMARY'] as const) {
      expect(decide(kind, ctx('08:59'), cfg)).toEqual({ send: false, reason: 'OUTSIDE_ACTIVE_HOURS' });
      expect(decide(kind, ctx('09:00'), cfg)).toEqual({ send: true });
      expect(decide(kind, ctx('21:59'), cfg)).toEqual({ send: true });
      expect(decide(kind, ctx('22:00'), cfg)).toEqual({ send: false, reason: 'OUTSIDE_ACTIVE_HOURS' });
      expect(decide(kind, ctx('03:00'), cfg)).toEqual({ send: false, reason: 'OUTSIDE_ACTIVE_HOURS' });
    }
  });

  it('SYSTEM (operational) messages are not trading notifications and may be sent 24/7', () => {
    expect(decide('SYSTEM', ctx('03:00'), cfg)).toEqual({ send: true });
    expect(decide('SYSTEM', ctx('03:00', true), cfg)).toEqual({ send: true });
  });

  it('protective advice after 22:00 only for a BUY issued in active hours that is still ACTIVE and valid', () => {
    const issued = { signalIssuedAt: wib('21:46'), signalExpiresAt: wib('22:15'), lifecycle: 'ACTIVE' };
    expect(decide('ADVICE_DO_NOT_ENTER', ctx('22:05'), cfg, { advice: issued })).toEqual({ send: true });
    expect(decide('ADVICE_DO_NOT_ENTER', ctx('22:15'), cfg, { advice: issued })).toEqual({ send: false, reason: 'NOT_ACTIVE_ANYMORE' });
    expect(decide('ADVICE_DO_NOT_ENTER', ctx('22:05'), cfg, { advice: { ...issued, lifecycle: 'POSSIBLY_FILLED' } })).toEqual({ send: false, reason: 'NOT_ACTIVE_ANYMORE' });
    expect(decide('ADVICE_DO_NOT_ENTER', ctx('22:05'), cfg, { advice: { ...issued, signalIssuedAt: wib('22:01') } })).toEqual({ send: false, reason: 'OUTSIDE_ACTIVE_HOURS' });
    expect(decide('ADVICE_DO_NOT_ENTER', ctx('22:05'), cfg)).toEqual({ send: false, reason: 'NOT_ACTIVE_ANYMORE' });
  });

  it('/pause holds BUY, EARLY_WARNING and summaries', () => {
    expect(decide('BUY_CANDIDATE', ctx('10:00', true), cfg)).toEqual({ send: false, reason: 'PAUSED' });
    expect(decide('EARLY_WARNING', ctx('10:00', true), cfg)).toEqual({ send: false, reason: 'PAUSED' });
    expect(decide('MARKET_SUMMARY', ctx('10:00', true), cfg)).toEqual({ send: false, reason: 'PAUSED' });
  });
});

describe('rules: EARLY_WARNING', () => {
  const ew = (o: { unchanged?: boolean; lastSentAt?: Date | null; sentToday?: number }) => ({ ew: { unchanged: false, lastSentAt: null, sentToday: 0, ...o } });
  it('no change → held; 60-minute cooldown per pair; at most 6 per day', () => {
    expect(decide('EARLY_WARNING', ctx('10:00'), cfg, ew({ unchanged: true }))).toEqual({ send: false, reason: 'NO_CHANGE' });
    expect(decide('EARLY_WARNING', ctx('10:00'), cfg, ew({ lastSentAt: wib('09:01') }))).toEqual({ send: false, reason: 'COOLDOWN_60M' });
    expect(decide('EARLY_WARNING', ctx('10:01'), cfg, ew({ lastSentAt: wib('09:01') }))).toEqual({ send: true });
    expect(decide('EARLY_WARNING', ctx('10:00'), cfg, ew({ sentToday: 5 }))).toEqual({ send: true });
    expect(decide('EARLY_WARNING', ctx('10:00'), cfg, ew({ sentToday: 6 }))).toEqual({ send: false, reason: 'DAILY_LIMIT' });
  });
});

describe('templates that must not open a trade', () => {
  it('protective advice has no price, entry, SL, TP or size', () => {
    const text = adviceNotification({ signalId: 12, pair: 'xrp_idr', reason: 'CHASE_LIMIT_EXCEEDED', at: wib('22:05') }, 'Asia/Jakarta');
    expect(text).toContain('JANGAN ENTRY');
    expect(text).toContain('bukan peluang baru');
    expect(text).not.toMatch(/Rp\d|entry \(|stop loss:|take profit:|jumlah:/i);
  });

  it('system messages', () => {
    expect(systemNotification({ type: 'CLOCK_INVALID', skewMs: 45_000 }, wib('10:00'), 'Asia/Jakarta')).toContain('Keputusan trading DIHENTIKAN');
    expect(systemNotification({ type: 'RESTARTED', missedSlots: 4, since: wib('15:31') }, wib('16:28'), 'Asia/Jakarta')).toContain('4 slot terlewat');
  });
});

// ---- Telegram sender with the real grammY client and simulated API responses ----
const botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as UserFromGetMe;

function telegram(responses: (() => unknown)[]) {
  const bot = new Bot('123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr', { botInfo });
  const calls: string[] = [];
  let i = 0;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push(`${method}:${(payload as { text?: string }).text ?? ''}`);
    const r = responses[Math.min(i++, responses.length - 1)]!();
    if (r instanceof Error) throw r;
    return r as never;
  });
  return { api: bot.api, calls };
}
const ok = (id: number) => () => ({ ok: true, result: { message_id: id, date: 0, chat: { id: 1, type: 'private' } } });
const tooMany = (retryAfter: number) => () => ({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfter}`, parameters: { retry_after: retryAfter } });

describe('Telegram sender', () => {
  it('429: waits retry_after and retries (Telegram did not deliver) — then succeeds once', async () => {
    const t = telegram([tooMany(1), tooMany(2), ok(77)]);
    const sleep = vi.fn(async () => undefined);
    const s = new TelegramSender(t.api, 111, { retries429: 2, maxRetryAfterMs: 60_000, minIntervalMs: 0, sleep });
    expect(await s.send('halo')).toEqual({ ok: true, messageId: 77, attempts: 3 });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(t.calls).toEqual(['sendMessage:halo', 'sendMessage:halo', 'sendMessage:halo']);
  });

  it('429 beyond the retry budget or with a long retry_after → FAILED, rate-limited, no further attempts', async () => {
    const long = telegram([tooMany(120)]);
    const s1 = new TelegramSender(long.api, 111, { retries429: 2, maxRetryAfterMs: 60_000, minIntervalMs: 0, sleep: async () => undefined });
    expect(await s1.send('x')).toMatchObject({ ok: false, rateLimited: true, attempts: 1 });
    expect(long.calls).toHaveLength(1);

    const always = telegram([tooMany(1)]);
    const s2 = new TelegramSender(always.api, 111, { retries429: 2, maxRetryAfterMs: 60_000, minIntervalMs: 0, sleep: async () => undefined });
    expect(await s2.send('x')).toMatchObject({ ok: false, rateLimited: true, attempts: 3 });
  });

  it('other errors (403, network) are NOT retried — the message may already have arrived (no duplicates)', async () => {
    const forbidden = telegram([() => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })]);
    const s = new TelegramSender(forbidden.api, 111, { retries429: 2, maxRetryAfterMs: 60_000, minIntervalMs: 0, sleep: async () => undefined });
    expect(await s.send('x')).toMatchObject({ ok: false, rateLimited: false, attempts: 1, error: expect.stringContaining('403') });
    expect(forbidden.calls).toHaveLength(1);

    const network = telegram([() => new Error('socket hang up')]);
    const s2 = new TelegramSender(network.api, 111, { retries429: 2, maxRetryAfterMs: 60_000, minIntervalMs: 0, sleep: async () => undefined });
    expect(await s2.send('x')).toMatchObject({ ok: false, attempts: 1 });
    expect(network.calls).toHaveLength(1);
  });

  it('messages are sent one at a time, spaced by the minimum interval', async () => {
    const t = telegram([ok(1)]);
    let clock = 0;
    const waits: number[] = [];
    const s = new TelegramSender(t.api, 111, { retries429: 0, maxRetryAfterMs: 0, minIntervalMs: 1_100, now: () => clock, sleep: async (ms) => void (waits.push(ms), (clock += ms)) });
    await Promise.all([s.send('a'), s.send('b'), s.send('c')]);
    expect(t.calls).toEqual(['sendMessage:a', 'sendMessage:b', 'sendMessage:c']);
    expect(waits).toEqual([1_100, 1_100]);
  });
});
