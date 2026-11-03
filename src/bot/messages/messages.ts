import type { ComponentHealth } from '../../app/health/health-service.js';
import type { WatchlistEntry } from '../../watchlist/watchlist-repository.js';
import { COMMANDS, type CommandInfo } from '../commands/registry.js';
import type { TechnicalAnalysis } from '../../analysis/types.js';
import type { PairMarketData } from '../../market/market-data-service.js';
import { analysisSummaryLine } from './analysis.js';
import type { QualityStatus } from '../../market/market-validator.js';
import { formatDateTime, formatIdr, formatPair, formatPercent, formatSignedRatio, formatTime } from './format.js';

const DISCLAIMER = 'Bot ini hanya menganalisis pasar. Semua transaksi beli/jual dilakukan manual oleh Anda di Indodax.';

export function startMessage(): string {
  return [
    'CRYPTO ANALYST — Indodax',
    '',
    'Analis pasar pribadi untuk watchlist Anda.',
    DISCLAIMER,
    '',
    'Ketik /help untuk melihat daftar perintah.',
  ].join('\n');
}

export function helpMessage(commands: readonly CommandInfo[] = COMMANDS): string {
  const line = (c: CommandInfo) => `/${c.command} — ${c.description}`;
  const available = commands.filter((c) => c.plannedMilestone === null);
  const upcoming = commands.filter((c) => c.plannedMilestone !== null);
  return [
    'PERINTAH TERSEDIA',
    ...available.map(line),
    '',
    'SEGERA HADIR',
    ...upcoming.map((c) => `${line(c)} (M${c.plannedMilestone})`),
    '',
    DISCLAIMER,
  ].join('\n');
}

export interface StatusView {
  now: Date;
  timeZone: string;
  components: ComponentHealth[];
  ai: { enabled: boolean; disabledReason?: string | undefined };
  /** Milestone 5 scheduler state; absent → "belum aktif". */
  scheduler?: SchedulerStatusView | undefined;
}

export interface SchedulerStatusView {
  running: boolean;
  paused: boolean | null;
  lockHeld: boolean;
  clock: { status: 'UNKNOWN' | 'VALID' | 'INVALID'; skewMs: number | null; checkedAt: Date | null };
  nextSlotAt: Date | null;
  nextSlotKind: string | null;
  lastRun: { kind: string; status: string; slotAt: Date; cause: string | null } | null;
  consecutiveFailures: number;
  breakerOpen: boolean;
  requests: { lastHour: number; peakPerMinute: number; limitPerMinute: number };
}

const CLOCK_TEXT = { VALID: 'valid', INVALID: 'TIDAK VALID — keputusan & penyimpanan data ditahan', UNKNOWN: 'belum terverifikasi — keputusan ditahan' };

function schedulerLines(s: SchedulerStatusView, timeZone: string): string[] {
  const skew = s.clock.skewMs === null ? '' : ` (selisih ${(s.clock.skewMs / 1000).toFixed(1)} dtk)`;
  return [
    'SCHEDULER',
    `${s.running && s.lockHeld ? '✅' : '❌'} Scheduler: ${s.running ? 'berjalan' : 'berhenti'}${s.lockHeld ? '' : ' — lock instance tidak dipegang'}`,
    `${s.paused ? '⏸' : '▶️'} Scan strategi: ${s.paused === null ? 'tidak diketahui' : s.paused ? 'DIJEDA (/resume) — data tetap dikumpulkan' : 'aktif'}`,
    `${s.clock.status === 'VALID' ? '✅' : '⛔'} Jam: ${CLOCK_TEXT[s.clock.status]}${skew}`,
    `Slot berikutnya: ${s.nextSlotAt ? `${formatTime(s.nextSlotAt, timeZone)} (${s.nextSlotKind === 'STRATEGY_SCAN' ? 'scan strategi' : 'pengumpulan data'})` : '-'}`,
    `Run terakhir: ${s.lastRun ? `${formatTime(s.lastRun.slotAt, timeZone)} ${s.lastRun.kind} ${s.lastRun.status}${s.lastRun.cause ? ` (${s.lastRun.cause})` : ''}` : '-'}`,
    `Gagal beruntun: ${s.consecutiveFailures}${s.breakerOpen ? ' — circuit breaker aktif (tanpa retry)' : ''}`,
    `Request Indodax: ${s.requests.lastHour}/jam · puncak ${s.requests.peakPerMinute}/menit (batas ${s.requests.limitPerMinute})`,
  ];
}

export function statusMessage(view: StatusView): string {
  const componentLines = view.components.map((c) =>
    c.ok
      ? `✅ ${c.name}: OK (${c.latencyMs} ms)${c.detail ? ` — ${c.detail}` : ''}`
      : `❌ ${c.name}: GAGAL — ${c.detail ?? 'tidak diketahui'}`,
  );
  // The key is not validated until the Claude integration lands (Milestone 5),
  // so "configured" is the strongest honest claim here.
  const aiLine = view.ai.enabled
    ? '⚪ AI (Claude): terkonfigurasi — belum digunakan (Milestone 5)'
    : `⚪ AI (Claude): nonaktif${view.ai.disabledReason ? ` — ${view.ai.disabledReason}` : ''}`;

  return [
    'STATUS SISTEM',
    formatDateTime(view.now, view.timeZone),
    '',
    ...componentLines,
    aiLine,
    '',
    'Mode: analisis saja — tidak ada eksekusi order.',
    ...(view.scheduler ? ['', ...schedulerLines(view.scheduler, view.timeZone)] : ['Scanner otomatis: belum aktif (Milestone 5).']),
  ].join('\n');
}

const STATUS_ICON: Record<QualityStatus, string> = { OK: '✅', DEGRADED: '⚠️', UNAVAILABLE: '⛔' };

/** /watchlist with live market data (Milestone 2). */
export function watchlistMarketMessage(view: {
  entries: WatchlistEntry[];
  market: Map<string, PairMarketData>;
  analysis?: Map<string, TechnicalAnalysis>;
  now: Date;
  timeZone: string;
}): string {
  if (view.entries.length === 0) {
    return 'WATCHLIST\n\nWatchlist kosong. Tambahkan dengan /addcoin <koin>.';
  }
  const blocks = view.entries.map((e) => {
    const data = view.market.get(e.pair);
    if (!e.enabled) return `${formatPair(e.pair)} — nonaktif`;
    if (!data) return `${formatPair(e.pair)} — data tidak tersedia`;
    const analysis = view.analysis?.get(e.pair);
    const summary = analysis ? analysisSummaryLine(analysis) : null;
    return summary ? `${pairBlock(data, view.now, view.timeZone)}\n${summary}` : pairBlock(data, view.now, view.timeZone);
  });
  return [
    `WATCHLIST — ${formatDateTime(view.now, view.timeZone)}`,
    '',
    blocks.join('\n\n'),
    '',
    'Status: ✅ OK · ⚠️ DEGRADED (valid, ada peringatan) · ⛔ UNAVAILABLE (tidak boleh BUY)',
    ...(view.analysis ? ['⚠ = indikator kurang andal · detail: /analyze <koin>'] : []),
  ].join('\n');
}

function pairBlock(d: PairMarketData, now: Date, timeZone: string): string {
  const lines = [`${formatPair(d.pair)} — ${STATUS_ICON[d.quality.status]} ${d.quality.status}`];
  const { ticker, metrics } = d;
  if (ticker) {
    const ageSec = Math.max(0, Math.round((now.getTime() - ticker.serverTime.getTime()) / 1000));
    lines.push(`Harga: ${formatIdr(ticker.last)} (data ${ageSec} dtk lalu)`);
  }
  if (metrics) {
    lines.push(`Bid/Ask: ${formatIdr(metrics.bestBid)} / ${formatIdr(metrics.bestAsk)}`);
    lines.push(`Spread: ${formatIdr(metrics.spreadIdr)} (${formatPercent(metrics.spreadPct)})`);
    const imbalance = metrics.bands
      .map((b) => `±${b.pct}%: ${b.imbalance ? formatSignedRatio(b.imbalance) : '-'}`)
      .join(' | ');
    lines.push(`Imbalance ${imbalance}`);
  }
  const last = d.finalCandles.at(-1);
  if (last) {
    lines.push(`Candle ${d.timeframe}m: ${d.finalCandles.length} final, terakhir ${formatTime(last.openTime, timeZone)}`);
  }
  const critical = d.quality.issues.filter((i) => i.severity === 'critical');
  const warnings = d.quality.issues.filter((i) => i.severity === 'warning');
  if (critical.length > 0) lines.push(`Alasan: ${critical.map((i) => i.message).join('; ')}`);
  if (warnings.length > 0) lines.push(`Peringatan: ${warnings.map((i) => i.message).join('; ')}`);
  return lines.join('\n');
}

export function notAvailableMessage(command: CommandInfo): string {
  return `Perintah /${command.command} belum tersedia (direncanakan di Milestone ${command.plannedMilestone}).`;
}
