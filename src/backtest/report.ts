import type { Dec } from '../app/decimal.js';
import { formatIdr, formatNumber, formatPercent } from '../bot/messages/format.js';
import type { Metrics } from './metrics.js';

const idr = (v: Dec | null) => (v === null ? '-' : v.lt(0) ? `−${formatIdr(v.abs().toDecimalPlaces(0))}` : formatIdr(v.toDecimalPlaces(0)));
const num = (v: Dec | null, dp = 2) => (v === null ? '-' : formatNumber(v, dp));

/** Human-readable metric lines (Indonesian). */
export function metricLines(m: Metrics, indent = '  '): string[] {
  if (m.trades === 0) return [`${indent}0 trade — ${m.sampleNote}`];
  const ci = m.expectancyRCi95 ? ` (95% bootstrap ≈ ${m.expectancyRCi95[0].toFixed(2)} … ${m.expectancyRCi95[1].toFixed(2)} R)` : '';
  return [
    `${indent}Trade ${m.trades} · menang ${m.wins} · kalah ${m.losses} · win rate ${m.winRatePct ? formatPercent(m.winRatePct, 1) : '-'}`,
    `${indent}Expectancy setelah biaya: ${idr(m.expectancyIdr)} per trade = ${num(m.expectancyR)} R${ci}`,
    `${indent}Rata-rata menang ${idr(m.avgWin)} · rata-rata kalah ${idr(m.avgLoss)} · profit factor ${num(m.profitFactor)}`,
    `${indent}Total bersih ${idr(m.totalNet)} · fee ${idr(m.totalFees)} · pajak ${idr(m.totalTaxes)} · slippage ${idr(m.totalSlippage)}`,
    `${indent}Max drawdown ${idr(m.maxDrawdownIdr)} (${formatPercent(m.maxDrawdownPct)} modal, ${m.maxDrawdownDays} hari) · rentetan kalah terpanjang ${m.longestLosingStreak}`,
    `${indent}Periode terburuk: hari ${m.worstDay ? `${m.worstDay.key} ${idr(m.worstDay.net)}` : '-'} · ${m.worstWeek ? `${m.worstWeek.key} ${idr(m.worstWeek.net)}` : '-'} · bulan ${m.worstMonth ? `${m.worstMonth.key} ${idr(m.worstMonth.net)}` : '-'}`,
    `${indent}Exit: ${Object.entries(m.exits).map(([k, v]) => `${k} ${v}`).join(', ')} · entry: ${Object.entries(m.entryKinds).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `${indent}Rugi melebihi estimasi: ${m.overshootCount} trade${m.overshootCount ? ` (terbesar ${idr(m.maxOvershootIdr)} di atas rencana)` : ''}`,
    `${indent}Catatan sampel: ${m.sampleNote}`,
  ];
}

export const BACKTEST_CAVEATS = [
  'Semua fill entry adalah ESTIMASI: tidak ada data antrean order historis. Harga menembus limit dan volume candle ≥ jumlah order TIDAK membuktikan order limit akan terisi.',
  'Order book, arus trade, dan spread historis tidak tersedia: gerbang G8 dinetralkan, batas kedalaman order book tidak diterapkan, spread diasumsikan konstan dari satu sampel live. Hasil cenderung optimistis.',
  'Exit konservatif: SL dianggap lebih dulu bila SL dan TP tersentuh di candle yang sama; gap di bawah SL keluar di harga open; TP tanpa slippage positif.',
  'Fee dan pajak memakai asumsi yang BELUM TERVERIFIKASI.',
  'Hanya 4 pair yang masih aktif hari ini (bias survivorship) dan satu periode 12 bulan dengan kondisi pasarnya sendiri.',
  'Minimal 30 trade BUKAN bukti statistik yang cukup bahwa strategi punya keunggulan.',
  'Backtest ini TIDAK menyimpulkan bahwa strategi profitable.',
];
