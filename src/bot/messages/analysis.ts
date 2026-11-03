import { DISCLAIMER, pressureLabel, stackLabel } from '../../analysis/interpretation.js';
import type { Reading, TechnicalAnalysis, TrendAnalysis } from '../../analysis/types.js';
import type { Dec } from '../../app/decimal.js';
import type { LevelDistance } from '../../indicators/support-resistance.js';
import {
  formatDateTime,
  formatNumber,
  formatPair,
  formatPercent,
  formatPrice,
  formatShortDateTime,
  formatSignedPercent,
  formatSignedRatio,
  formatTime,
} from './format.js';

const STATUS_ICON = { OK: '✅', DEGRADED: '⚠️', UNAVAILABLE: '⛔' } as const;
const TF_LABEL: Record<string, string> = { '15': '15m', '60': '1j' };

/** Ratios below 0.1 keep 3 decimals so e.g. 0.003× is not shown as "0×". */
function formatRatio(ratio: Dec): string {
  return `${formatNumber(ratio, ratio.lt(0.1) ? 3 : 2)}×`;
}

/** Value with a ⚠ marker when the indicator is less reliable. */
function mark<T>(r: Reading<T>, text: string): string {
  return r.reliability === 'kurang_andal' ? `${text} ⚠` : text;
}

function priceReading(r: Reading<Dec>): string {
  return r.value ? mark(r, formatPrice(r.value)) : '-';
}

function trendSection(t: TrendAnalysis, title: string): string[] {
  const label = TF_LABEL[t.timeframe] ?? `${t.timeframe}m`;
  if (t.unavailableReason) return [`${title} (${label})`, `Tidak tersedia: ${t.unavailableReason}`];
  const lines = [
    `${title} (${label}) · ${t.candleCount} candle final`,
    `EMA9 ${priceReading(t.ema9)} · EMA20 ${priceReading(t.ema20)} · EMA50 ${priceReading(t.ema50)}`,
    `Susunan: ${t.stack.value ? mark(t.stack, stackLabel(t.stack.value)) : `- (${t.stack.notes.join('; ')})`}`,
  ];
  if (t.closeVsEma20Pct || t.closeVsEma50Pct) {
    lines.push(
      `Close vs EMA20 ${t.closeVsEma20Pct ? formatSignedPercent(t.closeVsEma20Pct) : '-'} · vs EMA50 ${t.closeVsEma50Pct ? formatSignedPercent(t.closeVsEma50Pct) : '-'}`,
    );
  }
  if (t.ema20SlopePct.value) lines.push(`Kemiringan EMA20 (4 candle): ${formatSignedPercent(t.ema20SlopePct.value)}`);
  lines.push(
    t.crossover
      ? `Persilangan EMA9/EMA20: ${t.crossover.direction === 'ke_atas' ? 'ke atas' : 'ke bawah'}, ${t.crossover.candlesAgo === 0 ? 'di candle terakhir' : `${t.crossover.candlesAgo} candle lalu`}`
      : 'Persilangan EMA9/EMA20: tidak ada dalam 3 candle terakhir',
  );
  lines.push(
    t.rsi14.value
      ? `RSI14 ${mark(t.rsi14, formatNumber(t.rsi14.value, 1))} — ${t.rsiLabel}`
      : `RSI14 tidak tersedia: ${t.rsi14.notes.join('; ')}`,
  );
  return lines;
}

function levelLine(l: LevelDistance, index: number, timeZone: string): string {
  const z = l.zone;
  const range = z.low.eq(z.high) ? formatPrice(z.low) : `${formatPrice(z.low)}–${formatPrice(z.high)}`;
  const atr = l.distanceAtr ? `${formatNumber(l.distanceAtr, 2)} ATR` : '- ATR';
  return (
    `${index + 1}. ${range} · ${z.touches} sentuhan · ${formatPercent(l.distancePct)} · ${atr} · ` +
    `pivot terakhir ${formatShortDateTime(z.lastPivotAt, timeZone)} (${z.freshness === 'baru' ? 'baru terkonfirmasi' : 'zona lama'})`
  );
}

/** Detailed /analyze message. Descriptive only — never a trading instruction. */
export function analysisMessage(a: TechnicalAnalysis, now: Date, timeZone: string): string {
  const header = [`ANALISIS TEKNIKAL — ${formatPair(a.pair)}`, `${formatDateTime(now, timeZone)} · Data ${STATUS_ICON[a.status]} ${a.status}`];

  if (a.status === 'UNAVAILABLE' || !a.main) {
    return [...header, '', 'Analisis tidak tersedia:', ...a.unavailableReasons.map((r) => `• ${r}`), '', DISCLAIMER].join('\n');
  }

  const m = a.main;
  const lines = [...header];
  if (m.lastCandleOpen && m.close) {
    lines.push(`Candle final terakhir ${formatTime(m.lastCandleOpen, timeZone)} · close ${formatPrice(m.close)}`);
  }
  if (a.livePrice) lines.push(`Harga live ${formatPrice(a.livePrice)} (belum terkonfirmasi, tidak dipakai indikator)`);

  lines.push('', ...trendSection(m, 'TREN'));
  if (a.trend) lines.push('', ...trendSection(a.trend, 'KONFIRMASI TREN'));

  const v = a.volatility;
  if (v) {
    lines.push('', 'VOLATILITAS');
    lines.push(
      v.atr14.value
        ? `ATR14 ${mark(v.atr14, formatPrice(v.atr14.value))}${v.atr14Pct ? ` (${formatPercent(v.atr14Pct)})` : ''} · ATR candle bertransaksi ${priceReading(v.atr14Traded)}`
        : `ATR14 tidak tersedia: ${v.atr14.notes.join('; ')}`,
    );
  }

  const vol = a.volume;
  if (vol?.stats) {
    const s = vol.stats;
    const unit = a.pair.split('_')[0]!.toUpperCase();
    lines.push('', 'VOLUME');
    lines.push(
      `Candle terakhir ${formatNumber(s.current, 4)} ${unit} · MA20 ${formatNumber(s.ma, 4)} ${unit} → ` +
        (vol.ratio.value ? `${mark(vol.ratio, formatRatio(vol.ratio.value))} (${vol.label})` : 'rasio tidak tersedia'),
    );
    lines.push(
      `MA20 candle bertransaksi ${s.maTraded ? `${formatNumber(s.maTraded, 4)} ${unit}` : '-'} → ${s.ratioTraded ? formatRatio(s.ratioTraded) : '-'} · ${s.zeroCount}/${s.window} candle tanpa transaksi`,
    );
  }

  const ob = a.orderBook;
  if (ob) {
    lines.push('', 'ORDER BOOK');
    if (ob.bands.length === 0) lines.push('Tidak tersedia');
    else {
      lines.push(ob.bands.map((b) => `±${b.pct}%: ${b.imbalance ? formatSignedRatio(b.imbalance) : '-'} (${pressureLabel(b.pressure)})`).join(' · '));
      lines.push(
        `Trade 60m: ${ob.tradeBuyRatio ? `beli ${formatPercent(ob.tradeBuyRatio.times(100), 0)} (${pressureLabel(ob.tradeFlow)})` : 'tidak ada trade'}` +
          (ob.consistent === false ? ' — berlawanan dengan order book' : ob.consistent ? ' — searah' : ''),
      );
    }
  }

  const lv = a.levels;
  if (lv) {
    lines.push('', 'SUPPORT');
    lines.push(...(lv.supports.length ? lv.supports.map((l, i) => levelLine(l, i, timeZone)) : ['-']));
    lines.push('RESISTANCE');
    lines.push(...(lv.resistances.length ? lv.resistances.map((l, i) => levelLine(l, i, timeZone)) : ['-']));
    if (lv.inside.length) lines.push(`Harga berada di dalam zona ${lv.inside.map((z) => `${formatPrice(z.low)}–${formatPrice(z.high)}`).join(', ')}`);
    const ref: string[] = [];
    if (lv.rangeLow && lv.rangeHigh) ref.push(`range 24j candle ${formatPrice(lv.rangeLow)}–${formatPrice(lv.rangeHigh)}`);
    if (lv.low24h && lv.high24h) ref.push(`ticker 24j ${formatPrice(lv.low24h)}–${formatPrice(lv.high24h)}`);
    if (ref.length) lines.push(`Referensi: ${ref.join(' · ')}`);
  }

  const reliabilityNotes = collectReliabilityNotes(a);
  if (reliabilityNotes.length) lines.push('', '⚠ Catatan keandalan:', ...reliabilityNotes.map((n) => `• ${n}`));
  if (a.dataWarnings.length) lines.push('', 'Peringatan data:', ...a.dataWarnings.map((w) => `• ${w}`));
  lines.push('', DISCLAIMER);
  return lines.join('\n');
}

function collectReliabilityNotes(a: TechnicalAnalysis): string[] {
  const notes: string[] = [];
  const add = (name: string, r: { reliability: string; notes: string[] } | undefined | null) => {
    if (r && r.reliability === 'kurang_andal') notes.push(`${name}: ${r.notes.join('; ')}`);
  };
  for (const t of [a.main, a.trend]) {
    if (!t || t.unavailableReason) continue;
    const tf = TF_LABEL[t.timeframe] ?? t.timeframe;
    add(`EMA9 ${tf}`, t.ema9);
    add(`EMA20 ${tf}`, t.ema20);
    add(`EMA50 ${tf}`, t.ema50);
    add(`RSI14 ${tf}`, t.rsi14);
  }
  add('ATR14', a.volatility?.atr14);
  add('Rasio volume', a.volume?.ratio);
  add('Order book', a.orderBook);
  return notes;
}

/** One-line indicator summary for /watchlist. */
export function analysisSummaryLine(a: TechnicalAnalysis): string | null {
  if (a.status === 'UNAVAILABLE' || !a.main) return null;
  const stack = (t: TrendAnalysis | null) => (t && !t.unavailableReason && t.stack.value ? mark(t.stack, t.stack.value) : '-');
  const rsi = a.main.rsi14.value ? mark(a.main.rsi14, formatNumber(a.main.rsi14.value, 1)) : '-';
  const ratio = a.volume?.ratio.value ? mark(a.volume.ratio, formatRatio(a.volume.ratio.value)) : '-';
  return `Indikator: tren 15m ${stack(a.main)} · 1j ${stack(a.trend)} · RSI ${rsi} · vol ${ratio}`;
}
