import { Dec } from '../../app/decimal.js';
import type { CostAssumptions } from '../../risk/costs.js';
import type { RiskState } from '../../risk/risk-ledger.js';
import type { StrategySettings } from '../../strategy/settings.js';
import type { PairStrategyResult, ScanResult } from '../../strategy/strategy-service.js';
import type { Decision, StrategyDecision } from '../../strategy/types.js';
import { formatDateTime, formatIdr, formatNumber, formatPair, formatPercent, formatPrice, formatTime } from './format.js';

export const DECISION_LABEL: Record<Decision, string> = {
  BUY_CANDIDATE: '🟢 KANDIDAT BELI',
  EARLY_WARNING: '🟡 EARLY WARNING',
  WAIT: '⚪ WAIT',
  NO_TRADE: '⛔ NO TRADE',
  DATA_UNAVAILABLE: '⚠️ DATA TIDAK TERSEDIA',
};

export const RECOMMENDATION_DISCLAIMER =
  'Ini rekomendasi analisis, bukan perintah. Tidak ada order yang dikirim; eksekusi manual di Indodax sepenuhnya keputusan Anda.';

export const LOSS_WARNING =
  'Rugi maksimal adalah estimasi pada kondisi normal. Rugi aktual bisa lebih besar jika terjadi gap harga, likuiditas tipis, ' +
  'stop loss tidak terisi atau tidak dipasang, atau order terisi sebagian. Fee dan pajak adalah asumsi.';

const GATE_ICON = (p: boolean | null) => (p === true ? '✅' : p === false ? '❌' : '➖');
/** IDR amounts: losses rounded up, gains rounded down (never flatter the estimate). */
const idrUp = (v: Dec) => formatIdr(v.toDecimalPlaces(0, Dec.ROUND_UP));
const idrDown = (v: Dec) => {
  const r = v.toDecimalPlaces(0, Dec.ROUND_DOWN);
  return r.lt(0) ? `−${formatIdr(r.abs())}` : formatIdr(r);
};

export function costLine(c: CostAssumptions): string {
  return (
    `Asumsi biaya: fee beli ${formatPercent(c.buyFeePct)} · fee jual ${formatPercent(c.sellFeePct)} · ` +
    `pajak beli ${formatPercent(c.buyTaxPct)} · pajak jual ${formatPercent(c.sellTaxPct)}` +
    `${c.verified ? '' : ' (BELUM TERVERIFIKASI)'} · slippage SL ≥${formatPercent(c.stopSlippagePct)}` +
    (c.entrySlippagePct.gt(0) ? ` · slippage entry ${formatPercent(c.entrySlippagePct)}` : '') +
    (c.tpSlippagePct.gt(0) ? ` · slippage TP ${formatPercent(c.tpSlippagePct)}` : '')
  );
}

export function riskLines(r: RiskState): string[] {
  return [
    `Rekomendasi hari ini: ${r.recommendationsToday}/${r.limits.maxDailyRecommendations} · ` +
      `Risiko terencana: ${idrUp(r.reservedRiskToday)}/${idrUp(r.dailyRiskLimit)}`,
    r.realizedLoss.available
      ? `Rugi terealisasi hari ini: ${idrUp(r.realizedLoss.amount)}`
      : `Rugi terealisasi: belum tersedia — ${r.realizedLoss.reason}.`,
    ...(r.realizedLossEnforced
      ? []
      : ['Sistem tidak tahu apakah rekomendasi dieksekusi. Batas rugi aktual harian belum dapat ditegakkan.']),
  ];
}

function buyDetails(d: StrategyDecision, timeZone: string): string[] {
  const p = d.plan!;
  const s = p.sizing;
  if (!s.ok) return [];
  const unit = d.pair.split('_')[0]!.toUpperCase();
  const lines = [
    `Entry (limit buy): ${formatIdr(p.entry.min)} – ${formatIdr(p.entry.max)} · berlaku s/d ${formatTime(p.expiresAt, timeZone)}`,
    `Jangan dikejar di atas ${formatPrice(p.chaseLimit)}.`,
    `Jumlah: ${formatNumber(s.quantity, 8)} ${unit} ≈ ${idrUp(s.positionValue)} (${formatPercent(s.allocationPct, 1)} modal)` +
      (s.cappedBy !== 'risiko' ? ` — dibatasi ${s.cappedBy}` : ''),
    `Stop loss: ${formatIdr(p.stop)} (−${formatPercent(p.stopDistancePct)}, ${formatNumber(p.stopDistanceAtr, 2)} ATR, ${p.stopMethod.replace('_', ' ')})`,
    `Take profit: ${formatIdr(p.takeProfit)} (+${formatPercent(p.takeProfitPct)}, ${p.takeProfitMethod === 'resistance' ? 'di bawah resistance' : 'batas R/R'})`,
    `Rugi maks (bersih): ${idrUp(s.atStop.netLoss)} · Untung (bersih): ${idrDown(s.atTarget.netWin)} · R/R bersih 1:${formatNumber(s.netRr, 2)}`,
    `Kotor: rugi ${idrUp(s.atStop.grossLoss)} · untung ${idrDown(s.atTarget.grossWin)} (R/R kotor 1:${formatNumber(s.grossRr, 2)})`,
    `Estimasi biaya: fee beli ${idrUp(s.buy.fee)} · pajak beli ${idrUp(s.buy.tax)} · ` +
      `di SL: fee ${idrUp(s.atStop.fee)}, pajak ${idrUp(s.atStop.tax)}, slippage ${idrUp(s.atStop.slippage)} · ` +
      `di TP: fee ${idrUp(s.atTarget.fee)}, pajak ${idrUp(s.atTarget.tax)}`,
  ];
  for (const note of s.notes) lines.push(`Catatan: ${note}`);
  return lines;
}

function decisionBody(r: PairStrategyResult, timeZone: string): string[] {
  const d = r.decision;
  const lines: string[] = [];
  if (r.existingBuyId) {
    lines.push(`Rekomendasi #${r.existingBuyId} untuk candle ini sudah diterbitkan sebelumnya dan tidak dihitung ulang.`);
  }
  if (d.decision === 'BUY_CANDIDATE' && d.plan?.sizing.ok) {
    lines.push(...buyDetails(d, timeZone), '', 'Alasan:', ...d.reasons.map((x) => `✅ ${x}`));
  } else {
    lines.push('Alasan:', ...d.reasons.map((x) => `• ${x}`));
    if (d.restrictions.length && d.decision !== 'EARLY_WARNING') lines.push('Pembatasan:', ...d.restrictions.map((x) => `• ${x}`));
    if (d.decision === 'EARLY_WARNING') lines.push('Belum ada konfirmasi BUY. Pantau candle berikutnya.');
  }
  return lines;
}

/** STRATEGI section for /analyze (sent as its own message). */
export function strategyMessage(
  r: PairStrategyResult & { risk: RiskState; settings: StrategySettings },
  timeZone: string,
): string {
  const d = r.decision;
  const lines = [
    `STRATEGI — ${formatPair(d.pair)} · ${formatDateTime(d.evaluatedAt, timeZone)}`,
    `Keputusan: ${DECISION_LABEL[d.decision]}${d.regime ? ` · regime ${d.regime.regime}${d.regime.confirmed1h ? '' : ' (tanpa konfirmasi 1j)'}` : ''}`,
    '',
    ...decisionBody(r, timeZone),
  ];
  if (d.gates.length) {
    lines.push('', 'Syarat:', ...d.gates.map((g) => `${GATE_ICON(g.passed)} ${g.id} ${g.label} — ${g.detail}`));
  }
  if (d.decision !== 'BUY_CANDIDATE' && d.plan?.sizing.ok && d.decision !== 'DATA_UNAVAILABLE') {
    const s = d.plan.sizing;
    lines.push(
      '',
      `Simulasi (bukan rekomendasi): entry ${formatIdr(d.plan.entry.max)} · SL ${formatIdr(d.plan.stop)} · TP ${formatIdr(d.plan.takeProfit)} · ` +
        `rugi bersih ${idrUp(s.atStop.netLoss)} · untung bersih ${idrDown(s.atTarget.netWin)} · R/R bersih ${formatNumber(s.netRr, 2)}`,
    );
  }
  lines.push('', ...riskLines(r.risk), costLine(r.settings.costs));
  if (d.decision === 'BUY_CANDIDATE') lines.push('', LOSS_WARNING);
  lines.push('', RECOMMENDATION_DISCLAIMER);
  return lines.join('\n');
}

/** /scan: watchlist decisions and at most one primary candidate. */
export function scanMessage(scan: ScanResult, timeZone: string): string {
  const lines = ['CRYPTO MARKET SCAN', formatDateTime(scan.evaluatedAt, timeZone), '', 'WATCHLIST'];
  for (const r of scan.results) {
    const d = r.decision;
    const short = d.decision === 'BUY_CANDIDATE' || d.decision === 'EARLY_WARNING' ? '' : ` — ${d.reasons[0] ?? ''}`;
    lines.push(`${formatPair(d.pair)} ${DECISION_LABEL[d.decision]}${d.regime ? ` (${d.regime.regime})` : ''}${short}`);
  }

  const best = scan.best;
  if (best && best.decision.decision === 'BUY_CANDIDATE') {
    lines.push('', `KANDIDAT UTAMA: ${formatPair(best.decision.pair)}`, ...decisionBody(best, timeZone), '', 'ACTION:', 'Tinjau di Indodax. Eksekusi manual oleh Anda.');
  } else if (best) {
    lines.push('', `PANTAU: ${formatPair(best.decision.pair)} — EARLY WARNING`, ...decisionBody(best, timeZone));
  } else {
    lines.push('', 'Belum ada setup BUY yang memenuhi syarat.');
  }

  lines.push('', ...riskLines(scan.risk), costLine(scan.settings.costs));
  if (best?.decision.decision === 'BUY_CANDIDATE') lines.push('', LOSS_WARNING);
  lines.push('', 'Detail per koin: /analyze <koin>', RECOMMENDATION_DISCLAIMER);
  return lines.join('\n');
}

/** /risk: read-only risk configuration and today's ledgers. */
export function riskMessage(o: { risk: RiskState; settings: StrategySettings }, now: Date, timeZone: string): string {
  const { risk: r, settings: s } = o;
  const l = r.limits;
  const lines = [
    'KONFIGURASI RISIKO',
    formatDateTime(now, timeZone),
    '',
    `Modal analisis: ${formatIdr(l.capital)}`,
    `Risiko per trade: ${formatPercent(l.riskPerTradePct)} = ${idrUp(r.perTradeRisk)}`,
    `Batas risiko/rugi harian: ${formatPercent(l.dailyLossLimitPct)} = ${idrUp(r.dailyRiskLimit)}`,
    `Maks rekomendasi per hari: ${l.maxDailyRecommendations} (dieksekusi atau tidak)`,
    `Maks posisi aktif: ${l.maxActivePositions} · alokasi maks ${formatPercent(s.maxAllocPct, 0)} modal · spot, tanpa leverage`,
    `Jam aktif: ${s.activeHours.start}–${s.activeHours.end}`,
    '',
    'HARI INI',
    ...riskLines(r),
    `Sisa risiko terencana: ${idrDown(r.remainingDailyRisk)} · anggaran rekomendasi berikutnya: ${idrDown(r.nextRiskBudget)}`,
  ];
  if (r.slotHolders.length) {
    lines.push(
      ...r.slotHolders.map(
        (h) => `Slot posisi: ${formatPair(h.pair)} #${h.id} ${h.lifecycle === 'ACTIVE' ? 'masih berlaku' : 'mungkin terisi (eksekusi tidak diketahui)'}`,
      ),
    );
  }
  if (r.blocks.length) lines.push('Diblokir:', ...r.blocks.map((b) => `• ${b.message}`));
  lines.push('', costLine(s.costs), 'Ubah asumsi biaya: pnpm settings:costs (di komputer lokal).', 'Perubahan modal (/capital) belum tersedia.');
  return lines.join('\n');
}
