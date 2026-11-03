import type { Update, UserFromGetMe } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../src/app/audit/audit-log.js';
import { createLogger } from '../../src/app/logger/logger.js';
import { createBot, type BotDeps } from '../../src/bot/bot.js';
import { PAUSED_MESSAGE, RESUMED_MESSAGE } from '../../src/bot/commands/scheduler.js';
import { InMemorySchedulerControl } from '../../src/scheduler/scheduler-settings.js';
import { InMemoryIndicatorRepository } from '../../src/analysis/indicator-repository.js';
import { TechnicalAnalysisService } from '../../src/analysis/technical-analysis-service.js';
import { MarketDataService } from '../../src/market/market-data-service.js';
import { InMemoryMarketRepository } from '../../src/market/market-repository.js';
import { PairRegistry } from '../../src/market/pair-registry.js';
import { UnavailableJournalLedger } from '../../src/risk/risk-ledger.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { InMemorySignalRepository } from '../../src/strategy/signal-repository.js';
import { StrategyService } from '../../src/strategy/strategy-service.js';
import type { AddResult, WatchlistEntry, WatchlistRepository } from '../../src/watchlist/watchlist-repository.js';
import { FakeMarketClient, makePair, NOW } from '../helpers/market.js';

const OWNER_ID = 111;
const STRANGER_ID = 222;

const botInfo = {
  id: 42,
  is_bot: true,
  first_name: 'Crypto Analyst',
  username: 'crypto_analyst_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

let updateId = 0;

function messageUpdate(
  text: string,
  fromId = OWNER_ID,
  chatType: 'private' | 'group' = 'private',
  replyTo?: { fromId: number; text: string },
): Update {
  const command = text.startsWith('/') ? text.split(' ')[0]! : undefined;
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: chatType === 'private'
        ? { id: fromId, type: 'private', first_name: 'User' }
        : { id: -100123, type: 'group', title: 'Group' },
      from: { id: fromId, is_bot: false, first_name: 'User' },
      text,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
      ...(replyTo
        ? {
            reply_to_message: {
              message_id: 1,
              date: 0,
              chat: { id: fromId, type: 'private', first_name: 'User' },
              from: { id: replyTo.fromId, is_bot: true, first_name: 'Bot' },
              text: replyTo.text,
            },
          }
        : {}),
    },
  } as Update;
}

class FakeWatchlist implements WatchlistRepository {
  constructor(public entries: WatchlistEntry[]) {}
  async listForTelegramUser() {
    return this.entries;
  }
  async add(_user: number, pair: string, max: number): Promise<AddResult> {
    const existing = this.entries.find((e) => e.pair === pair);
    if (existing?.enabled) return 'exists';
    if (this.entries.filter((e) => e.enabled).length >= max) return 'limit_reached';
    if (existing) {
      existing.enabled = true;
      return 'reenabled';
    }
    this.entries.push({ pair, enabled: true });
    return 'added';
  }
  async remove(_user: number, pair: string) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.pair !== pair);
    return this.entries.length < before;
  }
}

const exchangePairs = [
  makePair(),
  makePair({ tickerId: 'doge_idr', pathId: 'dogeidr', symbol: 'DOGEIDR', baseAsset: 'doge' }),
  makePair({ tickerId: 'aero_idr', pathId: 'aeroidr', symbol: 'AEROIDR', baseAsset: 'aero', isMaintenance: true }),
  makePair({ tickerId: 'eth_usdt', pathId: 'ethusdt', symbol: 'ETHUSDT', baseAsset: 'eth', quoteAsset: 'usdt' }),
];

function setup(overrides: Partial<BotDeps> = {}) {
  const auditEntries: AuditEntry[] = [];
  const watchlist = new FakeWatchlist([
    { pair: 'qnt_idr', enabled: true },
    { pair: 'doge_idr', enabled: false },
  ]);
  const pairs = new PairRegistry({ getPairs: async () => exchangePairs });
  const marketService = new MarketDataService({
    client: new FakeMarketClient(),
    pairs,
    repository: new InMemoryMarketRepository(),
    logger: createLogger({ level: 'silent' }),
    now: () => NOW,
  });
  const analysisService = new TechnicalAnalysisService({
    market: marketService,
    repository: new InMemoryIndicatorRepository(),
    logger: createLogger({ level: 'silent' }),
    now: () => NOW,
  });
  const analysis = {
    analyze: vi.fn((p: string) => analysisService.analyze(p)),
    analyzeMany: vi.fn((p: string[]) => analysisService.analyzeMany(p)),
  };
  const signals = new InMemorySignalRepository();
  const strategyService = new StrategyService({
    analysis: analysisService,
    market: marketService,
    signals,
    settings: { load: async () => defaultStrategySettings() },
    journal: new UnavailableJournalLedger(),
    logger: createLogger({ level: 'silent' }),
    timeZone: 'Asia/Jakarta',
    now: () => NOW,
  });
  const strategy = {
    scan: vi.fn((p: string[]) => strategyService.scan(p)),
    evaluate: vi.fn((p: string) => strategyService.evaluate(p)),
    riskOverview: vi.fn(() => strategyService.riskOverview()),
  };

  const deps: BotDeps = {
    token: '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr',
    allowedUserId: OWNER_ID,
    timeZone: 'Asia/Jakarta',
    logger: createLogger({ level: 'silent' }),
    audit: { record: async (entry) => void auditEntries.push(entry) },
    health: {
      check: async () => [
        { name: 'Database', ok: true, latencyMs: 3 },
        { name: 'Indodax Public API', ok: false, latencyMs: 1, detail: 'timeout setelah 5000ms' },
      ],
    },
    watchlist,
    watchlistMax: 10,
    pairs,
    analysis,
    strategy,
    ai: { enabled: false, disabledReason: 'ANTHROPIC_API_KEY dan ANTHROPIC_MODEL kosong' },
    clock: () => new Date('2026-11-02T04:30:00Z'),
    botInfo,
    ...overrides,
  };

  const bot = createBot(deps);
  const sent: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });

  const replies = () => sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.payload.text));
  return { bot, replies, auditEntries, watchlist, analysis, strategy, signals };
}

describe('authorization', () => {
  it('ignores messages from other users and audits the attempt', async () => {
    const { bot, replies, auditEntries } = setup();
    await bot.handleUpdate(messageUpdate('/status', STRANGER_ID));
    expect(replies()).toEqual([]);
    expect(auditEntries).toEqual([
      expect.objectContaining({ action: 'telegram.unauthorized', telegramUserId: STRANGER_ID }),
    ]);
  });

  it('does not log the content of unauthorized messages', async () => {
    const { bot, auditEntries } = setup();
    await bot.handleUpdate(messageUpdate('my secret text', STRANGER_ID));
    expect(JSON.stringify(auditEntries)).not.toContain('my secret text');
  });

  it('ignores the owner in group chats', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(messageUpdate('/status', OWNER_ID, 'group'));
    expect(replies()).toEqual([]);
  });

  it('rate limits bursts of commands', async () => {
    const { bot, replies } = setup();
    for (let i = 0; i < 7; i++) {
      await bot.handleUpdate(messageUpdate('/help'));
    }
    const all = replies();
    expect(all.filter((r) => r.startsWith('PERINTAH TERSEDIA'))).toHaveLength(5);
    expect(all).toContain('Terlalu banyak perintah. Tunggu beberapa detik.');
  });
});

describe('commands', () => {
  it('/start explains the analysis-only mode', async () => {
    const { bot, replies, auditEntries } = setup();
    await bot.handleUpdate(messageUpdate('/start'));
    expect(replies()[0]).toContain('dilakukan manual oleh Anda di Indodax');
    expect(auditEntries).toEqual([expect.objectContaining({ action: 'telegram.command', details: { command: 'start' } })]);
  });

  it('/help lists available and upcoming commands', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(messageUpdate('/help'));
    const text = replies()[0]!;
    expect(text).toContain('/status — Status sistem');
    expect(text).toContain('/bought — Catat pembelian manual (M6)');
  });

  it('/status shows component health, AI state and WIB timestamp', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(messageUpdate('/status'));
    const text = replies()[0]!;
    expect(text).toContain('02 Nov 2026 — 11:30 WIB');
    expect(text).toContain('✅ Database: OK (3 ms)');
    expect(text).toContain('❌ Indodax Public API: GAGAL — timeout setelah 5000ms');
    expect(text).toContain('⚪ AI (Claude): nonaktif — ANTHROPIC_API_KEY dan ANTHROPIC_MODEL kosong');
    expect(text).toContain('tidak ada eksekusi order');
  });

  it('/status does not claim AI is working before it is integrated', async () => {
    const { bot, replies } = setup({ ai: { enabled: true } });
    await bot.handleUpdate(messageUpdate('/status'));
    expect(replies()[0]).toContain('⚪ AI (Claude): terkonfigurasi — belum digunakan (Milestone 5)');
  });

  it('upcoming commands reply with their planned milestone', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(messageUpdate('/bought'));
    expect(replies()[0]).toBe('Perintah /bought belum tersedia (direncanakan di Milestone 6).');
  });

  it('/pause and /resume toggle only the scanning flag and are audited (Milestone 5)', async () => {
    const control = new InMemorySchedulerControl({ scanningEnabled: true, intervalMinutes: 15, activeHours: { start: '09:00', end: '22:00' } });
    const { bot, replies, auditEntries } = setup({ schedulerControl: control });
    await bot.handleUpdate(messageUpdate('/pause'));
    expect(control.settings.scanningEnabled).toBe(false);
    expect(replies()[0]).toBe(PAUSED_MESSAGE);
    expect(replies()[0]).toContain('pengumpulan data pasar 24/7');
    await bot.handleUpdate(messageUpdate('/resume'));
    expect(control.settings.scanningEnabled).toBe(true);
    expect(replies()[1]).toBe(RESUMED_MESSAGE);
    expect(auditEntries.map((e) => e.action)).toEqual(expect.arrayContaining(['scheduler.paused', 'scheduler.resumed']));
  });

  it('/status shows the scheduler, clock and request budget (Milestone 5)', async () => {
    const { bot, replies } = setup({
      schedulerStatus: async () => ({
        running: true,
        paused: false,
        lockHeld: true,
        clock: { status: 'INVALID', skewMs: 45_000, checkedAt: null },
        nextSlotAt: new Date('2026-11-02T04:31:30Z'),
        nextSlotKind: 'STRATEGY_SCAN',
        lastRun: { kind: 'STRATEGY_SCAN', status: 'SKIPPED', slotAt: new Date('2026-11-02T04:16:30Z'), cause: 'CLOCK_SKEW' },
        consecutiveFailures: 0,
        breakerOpen: false,
        requests: { lastHour: 87, peakPerMinute: 21, limitPerMinute: 120 },
      }),
    });
    await bot.handleUpdate(messageUpdate('/status'));
    const text = replies()[0]!;
    expect(text).toContain('SCHEDULER');
    expect(text).toContain('Jam: TIDAK VALID — keputusan & penyimpanan data ditahan (selisih 45.0 dtk)');
    expect(text).toContain('Slot berikutnya: 11:31 WIB (scan strategi)');
    expect(text).toContain('SKIPPED (CLOCK_SKEW)');
    expect(text).toContain('Request Indodax: 87/jam · puncak 21/menit (batas 120)');
    expect(text).not.toContain('belum aktif (Milestone 5)');
  });

  it('unknown text gets a help hint', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(messageUpdate('halo'));
    expect(replies()[0]).toContain('/help');
  });
});

describe('/watchlist (Milestone 2)', () => {
  it('shows live market data and the data-quality status per enabled pair', async () => {
    const { bot, replies, analysis } = setup({ clock: () => NOW });
    await bot.handleUpdate(messageUpdate('/watchlist'));
    const text = replies()[0]!;

    expect(analysis.analyzeMany).toHaveBeenCalledWith(['qnt_idr']);
    expect(text).toContain('WATCHLIST — 02 Nov 2026 — 16:20 WIB');
    expect(text).toContain('QNT/IDR — ✅ OK');
    expect(text).toContain('Harga: Rp3.585.298 (data 5 dtk lalu)');
    expect(text).toContain('Bid/Ask: Rp3.585.000 / Rp3.596.000');
    expect(text).toContain('Spread: Rp11.000 (0,31%)');
    expect(text).toContain('Imbalance ±1%: +8,8% | ±2%: +13,4%');
    expect(text).toContain('Candle 15m: 300 final, terakhir 16:00 WIB');
    // Milestone 3 summary: synthetic rising prices → rising EMAs, RSI 100 flagged ⚠
    expect(text).toContain('Indikator: tren 15m naik · 1j naik · RSI 100 ⚠ · vol 1×');
    expect(text).toContain('⚠ = indikator kurang andal · detail: /analyze <koin>');
    expect(text).toContain('DOGE/IDR — nonaktif');
  });

  it('explains why a pair is UNAVAILABLE', async () => {
    const { bot, replies, watchlist } = setup({ clock: () => NOW });
    watchlist.entries = [{ pair: 'aero_idr', enabled: true }];
    await bot.handleUpdate(messageUpdate('/watchlist'));
    expect(replies()[0]).toContain('AERO/IDR — ⛔ UNAVAILABLE');
    expect(replies()[0]).toContain('Alasan: Pair sedang maintenance');
  });

  it('reports database failures instead of crashing', async () => {
    const watchlist = new FakeWatchlist([]);
    watchlist.listForTelegramUser = vi.fn(async () => {
      throw new Error('db down');
    });
    const { bot, replies } = setup({ watchlist });
    await bot.handleUpdate(messageUpdate('/watchlist'));
    expect(replies()[0]).toContain('database tidak tersedia');
  });
});

describe('/addcoin and /removecoin', () => {
  const send = async (text: string, overrides: Partial<BotDeps> = {}) => {
    const ctx = setup(overrides);
    await ctx.bot.handleUpdate(messageUpdate(text));
    return { ...ctx, reply: ctx.replies()[0]! };
  };

  it('adds an active IDR pair and audits it', async () => {
    const { reply, watchlist, auditEntries } = await send('/addcoin DOGE/IDR');
    expect(reply).toBe('DOGE/IDR diaktifkan kembali di watchlist.');
    expect(watchlist.entries).toContainEqual({ pair: 'doge_idr', enabled: true });
    expect(auditEntries).toContainEqual(
      expect.objectContaining({ action: 'watchlist.add', details: { pair: 'doge_idr', result: 'reenabled' } }),
    );
  });

  it('rejects maintenance pairs, unknown pairs, non-IDR pairs and unsafe input', async () => {
    expect((await send('/addcoin aero')).reply).toBe('AERO/IDR sedang maintenance di Indodax, tidak ditambahkan.');
    expect((await send('/addcoin sol')).reply).toBe('Pair SOL tidak ditemukan di Indodax.');
    expect((await send('/addcoin eth_usdt')).reply).toContain('Hanya pair IDR');
    expect((await send('/addcoin ../tapi')).reply).toContain('Nama koin tidak valid');
  });

  it('records the command argument in the audit log', async () => {
    const { auditEntries } = await send('/addcoin SOL/IDR');
    expect(auditEntries[0]).toMatchObject({ action: 'telegram.command', details: { command: 'addcoin', args: 'SOL/IDR' } });
  });

  it('reports duplicates and the watchlist limit', async () => {
    expect((await send('/addcoin qnt')).reply).toBe('QNT/IDR sudah ada di watchlist.');
    expect((await send('/addcoin doge', { watchlistMax: 1 })).reply).toContain('maksimum');
  });

  it('tells the user when Indodax cannot be reached', async () => {
    const pairs = { resolve: vi.fn(async () => Promise.reject(new Error('timeout'))) };
    expect((await send('/addcoin doge', { pairs })).reply).toContain('Gagal menghubungi Indodax');
  });

  it('removes a pair by coin, display or ticker format', async () => {
    for (const input of ['qnt', 'QNT/IDR', 'qnt_idr', 'qntidr']) {
      const { reply, watchlist, auditEntries } = await send(`/removecoin ${input}`);
      expect(reply).toBe('QNT/IDR dihapus dari watchlist.');
      expect(watchlist.entries.map((e) => e.pair)).toEqual(['doge_idr']);
      expect(auditEntries).toContainEqual(expect.objectContaining({ action: 'watchlist.remove', details: { pair: 'qnt_idr' } }));
    }
  });

  it('handles unknown input on remove', async () => {
    expect((await send('/removecoin sol')).reply).toBe('SOL tidak ada di watchlist. Lihat /watchlist.');
  });
});

describe('/addcoin and /removecoin picked from the Telegram menu (no argument)', () => {
  const BOT_ID = 42;

  it('asks for the coin with a force-reply prompt', async () => {
    const { bot } = setup();
    const sent: Record<string, unknown>[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === 'sendMessage') sent.push(payload as Record<string, unknown>);
      return { ok: true, result: true } as never;
    });
    await bot.handleUpdate(messageUpdate('/addcoin'));
    expect(String(sent[0]!.text)).toContain('Koin apa yang ingin ditambahkan ke watchlist?');
    expect(sent[0]!.reply_markup).toEqual({ force_reply: true, input_field_placeholder: 'contoh: SOL' });
  });

  it('adds the coin given in the reply to the prompt', async () => {
    const { bot, replies, watchlist } = setup();
    await bot.handleUpdate(messageUpdate('DOGE', OWNER_ID, 'private', { fromId: BOT_ID, text: 'Koin apa yang ingin ditambahkan ke watchlist?\n…' }));
    expect(replies()[0]).toBe('DOGE/IDR diaktifkan kembali di watchlist.');
    expect(watchlist.entries).toContainEqual({ pair: 'doge_idr', enabled: true });
  });

  it('removes the coin given in the reply to the remove prompt', async () => {
    const { bot, replies, watchlist } = setup();
    await bot.handleUpdate(messageUpdate('/removecoin'));
    expect(replies()[0]).toContain('Koin apa yang ingin dihapus dari watchlist?');
    await bot.handleUpdate(messageUpdate('qnt', OWNER_ID, 'private', { fromId: BOT_ID, text: 'Koin apa yang ingin dihapus dari watchlist?\n…' }));
    expect(replies()[1]).toBe('QNT/IDR dihapus dari watchlist.');
    expect(watchlist.entries.map((e) => e.pair)).toEqual(['doge_idr']);
  });

  it('ignores plain text that is not a reply to a bot prompt', async () => {
    const { bot, replies, watchlist } = setup();
    await bot.handleUpdate(messageUpdate('DOGE'));
    expect(replies()[0]).toContain('Perintah tidak dikenal');
    await bot.handleUpdate(messageUpdate('DOGE', OWNER_ID, 'private', { fromId: 999, text: 'Koin apa yang ingin ditambahkan ke watchlist?' }));
    expect(watchlist.entries).toContainEqual({ pair: 'doge_idr', enabled: false });
  });
});

describe('/analyze (Milestone 3)', () => {
  const BOT_ID = 42;

  it('shows the detailed technical analysis for a coin', async () => {
    const { bot, replies, strategy } = setup({ clock: () => NOW });
    await bot.handleUpdate(messageUpdate('/analyze QNT/IDR'));
    const text = replies()[0]!;
    expect(strategy.evaluate).toHaveBeenCalledWith('qnt_idr');
    expect(text).toContain('ANALISIS TEKNIKAL — QNT/IDR');
    expect(text).toContain('Data ✅ OK');
    expect(text).toContain('Candle final terakhir 16:00 WIB');
    expect(text).toContain('Harga live Rp3.585.298 (belum terkonfirmasi, tidak dipakai indikator)');
    expect(text).toContain('TREN (15m) · 300 candle final');
    expect(text).toContain('KONFIRMASI TREN (1j) · 300 candle final');
    expect(text).toContain('Susunan: naik (EMA9 > EMA20 > EMA50)');
    expect(text).toContain('RSI 100: tidak ada candle turun dalam periode smoothing — bukan sinyal beli');
    expect(text).toMatch(/ATR14 Rp\d/);
    expect(text).toContain('VOLUME');
    expect(text).toContain('ORDER BOOK');
    expect(text).toContain('±1%: +8,8% (seimbang) · ±2%: +13,4% (seimbang)');
    expect(text).toContain('SUPPORT');
    expect(text).toContain('RESISTANCE');
    expect(text).toContain('Ini kondisi indikator, bukan sinyal beli/jual.');
    expect(text).not.toMatch(/\b(BUY|SELL|WAIT)\b/);
  });

  it('asks for the coin when picked from the menu, then analyses the reply', async () => {
    const { bot, replies, strategy } = setup({ clock: () => NOW });
    await bot.handleUpdate(messageUpdate('/analyze'));
    expect(replies()[0]).toContain('Koin apa yang ingin dianalisis?');
    await bot.handleUpdate(messageUpdate('qnt', OWNER_ID, 'private', { fromId: BOT_ID, text: 'Koin apa yang ingin dianalisis?\n…' }));
    expect(strategy.evaluate).toHaveBeenCalledWith('qnt_idr');
    expect(replies()[1]).toContain('ANALISIS TEKNIKAL — QNT/IDR');
  });

  it('refuses unknown, non-IDR and inactive pairs without analysing', async () => {
    const cases: [string, string][] = [
      ['/analyze sol', 'Pair SOL tidak ditemukan di Indodax.'],
      ['/analyze eth_usdt', 'Hanya pair IDR'],
      ['/analyze aero', 'AERO/IDR sedang maintenance di Indodax; analisis tidak tersedia.'],
      ['/analyze ../x', 'Nama koin tidak valid'],
    ];
    for (const [cmd, expected] of cases) {
      const { bot, replies, analysis, strategy } = setup();
      await bot.handleUpdate(messageUpdate(cmd));
      expect(replies()[0]).toContain(expected);
      expect(analysis.analyze).not.toHaveBeenCalled();
      expect(strategy.evaluate).not.toHaveBeenCalled();
    }
  });

  it('reports a failure instead of crashing', async () => {
    const failing = { evaluate: vi.fn(async () => Promise.reject(new Error('db down'))), scan: vi.fn(), riskOverview: vi.fn() };
    const { bot, replies } = setup({ strategy: failing });
    await bot.handleUpdate(messageUpdate('/analyze qnt'));
    expect(replies()[0]).toBe('Gagal menghitung analisis teknikal. Cek /status lalu coba lagi.');
  });

  it('is listed in /help', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(messageUpdate('/help'));
    expect(replies()[0]).toContain('/analyze — Analisis teknikal detail satu koin');
  });
});

describe('Milestone 4: /scan, /risk and the /analyze strategy section', () => {
  it('/analyze sends the indicator report and a separate STRATEGI message', async () => {
    const { bot, replies } = setup({ clock: () => NOW });
    await bot.handleUpdate(messageUpdate('/analyze qnt'));
    expect(replies()).toHaveLength(2);
    const s = replies()[1]!;
    expect(s).toContain('STRATEGI — QNT/IDR');
    expect(s).toMatch(/Keputusan: (⚪ WAIT|🟡 EARLY WARNING)/); // fake data: RSI 100 → never a BUY
    expect(s).not.toContain('KANDIDAT BELI');
    expect(s).toContain('❌ G5 RSI 15m 50–70 — RSI 100');
    expect(s).toContain('Rugi terealisasi: belum tersedia — jurnal transaksi baru tersedia di Milestone 6.');
    expect(s).toContain('Batas rugi aktual harian belum dapat ditegakkan.');
    expect(s).toContain('pajak jual 0,11% (BELUM TERVERIFIKASI)');
    expect(s).toContain('Tidak ada order yang dikirim');
  });

  it('/scan evaluates enabled watchlist pairs and shows the ledgers and costs', async () => {
    const { bot, replies, strategy } = setup({ clock: () => NOW });
    await bot.handleUpdate(messageUpdate('/scan'));
    expect(strategy.scan).toHaveBeenCalledWith(['qnt_idr']);
    const text = replies()[0]!;
    expect(text).toContain('CRYPTO MARKET SCAN');
    expect(text).toMatch(/QNT\/IDR (⚪ WAIT|🟡 EARLY WARNING)/);
    expect(text).toContain('Rekomendasi hari ini: 0/3 · Risiko terencana: Rp0/Rp75.000');
    expect(text).toContain('Asumsi biaya: fee beli 0,2% · fee jual 0,2%');
  });

  it('/scan reports failures without issuing anything', async () => {
    const failing = { scan: vi.fn(async () => Promise.reject(new Error('down'))), evaluate: vi.fn(), riskOverview: vi.fn() };
    const { bot, replies } = setup({ strategy: failing });
    await bot.handleUpdate(messageUpdate('/scan'));
    expect(replies()[0]).toBe('Scan gagal. Tidak ada rekomendasi yang diterbitkan. Cek /status lalu coba lagi.');
  });

  it('/risk shows the unchanged PRD limits read-only', async () => {
    const { bot, replies } = setup({ clock: () => NOW });
    await bot.handleUpdate(messageUpdate('/risk'));
    const text = replies()[0]!;
    expect(text).toContain('Modal analisis: Rp5.000.000');
    expect(text).toContain('Risiko per trade: 0,5% = Rp25.000');
    expect(text).toContain('Batas risiko/rugi harian: 1,5% = Rp75.000');
    expect(text).toContain('Maks rekomendasi per hari: 3 (dieksekusi atau tidak)');
    expect(text).toContain('alokasi maks 50% modal · spot, tanpa leverage');
    expect(text).toContain('Perubahan modal (/capital) belum tersedia.');
  });

  it('/capital is deferred', async () => {
    const { bot, replies } = setup();
    await bot.handleUpdate(messageUpdate('/capital 10000000'));
    expect(replies()[0]).toBe('Perintah /capital belum tersedia (direncanakan di Milestone 6).');
  });
});
