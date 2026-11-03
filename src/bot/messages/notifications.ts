import { Dec } from '../../app/decimal.js';
import type { RiskState } from '../../risk/risk-ledger.js';
import type { StrategySettings } from '../../strategy/settings.js';
import type { PairStrategyResult } from '../../strategy/strategy-service.js';
import type { Decision } from '../../strategy/types.js';
import { formatDateTime, formatIdr, formatPair, formatPercent, formatShortDateTime, formatTime } from './format.js';
import { costLine, DECISION_LABEL, RECOMMENDATION_DISCLAIMER, riskLines, strategyMessage } from './strategy.js';

/**
 * Deterministic Telegram notification templates (Milestone 5C). Every number
 * comes from the Strategy/Risk engine or stored market data — never from AI.
 */

export const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 4000;
const HYPO_NOTE = 'Hasil hipotetis dari data pasar — bukan P/L Anda; sistem tidak tahu apakah Anda mengeksekusi.';

function dataAgeLine(r: PairStrategyResult, timeZone: string): string {
  const t = r.market.ticker;
  if (!t) return `Data pasar: diambil ${formatTime(r.market.fetchedAt, timeZone)}`;
  const age = Math.max(0, Math.round((r.decision.evaluatedAt.getTime() - t.serverTime.getTime()) / 1000));
  return `Data pasar: harga terakhir ${formatIdr(t.last)} · waktu server ${formatTime(t.serverTime, timeZone)} (${age} dtk sebelum keputusan)`;
}

/** BUY_CANDIDATE: the full M4 recommendation (same text as /analyze STRATEGI), plus id, data age and action. */
export function buyNotification(r: PairStrategyResult & { risk: RiskState; settings: StrategySettings }, signalId: number, timeZone: string): string {
  const head = [`🔔 REKOMENDASI BELI #${signalId} — ${formatPair(r.decision.pair)}`, dataAgeLine(r, timeZone), ''];
  const tail = ['', 'ACTION: Tinjau di Indodax. Eksekusi manual sepenuhnya keputusan Anda.'];
  const full = [...head, strategyMessage(r, timeZone), ...tail].join('\n');
  if (full.length <= SAFE_LIMIT) return full;
  // Too long for Telegram: same plan without the per-gate list (all gates passed for a BUY).
  const withoutGates = strategyMessage(r, timeZone).replace(/\n\nSyarat:\n(?:.*\n)*?(?=\n)/, '\n\nSyarat: semua G1–G12 lulus (detail: /analyze).\n');
  return [...head, withoutGates, ...tail].join('\n').slice(0, SAFE_LIMIT);
}

/** EARLY_WARNING: a heads-up, explicitly not a BUY; no entry/SL/TP numbers. */
export function earlyWarningNotification(r: PairStrategyResult, timeZone: string): string {
  const d = r.decision;
  const lines = [
    `🟡 EARLY WARNING — ${formatPair(d.pair)}`,
    `${formatDateTime(d.evaluatedAt, timeZone)}${d.regime ? ` · regime ${d.regime.regime}` : ''}`,
    dataAgeLine(r, timeZone),
    '',
    'BUKAN sinyal beli. Belum ada konfirmasi BUY — jangan entry berdasarkan pesan ini.',
    '',
    'Yang terlihat:',
    ...(d.earlyWarningSignals.length ? d.earlyWarningSignals : ['-']).map((s) => `• ${s}`),
  ];
  const restrictions = d.reasons.filter((x) => !d.earlyWarningSignals.includes(x)).slice(0, 4);
  if (restrictions.length) lines.push('', 'Catatan:', ...restrictions.map((s) => `• ${s}`));
  lines.push('', 'Detail: /analyze ' + d.pair.split('_')[0], RECOMMENDATION_DISCLAIMER);
  return lines.join('\n').slice(0, SAFE_LIMIT);
}

export interface LifecycleView {
  id: number;
  pair: string;
  lifecycle: 'EXPIRED_UNFILLED' | 'POSSIBLY_FILLED' | 'HYPO_CLOSED';
  lifecycleAt: Date;
  hypo: { exitReason?: string; netPnl?: string; entryFill?: string; exitPrice?: string } | null;
}

const EXIT_LABEL: Record<string, string> = { tp: 'take profit tersentuh', sl: 'stop loss tersentuh', gap_sl: 'gap melewati stop loss', waktu: 'batas waktu', gap_sebelum_entry: 'gap di bawah SL saat entry', sl_di_candle_entry: 'SL tersentuh di candle entry' };

export function lifecycleNotification(v: LifecycleView, timeZone: string): string {
  const head = `Rekomendasi #${v.id} — ${formatPair(v.pair)}`;
  if (v.lifecycle === 'EXPIRED_UNFILLED') {
    return [`⌛ KEDALUWARSA (tidak terisi) — ${head}`, formatShortDateTime(v.lifecycleAt, timeZone), '', 'Harga tidak masuk rentang entry selama masa berlaku. Reservasi risiko harian dilepas.', 'Jangan entry berdasarkan rekomendasi ini lagi.'].join('\n');
  }
  if (v.lifecycle === 'POSSIBLY_FILLED') {
    return [`🔵 MUNGKIN TERISI — ${head}`, formatShortDateTime(v.lifecycleAt, timeZone), '', 'Ada transaksi pasar di dalam rentang entry selama masa berlaku.', 'Ini berdasarkan data pasar, BUKAN konfirmasi transaksi Anda. Slot posisi tetap dipegang secara konservatif.'].join('\n');
  }
  const h = v.hypo;
  const pnl = h?.netPnl ? new Dec(h.netPnl) : null;
  return [
    `⚪ DITUTUP (HIPOTETIS) — ${head}`,
    formatShortDateTime(v.lifecycleAt, timeZone),
    '',
    `Alasan: ${h?.exitReason ? (EXIT_LABEL[h.exitReason] ?? h.exitReason) : '-'}`,
    ...(h?.entryFill && h.exitPrice ? [`Harga hipotetis: masuk ${formatIdr(new Dec(h.entryFill))} → keluar ${formatIdr(new Dec(h.exitPrice))}`] : []),
    ...(pnl ? [`Hasil bersih hipotetis: ${pnl.lt(0) ? '−' : ''}${formatIdr(pnl.abs())}`] : []),
    '',
    HYPO_NOTE,
  ].join('\n');
}

export type AdviceReason = 'CHASE_LIMIT_EXCEEDED' | 'BELOW_STOP_LOSS' | 'DATA_UNAVAILABLE' | 'PAIR_MAINTENANCE' | 'VALIDITY_ENDED';

const ADVICE_TEXT: Record<AdviceReason, string> = {
  CHASE_LIMIT_EXCEEDED: 'harga sudah melewati batas kejar',
  BELOW_STOP_LOSS: 'harga sudah di bawah stop loss sebelum terisi',
  DATA_UNAVAILABLE: 'data pasar tidak tersedia / tidak valid',
  PAIR_MAINTENANCE: 'pair sedang maintenance / suspend',
  VALIDITY_ENDED: 'masa berlaku rekomendasi sudah habis',
};

/**
 * Protective advice. Deliberately contains NO price, entry range, SL, TP or
 * size, and no re-entry suggestion: it can only stop a trade, never open one.
 */
export function adviceNotification(v: { signalId: number; pair: string; reason: AdviceReason; at: Date }, timeZone: string): string {
  return [
    `⛔ JANGAN ENTRY — rekomendasi #${v.signalId} ${formatPair(v.pair)}`,
    formatShortDateTime(v.at, timeZone),
    '',
    `Alasan: ${ADVICE_TEXT[v.reason]}.`,
    'Rekomendasi ini dianggap batal secara praktis. Ini bukan peluang baru.',
  ].join('\n');
}

export interface SummaryView {
  at: Date;
  label: 'PAGI' | 'MALAM';
  timeZone: string;
  pairs: { pair: string; decision: Decision | null; decidedAt: Date | null; regime: string | null; price: Dec | null; spreadPct: Dec | null; quality: string | null; snapshotAt: Date | null }[];
  risk: RiskState | null;
  settings: StrategySettings | null;
  openBuys: { id: number; pair: string; lifecycle: string }[];
  sentToday: Record<string, number>;
  suppressed: { kind: string; pair: string | null; signalId: number | null; reason: string; at: Date }[];
  gaps: { pair: string; kind: string; minutes: number; cause: string }[];
  scheduler: { consecutiveFailures: number; clock: string; serverTimeTrusted: boolean };
}

export function summaryNotification(v: SummaryView): string {
  const tz = v.timeZone;
  const lines = [`📊 RINGKASAN PASAR ${v.label} — ${formatDateTime(v.at, tz)}`, '', 'WATCHLIST (scan strategi terakhir)'];
  for (const p of v.pairs) {
    const decision = p.decision ? `${DECISION_LABEL[p.decision]}${p.regime ? ` (${p.regime})` : ''} · ${p.decidedAt ? formatTime(p.decidedAt, tz) : '-'}` : 'belum ada scan strategi terbaru';
    const market = p.price ? `${formatIdr(p.price)} · spread ${p.spreadPct ? formatPercent(p.spreadPct) : '-'} · data ${p.quality ?? '-'} ${p.snapshotAt ? formatTime(p.snapshotAt, tz) : ''}` : 'snapshot tidak tersedia';
    lines.push(`${formatPair(p.pair)} — ${decision}`, `   ${market}`);
  }
  lines.push('', 'HARI INI');
  if (v.risk) lines.push(...riskLines(v.risk));
  lines.push(
    `Notifikasi terkirim: BUY ${v.sentToday.BUY_CANDIDATE ?? 0} · EARLY WARNING ${v.sentToday.EARLY_WARNING ?? 0} · lifecycle ${v.sentToday.LIFECYCLE ?? 0} · saran ${v.sentToday.ADVICE_DO_NOT_ENTER ?? 0}`,
  );
  if (v.openBuys.length) lines.push(...v.openBuys.map((b) => `Rekomendasi terbuka: #${b.id} ${formatPair(b.pair)} — ${b.lifecycle === 'ACTIVE' ? 'masih berlaku' : 'mungkin terisi (eksekusi tidak diketahui)'}`));

  const trading = v.suppressed.filter((s) => s.kind === 'LIFECYCLE' || s.kind === 'ADVICE_DO_NOT_ENTER' || s.kind === 'BUY_CANDIDATE');
  if (trading.length) {
    lines.push('', 'DITAHAN (di luar jam aktif / dijeda):');
    for (const s of trading.slice(0, 8)) lines.push(`• ${formatShortDateTime(s.at, tz)} ${s.kind}${s.signalId ? ` #${s.signalId}` : ''}${s.pair ? ` ${formatPair(s.pair)}` : ''} — ${s.reason}`);
  }
  const ewHeld = v.suppressed.filter((s) => s.kind === 'EARLY_WARNING').length;
  if (ewHeld) lines.push(`EARLY WARNING ditahan (tanpa perubahan/cooldown/batas): ${ewHeld}`);

  if (v.gaps.length) {
    lines.push('', 'GAP DATA (12 jam terakhir):');
    for (const g of v.gaps.slice(0, 6)) lines.push(`• ${formatPair(g.pair)} ${g.kind.toLowerCase()} ${g.minutes} menit — ${g.cause}`);
  }
  const health = [
    v.scheduler.consecutiveFailures ? `gagal beruntun ${v.scheduler.consecutiveFailures}` : null,
    v.scheduler.clock !== 'VALID' ? `jam ${v.scheduler.clock}` : null,
    v.scheduler.serverTimeTrusted ? null : 'waktu server belum dipercaya',
  ].filter(Boolean);
  lines.push('', `Sistem: ${health.length ? `⚠️ ${health.join(' · ')}` : '✅ normal'}`);
  if (v.settings) lines.push(costLine(v.settings.costs));
  lines.push('', RECOMMENDATION_DISCLAIMER);
  return lines.join('\n').slice(0, SAFE_LIMIT);
}

export type SystemEvent =
  | { type: 'FAILURES'; count: number; lastCause: string | null }
  | { type: 'FAILURES_RECOVERED' }
  | { type: 'CLOCK_INVALID'; skewMs: number | null }
  | { type: 'CLOCK_VALID' }
  | { type: 'SERVER_TIME_UNTRUSTED'; reason: string }
  | { type: 'SERVER_TIME_TRUSTED' }
  | { type: 'RESTARTED'; missedSlots: number; since: Date | null };

export function systemNotification(e: SystemEvent, at: Date, timeZone: string): string {
  const t = formatShortDateTime(at, timeZone);
  switch (e.type) {
    case 'FAILURES':
      return `⚠️ SISTEM — ${t}\n${e.count} slot scan gagal berturut-turut${e.lastCause ? ` (${e.lastCause})` : ''}. Tidak ada rekomendasi selama gangguan. Cek /status.`;
    case 'FAILURES_RECOVERED':
      return `✅ SISTEM — ${t}\nScan kembali berjalan normal.`;
    case 'CLOCK_INVALID':
      return `⛔ SISTEM — ${t}\nJam komputer tidak sesuai waktu Indodax${e.skewMs !== null ? ` (selisih ${Math.round(e.skewMs / 1000)} dtk)` : ''}. Keputusan trading DIHENTIKAN sampai jam valid. Pengumpulan data tetap berjalan dengan waktu server.`;
    case 'CLOCK_VALID':
      return `✅ SISTEM — ${t}\nJam komputer kembali valid. Keputusan trading berjalan lagi mulai slot berikutnya.`;
    case 'SERVER_TIME_UNTRUSTED':
      return `⚠️ SISTEM — ${t}\nWaktu server Indodax belum dapat dipercaya (${e.reason}). Pengumpulan data ditahan dan dicatat sebagai gap.`;
    case 'SERVER_TIME_TRUSTED':
      return `✅ SISTEM — ${t}\nWaktu server Indodax kembali dapat dipercaya. Pengumpulan data berjalan lagi.`;
    case 'RESTARTED':
      return `ℹ️ SISTEM — ${t}\nBot aktif kembali. ${e.missedSlots} slot terlewat${e.since ? ` sejak ${formatShortDateTime(e.since, timeZone)}` : ''} dicatat sebagai gap data (tidak diisi ulang).`;
  }
}
