import { describe, expect, it, vi } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { createLogger } from '../../src/app/logger/logger.js';
import type { PairMarketData } from '../../src/market/market-data-service.js';
import { InMemoryNotificationRepository } from '../../src/notify/notification-repository.js';
import { Notifier } from '../../src/notify/notifier.js';
import { NOTIFY_DEFAULTS } from '../../src/notify/rules.js';
import type { SendResult } from '../../src/notify/telegram-sender.js';
import type { LifecycleChange, PreviousDecision, SignalHistory } from '../../src/notify/transitions.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import type { ScanResult } from '../../src/strategy/strategy-service.js';
import type { StrategyDecision } from '../../src/strategy/types.js';
import { engineInput, riskState } from '../helpers/strategy.js';

const wib = (hhmm: string, day = '2026-11-03') => new Date(`${day}T${hhmm}:00+07:00`);
const logger = createLogger({ level: 'silent' });

const BUY = evaluateStrategy(engineInput());
const EW = evaluateStrategy(engineInput({ scenario: { volumeNotes: ['7 dari 20 candle tanpa transaksi'] } }));
const WAIT = evaluateStrategy(engineInput({ scenario: { rsi: 100 } }));

function result(d: StrategyDecision, o: { pair?: string; candle?: Date; signalId?: number | null; existingBuyId?: number | null; ewSignals?: string[]; at?: Date } = {}) {
  const pair = o.pair ?? d.pair;
  const decision: StrategyDecision = {
    ...d,
    pair,
    candleOpenTime: o.candle ?? d.candleOpenTime,
    evaluatedAt: o.at ?? d.evaluatedAt,
    earlyWarningSignals: o.ewSignals ?? d.earlyWarningSignals,
  };
  const market = { pair, fetchedAt: decision.evaluatedAt, ticker: { last: new Dec('3580000'), serverTime: new Date(decision.evaluatedAt.getTime() - 20_000) } } as unknown as PairMarketData;
  return { market, analysis: {} as never, decision, signalId: o.signalId === undefined ? 1 : o.signalId, existingBuyId: o.existingBuyId ?? null };
}
const scan = (...results: ReturnType<typeof result>[]): ScanResult => ({ evaluatedAt: results[0]!.decision.evaluatedAt, results, best: null, risk: riskState(), settings: defaultStrategySettings() });

class FakeHistory implements SignalHistory {
  prev = new Map<string, PreviousDecision>();
  changes: LifecycleChange[] = [];
  async previousDecision(pair: string) {
    return this.prev.get(pair) ?? null;
  }
  async lifecycleChangesSince() {
    return this.changes;
  }
}

function setup(opts: { now: Date; paused?: boolean; send?: (text: string) => Promise<SendResult> }) {
  let now = opts.now;
  const repo = new InMemoryNotificationRepository();
  const history = new FakeHistory();
  const sent: string[] = [];
  let id = 100;
  const send = vi.fn(opts.send ?? (async (text: string): Promise<SendResult> => (sent.push(text), { ok: true, messageId: ++id, attempts: 1 })));
  const audit: string[] = [];
  const notifier = new Notifier({
    repo,
    send,
    history,
    settings: async () => ({ scanningEnabled: !opts.paused, activeHours: { start: '09:00', end: '22:00' } }),
    audit: { record: async (e) => void audit.push(e.action) },
    logger,
    timeZone: 'Asia/Jakarta',
    config: NOTIFY_DEFAULTS,
    now: () => now,
  });
  const run = async (s: ScanResult) => {
    await notifier.afterStrategyScan(s);
    await notifier.idle();
  };
  return { notifier, repo, history, send, sent, audit, run, setNow: (d: Date) => (now = d) };
}
const statuses = (repo: InMemoryNotificationRepository) => repo.rows.map((r) => `${r.kind}:${r.status}${r.reason ? `:${r.reason}` : ''}`);

describe('BUY_CANDIDATE', () => {
  it('is sent exactly once per signal, with deterministic plan numbers, even if processed repeatedly', async () => {
    const h = setup({ now: wib('11:17') });
    const s = scan(result(BUY, { signalId: 42 }));
    await h.run(s);
    await h.run(s);
    await Promise.all([h.notifier.afterStrategyScan(s), h.notifier.afterStrategyScan(s)]);
    await h.notifier.idle();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(statuses(h.repo)).toEqual(['BUY_CANDIDATE:SENT']);
    const text = h.sent[0]!;
    expect(text).toContain('REKOMENDASI BELI #42');
    expect(text).toContain('Entry (limit buy): Rp3.572.500 – Rp3.580.000');
    expect(text).toContain('Stop loss: Rp3.532.500');
    expect(text).toContain('Take profit: Rp3.722.500');
    expect(text).toContain('Eksekusi manual');
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(h.audit).toEqual(['notification.sent']);
  });

  it('a BUY already issued earlier for that candle (existingBuyId) is not notified again', async () => {
    const h = setup({ now: wib('11:17') });
    await h.run(scan(result(BUY, { signalId: 42, existingBuyId: 42 })));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.repo.rows).toEqual([]);
  });

  it('outside active hours it is held and recorded with the reason', async () => {
    const h = setup({ now: wib('22:05') });
    await h.run(scan(result(BUY, { signalId: 43 })));
    expect(h.send).not.toHaveBeenCalled();
    expect(statuses(h.repo)).toEqual(['BUY_CANDIDATE:SUPPRESSED:OUTSIDE_ACTIVE_HOURS']);
  });
});

describe('no WAIT notifications', () => {
  it('WAIT / NO_TRADE / DATA_UNAVAILABLE never create a notification or a record', async () => {
    const h = setup({ now: wib('11:17') });
    expect(WAIT.decision).toBe('WAIT');
    const noTrade = { ...WAIT, decision: 'NO_TRADE' as const };
    const unavailable = { ...WAIT, decision: 'DATA_UNAVAILABLE' as const };
    await h.run(scan(result(WAIT, { pair: 'a_idr' }), result(noTrade, { pair: 'b_idr' }), result(unavailable, { pair: 'c_idr' })));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.repo.rows).toEqual([]);
  });
});

describe('EARLY_WARNING', () => {
  const c = (hhmm: string) => new Date(wib(hhmm).getTime() - 16.5 * 60_000); // candle open for a slot at hh:mm(+1:30)

  it('first EW sent; same signals on the next candle → NO_CHANGE; changed within 60 min → COOLDOWN; after 60 min → sent', async () => {
    expect(EW.decision).toBe('EARLY_WARNING');
    const h = setup({ now: wib('10:02') });
    await h.run(scan(result(EW, { pair: 'xrp_idr', candle: c('10:02'), ewSignals: ['a'], at: wib('10:02') })));
    h.history.prev.set('xrp_idr', { decision: 'EARLY_WARNING', candleOpenTime: c('10:02'), earlyWarning: ['a'] });
    h.setNow(wib('10:17'));
    await h.run(scan(result(EW, { pair: 'xrp_idr', candle: c('10:17'), ewSignals: ['a'], at: wib('10:17') })));
    h.history.prev.set('xrp_idr', { decision: 'EARLY_WARNING', candleOpenTime: c('10:17'), earlyWarning: ['a'] });
    h.setNow(wib('10:32'));
    await h.run(scan(result(EW, { pair: 'xrp_idr', candle: c('10:32'), ewSignals: ['a', 'b'], at: wib('10:32') })));
    h.history.prev.set('xrp_idr', { decision: 'WAIT', candleOpenTime: c('10:32'), earlyWarning: [] });
    h.setNow(wib('11:03'));
    await h.run(scan(result(EW, { pair: 'xrp_idr', candle: c('11:03'), ewSignals: ['a'], at: wib('11:03') })));
    expect(statuses(h.repo)).toEqual(['EARLY_WARNING:SENT', 'EARLY_WARNING:SUPPRESSED:NO_CHANGE', 'EARLY_WARNING:SUPPRESSED:COOLDOWN_60M', 'EARLY_WARNING:SENT']);
    expect(h.sent[0]).toContain('BUKAN sinyal beli');
    expect(h.sent[0]).not.toMatch(/Entry \(limit buy\)|Stop loss:|Take profit:/);
  });

  it('at most 6 EARLY_WARNING per day (all pairs); the 7th is held as DAILY_LIMIT', async () => {
    const h = setup({ now: wib('10:02') });
    for (let i = 0; i < 7; i++) await h.run(scan(result(EW, { pair: `p${i}_idr`, candle: c('10:02'), at: wib('10:02') })));
    expect(h.send).toHaveBeenCalledTimes(6);
    expect(statuses(h.repo).at(-1)).toBe('EARLY_WARNING:SUPPRESSED:DAILY_LIMIT');
  });

  it('/pause holds EARLY_WARNING with reason PAUSED', async () => {
    const h = setup({ now: wib('10:02'), paused: true });
    await h.run(scan(result(EW, { pair: 'xrp_idr', candle: c('10:02') })));
    expect(statuses(h.repo)).toEqual(['EARLY_WARNING:SUPPRESSED:PAUSED']);
  });
});

describe('lifecycle', () => {
  it('each transition is sent once; hypothetical results are labelled as such', async () => {
    const h = setup({ now: wib('11:17') });
    h.history.changes = [
      { id: 7, pair: 'xrp_idr', lifecycle: 'EXPIRED_UNFILLED', lifecycleAt: wib('11:00'), createdAt: wib('10:31'), expiresAt: wib('11:00'), hypo: null },
      { id: 8, pair: 'doge_idr', lifecycle: 'HYPO_CLOSED', lifecycleAt: wib('11:15'), createdAt: wib('09:31'), expiresAt: wib('10:00'), hypo: { exitReason: 'sl', netPnl: '-24877.31', entryFill: '2500', exitPrice: '2440' } },
    ];
    const empty = scan(result(WAIT));
    await h.run(empty);
    await h.run(empty);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.sent[0]).toContain('KEDALUWARSA');
    expect(h.sent[1]).toContain('Hasil bersih hipotetis: −Rp24.877,31');
    expect(h.sent[1]).toContain('bukan P/L Anda');
    // A further transition of the same signal is a new notification.
    h.history.changes.push({ id: 7, pair: 'xrp_idr', lifecycle: 'POSSIBLY_FILLED', lifecycleAt: wib('11:16'), createdAt: wib('10:31'), expiresAt: wib('11:00'), hypo: null });
    await h.run(empty);
    expect(h.send).toHaveBeenCalledTimes(3);
  });
});

describe('delivery failures, crash recovery, non-blocking', () => {
  it('a failed send is recorded FAILED with the error and never re-sent (no duplicates)', async () => {
    const h = setup({ now: wib('11:17'), send: async () => ({ ok: false, error: 'Telegram 403: Forbidden', attempts: 1, rateLimited: false }) });
    const s = scan(result(BUY, { signalId: 50 }));
    await h.run(s);
    await h.run(s);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.repo.rows[0]).toMatchObject({ status: 'FAILED', error: 'Telegram 403: Forbidden' });
    expect(h.audit).toEqual(['notification.failed']);
  });

  it('a PENDING row left by a crash becomes FAILED (UNKNOWN_DELIVERY) and is not sent again', async () => {
    const h = setup({ now: wib('11:30') });
    await h.repo.claim({ dedupKey: 'buy:60', kind: 'BUY_CANDIDATE', pair: 'xrp_idr', signalId: 60, template: 'buy' }, wib('11:17'));
    expect(await h.notifier.recoverPending(NOTIFY_DEFAULTS.stalePendingMs)).toBe(1);
    await h.run(scan(result(BUY, { signalId: 60 })));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.repo.rows[0]).toMatchObject({ status: 'FAILED', error: 'UNKNOWN_DELIVERY' });
  });

  it('the scheduler never waits for Telegram: processing finishes while the send is still pending', async () => {
    let release!: () => void;
    const h = setup({ now: wib('11:17'), send: () => new Promise((r) => (release = () => r({ ok: true, messageId: 1, attempts: 1 }))) });
    await h.notifier.afterStrategyScan(scan(result(BUY, { signalId: 70 }))); // resolves although Telegram has not answered
    expect(h.repo.rows[0]).toMatchObject({ status: 'PENDING' });
    release();
    await h.notifier.idle();
    expect(h.repo.rows[0]).toMatchObject({ status: 'SENT' });
  });
});
