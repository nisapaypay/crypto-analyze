import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { createLogger } from '../../src/app/logger/logger.js';
import { summaryNotification, type SummaryView } from '../../src/bot/messages/notifications.js';
import { InMemoryNotificationRepository } from '../../src/notify/notification-repository.js';
import { Notifier, type Candidate } from '../../src/notify/notifier.js';
import { NOTIFY_DEFAULTS } from '../../src/notify/rules.js';
import { SummaryScheduler } from '../../src/notify/summary.js';
import { SystemAlerts } from '../../src/notify/system-alerts.js';
import { TelegramSender } from '../../src/notify/telegram-sender.js';
import { ClockGuard } from '../../src/scheduler/clock-guard.js';
import { JobRunner } from '../../src/scheduler/job-runner.js';
import { InMemorySchedulerRepository } from '../../src/scheduler/scheduler-repository.js';
import { riskState } from '../helpers/strategy.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';

const wib = (hhmm: string, day = '2026-11-03') => new Date(`${day}T${hhmm}:00+07:00`);
const logger = createLogger({ level: 'silent' });

const view = (at: Date): SummaryView => ({
  at,
  label: 'PAGI',
  timeZone: 'Asia/Jakarta',
  pairs: [
    { pair: 'xrp_idr', decision: 'EARLY_WARNING', decidedAt: wib('09:01'), regime: 'SIDEWAYS', price: new Dec('41250'), spreadPct: new Dec('0.0308'), quality: 'OK', snapshotAt: wib('09:01') },
    { pair: 'qnt_idr', decision: null, decidedAt: null, regime: null, price: null, spreadPct: null, quality: null, snapshotAt: null },
  ],
  risk: riskState(),
  settings: defaultStrategySettings(),
  openBuys: [],
  sentToday: { EARLY_WARNING: 1 },
  suppressed: [{ kind: 'LIFECYCLE', pair: 'doge_idr', signalId: 9, reason: 'OUTSIDE_ACTIVE_HOURS', at: wib('22:16', '2026-11-02') }],
  gaps: [{ pair: 'xrp_idr', kind: 'snapshot', minutes: 60, cause: 'OFFLINE' }],
  scheduler: { consecutiveFailures: 0, clock: 'VALID', serverTimeTrusted: true },
});

describe('market summary', () => {
  it('is deterministic text from stored data, including what was held overnight and data gaps', () => {
    const text = summaryNotification(view(wib('09:05')));
    expect(text).toContain('RINGKASAN PASAR PAGI — 03 Nov 2026 — 09:05 WIB');
    expect(text).toContain('XRP/IDR — 🟡 EARLY WARNING (SIDEWAYS) · 09:01 WIB');
    expect(text).toContain('Rp41.250 · spread 0,03%');
    expect(text).toContain('QNT/IDR — belum ada scan strategi terbaru');
    expect(text).toContain('LIFECYCLE #9 DOGE/IDR — OUTSIDE_ACTIVE_HOURS');
    expect(text).toContain('xrp/idr'.toUpperCase());
    expect(text).toContain('snapshot 60 menit — OFFLINE');
    expect(text).toContain('Sistem: ✅ normal');
  });

  function sched(opts: { now: Date; paused?: boolean; clockValid?: boolean }) {
    let now = opts.now;
    const repo = new InMemorySchedulerRepository();
    const clock = new ClockGuard({ maxSkewMs: 30_000, validChecks: 2 });
    if (opts.clockValid !== false) for (let i = 0; i < 2; i++) clock.observe({ serverTime: now, cacheAgeSec: 0, fetchedAt: now });
    const dispatched: Candidate[] = [];
    const s = new SummaryScheduler({
      times: ['09:05', '21:30'],
      repo,
      runner: new JobRunner(repo, logger, { watchdogMs: 5_000, now: () => now }),
      clock,
      settings: async () => ({ scanningEnabled: !opts.paused, intervalMinutes: 15, activeHours: { start: '09:00', end: '22:00' } }),
      build: async (at) => view(at),
      dispatch: async (c) => (dispatched.push(c), 'queued'),
      isLockHeld: () => true,
      logger,
      timeZone: 'Asia/Jakarta',
      graceMs: 30 * 60_000,
      now: () => now,
    });
    return { s, repo, dispatched, setNow: (d: Date) => (now = d) };
  }

  it('runs once per occurrence (09:05 and 21:30), never twice', async () => {
    const h = sched({ now: wib('09:05') });
    await h.s.runAt(wib('09:05'), '09:05');
    await h.s.runAt(wib('09:05'), '09:05');
    expect(h.dispatched.map((c) => c.dedupKey)).toEqual([`summary:${wib('09:05').toISOString()}`]);
    expect(h.repo.runs.map((r) => `${r.kind}:${r.status}`)).toEqual(['SUMMARY:COMPLETED']);
  });

  it('/pause stops summaries (SKIPPED PAUSED); a wrong clock too (SKIPPED CLOCK_SKEW)', async () => {
    const p = sched({ now: wib('09:05'), paused: true });
    await p.s.runAt(wib('09:05'), '09:05');
    expect(p.dispatched).toEqual([]);
    expect(p.repo.runs.map((r) => `${r.status}:${r.cause}`)).toEqual(['SKIPPED:PAUSED']);
    const c = sched({ now: wib('09:05'), clockValid: false });
    await c.s.runAt(wib('09:05'), '09:05');
    expect(c.repo.runs.map((r) => `${r.status}:${r.cause}`)).toEqual(['SKIPPED:CLOCK_SKEW']);
  });

  it('after a restart: within 30 min it still runs; later it is recorded MISSED (OFFLINE)', async () => {
    const late = sched({ now: wib('09:20') });
    await late.s.catchUp();
    expect(late.dispatched.map((c) => c.template)).toEqual(['summary_pagi']);
    const missed = sched({ now: wib('10:00') });
    await missed.s.catchUp();
    expect(missed.dispatched).toEqual([]);
    expect(missed.repo.runs.filter((r) => r.status === 'MISSED').map((r) => r.slotAt)).toEqual(expect.arrayContaining([wib('09:05'), wib('21:30', '2026-11-02')]));
  });
});

describe('system alerts (one per incident)', () => {
  it('failures, clock and server time: one alert, one recovery message', async () => {
    const sent: string[] = [];
    const a = new SystemAlerts(async (c) => (sent.push(c.dedupKey.split(':')[1]!), 'queued'), { failuresThreshold: 3, serverTimeDebounceMs: 15 * 60_000, timeZone: 'Asia/Jakarta' });
    const base = { consecutiveFailures: 0, lastCause: null, clock: 'VALID' as const, skewMs: 0, serverTimeTrusted: true, serverTimeReason: null };
    await a.observe({ ...base, consecutiveFailures: 3, lastCause: 'API_ERROR' }, wib('10:00'));
    await a.observe({ ...base, consecutiveFailures: 4 }, wib('10:15'));
    await a.observe(base, wib('10:30'));
    await a.observe({ ...base, clock: 'INVALID', skewMs: 45_000 }, wib('11:00'));
    await a.observe({ ...base, clock: 'INVALID', skewMs: 45_000 }, wib('11:01'));
    await a.observe(base, wib('11:05'));
    await a.observe({ ...base, serverTimeTrusted: false, serverTimeReason: 'setelah sleep' }, wib('12:00'));
    await a.observe({ ...base, serverTimeTrusted: true }, wib('12:02')); // re-established quickly: no alert
    await a.observe({ ...base, serverTimeTrusted: false, serverTimeReason: 'x' }, wib('13:00'));
    await a.observe({ ...base, serverTimeTrusted: false, serverTimeReason: 'x' }, wib('13:16'));
    await a.observe(base, wib('13:20'));
    expect(sent).toEqual(['failures', 'failures-recovered', 'clock', 'clock-valid', 'server-time', 'server-time-trusted']);
  });

  it('restart notice only when slots were missed', () => {
    const a = new SystemAlerts(async () => 'queued', { failuresThreshold: 3, serverTimeDebounceMs: 0, timeZone: 'Asia/Jakarta' });
    expect(a.restarted('i1', 0, null, wib('10:00'))).toBeNull();
    expect(a.restarted('i1', 4, wib('09:00'), wib('10:00'))).not.toBeNull();
  });
});

describe('end to end: notifier → real Telegram client with a 429', () => {
  it('429 is waited out and the message is delivered once, recorded SENT with 2 attempts', async () => {
    const bot = new Bot('123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr', { botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'b_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as UserFromGetMe });
    let calls = 0;
    bot.api.config.use(async () => {
      calls++;
      return (calls === 1
        ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }
        : { ok: true, result: { message_id: 555, date: 0, chat: { id: 1, type: 'private' } } }) as never;
    });
    const sleep = vi.fn(async () => undefined);
    const sender = new TelegramSender(bot.api, 111, { retries429: 2, maxRetryAfterMs: 60_000, minIntervalMs: 0, sleep });
    const repo = new InMemoryNotificationRepository();
    const notifier = new Notifier({
      repo,
      send: (t) => sender.send(t),
      history: { previousDecision: async () => null, lifecycleChangesSince: async () => [] },
      settings: async () => ({ scanningEnabled: true, activeHours: { start: '09:00', end: '22:00' } }),
      audit: { record: async () => undefined },
      logger,
      timeZone: 'Asia/Jakarta',
      config: NOTIFY_DEFAULTS,
      now: () => wib('03:00'),
    });
    expect(await notifier.dispatch({ dedupKey: 'system:test', kind: 'SYSTEM', template: 'system_test', render: () => 'tes' })).toBe('queued');
    expect(await notifier.dispatch({ dedupKey: 'system:test', kind: 'SYSTEM', template: 'system_test', render: () => 'tes' })).toBe('duplicate');
    await notifier.idle();
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(calls).toBe(2);
    expect(repo.rows).toEqual([expect.objectContaining({ status: 'SENT', messageId: 555, attempts: 2 })]);
  });
});
