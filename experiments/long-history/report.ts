/**
 * Long-history report: walk-forward selection (train 12 → test 3 months),
 * default-parameter results, per pair / market phase / fold / sub-period.
 * Reads reports/raw/*.json and the development dataset only.
 *
 *   pnpm exec tsx experiments/long-history/report.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../../src/app/config/defaults.js';
import { Dec } from '../../src/app/decimal.js';
import { computeMetrics, type Metrics } from '../../src/backtest/metrics.js';
import { DEFAULT_COMBO_ID, tradesIn, type Period } from '../../src/backtest/walk-forward.js';
import { formatIdr, formatPercent } from '../../src/bot/messages/format.js';
import { buyCostRate, resolveCosts, sellCostRate } from '../../src/risk/costs.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import type { ExpTrade } from '../m4-followup/lib/sim.js';
import { ALL_PAIRS, COMPARISON, DEV_START, HOLDOUT_START, LONG_DATA_DIR, LONG_REPORT_DIR, PHASE_THRESHOLD_PCT, WF } from './config.js';
import { DEV, loadDevSeries, monthBlocks, monthKey, monthlyPhases, walkForwardFolds, type Phase } from './lib/periods.js';
import { tradeFromJson, type RawRun, type RawVariant } from './lib/serialize.js';

const TZ = DEFAULT_SETTINGS.timezone;
const capital = defaultStrategySettings().limits.capital;
const FAMILIES = ['baseline-15m1j', 'pullback-1j4j', 'bo-konfirmasi', 'bo-retest'] as const;
const FAMILY_LABEL: Record<string, string> = {
  'baseline-15m1j': 'Baseline produksi (pullback 15m/1j)',
  'pullback-1j4j': 'Pullback 1j + konfirmasi 4j',
  'bo-konfirmasi': 'Breakout + konfirmasi (1j/4j)',
  'bo-retest': 'Breakout + retest (1j/4j)',
};
const DEFAULT_PARAM: Record<string, string> = { 'baseline-15m1j': DEFAULT_COMBO_ID, 'pullback-1j4j': DEFAULT_COMBO_ID, 'bo-konfirmasi': 'res-ext0.5', 'bo-retest': 'res-ext0.5' };
const COSTS = ['C0_produksi', 'C1_taker', 'C2_maker_ideal', 'C3_campuran'] as const;
const COST_LABEL: Record<string, string> = { C0_produksi: 'C0 produksi', C1_taker: 'C1 taker', C2_maker_ideal: 'C2 maker ideal*', C3_campuran: 'C3 campuran' };

// ------------------------------------------------------------------ load
interface V extends Omit<RawVariant, 'trades' | 'signalTimes'> {
  universe: string;
  trades: ExpTrade[];
  signalTimes: Date[];
}
const variants: V[] = [];
const runInfo: string[] = [];
for (const u of ['fokus', 'semua']) {
  for (const tf of ['15', '60']) {
    const path = join(LONG_REPORT_DIR, 'raw', `${u}-${tf}.json`);
    if (!existsSync(path)) throw new Error(`${path} belum ada: jalankan run.ts --universe ${u} --tf ${tf}`);
    const run = JSON.parse(readFileSync(path, 'utf8')) as RawRun;
    runInfo.push(`${u} ${run.tf}: ${run.variants.length} varian, ${(run.seconds / 60).toFixed(0)} menit`);
    for (const v of run.variants) {
      variants.push({ ...v, universe: u, trades: v.trades.map(tradeFromJson), signalTimes: v.signalTimes.map((s) => new Date(s)) });
    }
  }
}
for (const v of variants) {
  for (const t of v.trades) if (t.decisionAt < DEV.start || t.exitAt > HOLDOUT_START) throw new Error(`Trade di luar periode pengembangan: ${v.id}`);
}
const series = loadDevSeries(ALL_PAIRS);
const blocks = monthBlocks();
const folds = walkForwardFolds(blocks);
const phases = new Map(series.map((s) => [s.pair, monthlyPhases(s, blocks)]));
const manifest = JSON.parse(readFileSync(join(LONG_DATA_DIR, 'manifest.json'), 'utf8')) as {
  createdAt: string;
  pairs: Record<string, { spreadPctSample: string | null; takerFeePct: string | null; makerFeePct: string | null }>;
  quality: { pair: string; timeframe: string; firstOpen: string; lastOpen: string; count: number; expected: number; duplicatesReturned: number; misaligned: number; invalidOhlc: number; missingIntervals: number; zeroVolumePct: number; longestZeroRun: number; droppedAtBoundary: number }[];
};

// ------------------------------------------------------------------ helpers
const out: string[] = [];
const log = (l = '') => {
  out.push(l);
  console.log(l);
};
const h = (t: string) => log(`\n## ${t}\n`);
const idr = (v: Dec | null) => (v === null ? 'n/a' : v.lt(0) ? `−${formatIdr(v.abs().toDecimalPlaces(0))}` : formatIdr(v.toDecimalPlaces(0)));
const n2 = (v: Dec | number | null) => (v === null ? 'n/a' : (typeof v === 'number' ? v : v.toNumber()).toFixed(2));
const M = (t: ExpTrade[]) => computeMetrics(t, capital, TZ);
const pf = (x: Metrics) => (x.trades === 0 ? 'n/a' : x.profitFactor === null ? 'n/a (tanpa rugi)' : n2(x.profitFactor));
const inP = (d: Date, p: Period) => d >= p.start && d < p.end;
const get = (u: string, family: string, paramId: string, cost: string) => {
  const v = variants.find((x) => x.universe === u && x.family === family && x.paramId === paramId && x.costId === cost);
  if (!v) throw new Error(`varian ${u} ${family} ${paramId} ${cost} tidak ada`);
  return v;
};
const familyVariants = (u: string, family: string, cost: string) => variants.filter((x) => x.universe === u && x.family === family && x.costId === cost);

interface Slice {
  signals: number;
  trades: ExpTrade[];
}
const slice = (v: V, p: Period): Slice => ({ signals: v.signalTimes.filter((d) => inP(d, p)).length, trades: tradesIn(v.trades, p) as ExpTrade[] });

const METRIC_HEAD = [
  '| | Sinyal | Trade | Win rate | Expectancy bersih (IDR · R, 95% CI) | Profit factor | Max drawdown | Fee | Pajak | Slippage |',
  '|---|---:|---:|---:|---|---:|---:|---:|---:|---:|',
];
function metricRow(label: string, s: Slice): string {
  const x = M(s.trades);
  if (x.trades === 0) return `| ${label} | ${s.signals} | 0 | – | tidak dapat dihitung (0 trade) | – | – | – | – | – |`;
  const ci = x.expectancyRCi95 ? ` [${x.expectancyRCi95[0].toFixed(2)}…${x.expectancyRCi95[1].toFixed(2)}]` : '';
  const small = x.trades < 30 ? ' ⚠' : '';
  return `| ${label} | ${s.signals} | ${x.trades}${small} | ${formatPercent(x.winRatePct!, 0)} | ${idr(x.expectancyIdr)} · ${n2(x.expectancyR)} R${ci} | ${pf(x)} | ${idr(x.maxDrawdownIdr)} (${formatPercent(x.maxDrawdownPct)}) | ${idr(x.totalFees)} | ${idr(x.totalTaxes)} | ${idr(x.totalSlippage)} |`;
}
const short = (s: Slice) => {
  const x = M(s.trades);
  return x.trades === 0 ? `${s.signals} sin · 0 tr` : `${x.trades} tr · ${n2(x.expectancyR)} R`;
};

/** Walk-forward per (universe, family, cost): choose on train only, evaluate on the next test window. */
function walkForward(u: string, family: string, cost: string) {
  const cands = familyVariants(u, family, cost);
  const rows = folds.map((f) => {
    const scored = cands.map((v) => {
      const t = tradesIn(v.trades, f.train);
      return { v, n: t.length, r: t.length ? M(t as ExpTrade[]).expectancyR! : null };
    });
    const eligible = scored.filter((s) => s.n >= WF.minTrades && s.r !== null);
    eligible.sort((a, b) => b.r!.comparedTo(a.r!) || (a.v.paramId === DEFAULT_PARAM[family] ? -1 : 0) || a.v.paramId.localeCompare(b.v.paramId));
    const chosen = eligible[0]?.v ?? get(u, family, DEFAULT_PARAM[family]!, cost);
    return { fold: f, chosen: chosen.paramId, byDefault: eligible.length === 0, train: slice(chosen, f.train), test: slice(chosen, f.test) };
  });
  return { rows, oos: { signals: rows.reduce((a, r) => a + r.test.signals, 0), trades: rows.flatMap((r) => r.test.trades) } };
}
const OOS: Period = { label: 'gabungan uji walk-forward', start: folds[0]!.test.start, end: folds.at(-1)!.test.end };
const phaseOf = (t: ExpTrade): Phase => phases.get(t.pair)!.get(monthKey(t.decisionAt))?.phase ?? 'sideways';

// ------------------------------------------------------------------ report
log('# Eksperimen riwayat panjang (≈3 tahun) — DATA PENGEMBANGAN SAJA');
log(`\nDibuat ${new Date().toISOString()}. Kode produksi, parameter default, watchlist, modal, risk management, dan database **tidak diubah**. Holdout **tidak dijalankan**; tidak ada file lock.`);

h('1. Pembagian periode dan isolasi holdout');
log(`- Pemanasan indikator: candle sejak ${manifest.quality[0]!.firstOpen.slice(0, 10)}. Pengembangan: **${DEV_START.toISOString().slice(0, 10)} → ${HOLDOUT_START.toISOString().slice(0, 10)}** (${blocks.length} bulan kalender, UTC).`);
log(`- Holdout: **${HOLDOUT_START.toISOString()} → data terbaru** (≈3 bulan) — batas yang sama persis dengan eksperimen sebelumnya, konstanta tetap.`);
log('- Isolasi: (1) fetch hanya meminta candle yang tutup sebelum batas — candle holdout tidak pernah diunduh/disimpan; (2) loader mencocokkan batas & hash setiap file dengan manifest dan menolak candle yang tutup setelah batas; (3) report menolak trade di luar periode pengembangan; (4) tidak ada jalur kode holdout dan tidak ada file lock.');
log(`- Walk-forward: latih ${WF.trainMonths} bulan → uji ${WF.testMonths} bulan, geser ${WF.stepMonths} bulan, ${folds.length} fold. Di setiap fold, tiap keluarga strategi memilih parameter **hanya dari data latih** (expectancy R tertinggi, minimal ${WF.minTrades} trade; jika tidak ada → parameter default). Tiap skenario biaya dipilih terpisah.`);
log('');
log('| Fold | Latih | Uji |');
log('|---|---|---|');
for (const f of folds) log(`| ${f.label} | ${f.train.label} | ${f.test.label} |`);
log(`\nSimulasi: ${runInfo.join(' · ')}`);

h('2. Kualitas data (aktual, tanpa pengisian)');
log('| Pair | TF | Awal | Akhir (candle terakhir sebelum holdout) | Candle / diharapkan | Gap | Duplikat | Tidak sejajar | OHLC invalid | Volume 0 | Rentetan vol 0 terpanjang |');
log('|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
for (const q of manifest.quality) {
  log(`| ${q.pair}${COMPARISON.includes(q.pair) ? ' ⚠' : ''} | ${q.timeframe}m | ${q.firstOpen.slice(0, 16)} | ${q.lastOpen.slice(0, 16)} | ${q.count}/${q.expected} | ${q.missingIntervals} | ${q.duplicatesReturned} | ${q.misaligned} | ${q.invalidOhlc} | ${q.zeroVolumePct}% | ${q.longestZeroRun} |`);
}
log('\n- Indodax mengisi periode tanpa transaksi dengan candle volume 0 (harga dibawa), sehingga "gap 0" tidak berarti selalu ada perdagangan. Candle ini dipakai apa adanya (tidak dibuat ulang): tidak bisa mengisi order, tidak bisa exit.');
log('- **11–14 Sep 2024**: ±79 jam candle volume 0 di semua pair secara bersamaan → konsisten dengan penghentian perdagangan Indodax (insiden keamanan Sep 2024; tidak diverifikasi dari data ini). Posisi yang terbuka saat itu tertahan sampai perdagangan kembali.');
log('- QNT: 67% candle 15m dan 35% candle 1j tanpa transaksi. LINK: 31% candle 15m tanpa transaksi.');
log(`- Ketersediaan: data Indodax untuk keempat pair tersedia ≥ 4 tahun ke belakang (dicek); eksperimen memakai ≈3 tahun sesuai permintaan.`);

h('3. Kondisi pasar dalam periode pengembangan');
log(`Label fase per pair per bulan dari return bulanan pair itu sendiri: ≥ +${PHASE_THRESHOLD_PCT}% bullish, ≤ −${PHASE_THRESHOLD_PCT}% bearish, lainnya sideways.\n`);
log(`| Bulan | ${ALL_PAIRS.join(' | ')} |`);
log(`|---|${ALL_PAIRS.map(() => '---').join('|')}|`);
for (const b of blocks) {
  log(`| ${b.label} | ${ALL_PAIRS.map((p) => { const x = phases.get(p)!.get(b.label); return x ? `${x.phase === 'bullish' ? '▲' : x.phase === 'bearish' ? '▼' : '◆'} ${x.returnPct.toFixed(0)}%` : '–'; }).join(' | ')} |`);
}
log('');
for (const p of ALL_PAIRS) {
  const ph = [...phases.get(p)!.values()];
  const c = (k: Phase) => ph.filter((x) => x.phase === k).length;
  log(`- ${p}: ${c('bullish')} bulan bullish · ${c('bearish')} bearish · ${c('sideways')} sideways`);
}

for (const u of ['fokus', 'semua']) {
  const uLabel = u === 'fokus' ? 'DOGE + XRP (fokus)' : '4 pair (QNT & LINK = pembanding ⚠ likuiditas)';
  h(`4${u === 'fokus' ? 'a' : 'b'}. Walk-forward out-of-sample — ${uLabel} — ${OOS.start.toISOString().slice(0, 10)} → ${OOS.end.toISOString().slice(0, 10)}`);
  for (const cost of COSTS) {
    log(`\n**${COST_LABEL[cost]}**\n`);
    for (const l of METRIC_HEAD) log(l);
    for (const fam of FAMILIES) log(metricRow(FAMILY_LABEL[fam]!, walkForward(u, fam, cost).oos));
  }

  h(`5${u === 'fokus' ? 'a' : 'b'}. Parameter default tanpa tuning — ${uLabel} — seluruh pengembangan ${DEV_START.toISOString().slice(0, 10)} → ${HOLDOUT_START.toISOString().slice(0, 10)}`);
  for (const cost of COSTS) {
    log(`\n**${COST_LABEL[cost]}**\n`);
    for (const l of METRIC_HEAD) log(l);
    for (const fam of FAMILIES) log(metricRow(`${FAMILY_LABEL[fam]} (${DEFAULT_PARAM[fam]})`, slice(get(u, fam, DEFAULT_PARAM[fam]!, cost), DEV)));
  }
}

h('6. Per fold walk-forward (DOGE + XRP) — trade · expectancy R di jendela UJI, parameter terpilih');
for (const cost of COSTS) {
  log(`\n**${COST_LABEL[cost]}**\n`);
  log(`| Keluarga | ${folds.map((f) => `${f.label} ${f.test.label}`).join(' | ')} | Fold uji positif |`);
  log(`|---|${folds.map(() => '---').join('|')}|---|`);
  for (const fam of FAMILIES) {
    const wf = walkForward('fokus', fam, cost);
    const withTrades = wf.rows.filter((r) => r.test.trades.length > 0);
    const positive = withTrades.filter((r) => M(r.test.trades).expectancyR!.gt(0)).length;
    log(`| ${FAMILY_LABEL[fam]} | ${wf.rows.map((r) => `${short(r.test)}<br>${r.chosen}${r.byDefault ? ' (default)' : ''}`).join(' | ')} | ${positive}/${withTrades.length} |`);
  }
}

h('7. Hasil per pair — universe 4 pair, parameter default, seluruh pengembangan');
for (const cost of ['C0_produksi', 'C3_campuran']) {
  log(`\n**${COST_LABEL[cost]}**\n`);
  log('| Keluarga | Pair | Trade | Win rate | Expectancy (IDR · R) | PF | Max DD | Total biaya |');
  log('|---|---|---:|---:|---|---:|---:|---:|');
  for (const fam of FAMILIES) {
    const v = get('semua', fam, DEFAULT_PARAM[fam]!, cost);
    for (const p of ALL_PAIRS) {
      const t = v.trades.filter((x) => x.pair === p);
      const x = M(t);
      const tag = COMPARISON.includes(p) ? ' ⚠' : '';
      if (x.trades === 0) log(`| ${FAMILY_LABEL[fam]} | ${p}${tag} | 0 | – | tidak dapat dihitung | – | – | – |`);
      else log(`| ${FAMILY_LABEL[fam]} | ${p}${tag} | ${x.trades}${x.trades < 30 ? ' ⚠' : ''} | ${formatPercent(x.winRatePct!, 0)} | ${idr(x.expectancyIdr)} · ${n2(x.expectancyR)} R | ${pf(x)} | ${idr(x.maxDrawdownIdr)} | ${idr(x.totalFees.plus(x.totalTaxes).plus(x.totalSlippage))} |`);
    }
  }
}
log('\nSinyal dihitung per portofolio (satu slot posisi dipakai bersama), sehingga tidak dipecah per pair; jumlah trade per pair dipengaruhi pair lain yang lebih dulu mengambil slot.');

h('8. Hasil per kondisi pasar (fase bulanan pair saat keputusan) — DOGE + XRP, parameter default, seluruh pengembangan');
log('Regime engine saat keputusan selalu BULLISH untuk setiap trade (syarat G2), sehingga pembagian memakai fase bulanan pair (bagian 3).\n');
for (const cost of ['C0_produksi', 'C3_campuran']) {
  log(`\n**${COST_LABEL[cost]}**\n`);
  log('| Keluarga | Bullish | Sideways | Bearish |');
  log('|---|---|---|---|');
  for (const fam of FAMILIES) {
    const v = get('fokus', fam, DEFAULT_PARAM[fam]!, cost);
    log(`| ${FAMILY_LABEL[fam]} | ${(['bullish', 'sideways', 'bearish'] as Phase[]).map((ph) => { const x = M(v.trades.filter((t) => phaseOf(t) === ph)); return x.trades ? `${x.trades} tr · win ${formatPercent(x.winRatePct!, 0)} · ${n2(x.expectancyR)} R · PF ${pf(x)}` : '0 tr · n/a'; }).join(' | ')} |`);
  }
}

h('9. Stabilitas antarperiode — DOGE + XRP, parameter default (trade · expectancy R per setengah tahun)');
const halves: Period[] = [];
for (let y = 2024; y <= 2026; y++) {
  for (const [a, b] of [[0, 6], [6, 12]] as const) {
    const start = new Date(Date.UTC(y, a, 1));
    const end = new Date(Math.min(Date.UTC(y, b, 1), HOLDOUT_START.getTime()));
    if (start < HOLDOUT_START) halves.push({ label: `${y}-${a === 0 ? 'H1' : 'H2'}${end.getTime() < Date.UTC(y, b, 1) ? ' (s.d. 1 Agu)' : ''}`, start, end });
  }
}
for (const cost of ['C0_produksi', 'C3_campuran']) {
  log(`\n**${COST_LABEL[cost]}**\n`);
  log(`| Keluarga | ${halves.map((p) => p.label).join(' | ')} |`);
  log(`|---|${halves.map(() => '---').join('|')}|`);
  for (const fam of FAMILIES) {
    const v = get('fokus', fam, DEFAULT_PARAM[fam]!, cost);
    log(`| ${FAMILY_LABEL[fam]} | ${halves.map((p) => short(slice(v, p))).join(' | ')} |`);
  }
}

h('10. Diagnostik breakout — DOGE + XRP, parameter default, C0, seluruh pengembangan');
const FALSE_N = 4;
log(`False breakout = close 1j kembali ≤ puncak zona dalam ${FALSE_N} candle setelah candle breakout.\n`);
log('| Keluarga | Sinyal | Tidak terisi / dibatalkan | Trade | False breakout | Exp R (false / bertahan) | Exit |');
log('|---|---:|---|---:|---:|---|---|');
for (const fam of ['bo-konfirmasi', 'bo-retest']) {
  const v = get('fokus', fam, DEFAULT_PARAM[fam]!, 'C0_produksi');
  const isFalse = (t: ExpTrade) => {
    const cs = series.find((s) => s.pair === t.pair)!.c60;
    const i = cs.findIndex((c) => c.openTime.getTime() === t.breakoutOpenTime!.getTime());
    return cs.slice(i + 1, i + 1 + FALSE_N).some((c) => c.close.lte(t.zoneHigh!));
  };
  const z = v.trades.filter((t) => t.zoneHigh && t.breakoutOpenTime);
  const fb = z.filter(isFalse);
  const ok = z.filter((t) => !isFalse(t));
  const x = M(v.trades);
  const cancels = Object.entries(v.cancelled).map(([k, c]) => `${k}: ${c}`).join('; ');
  log(`| ${FAMILY_LABEL[fam]} | ${v.signals} | kedaluwarsa ${v.expiredUnfilled}${cancels ? ` (${cancels})` : ''} | ${v.trades.length} | ${z.length ? `${fb.length}/${z.length} (${formatPercent(new Dec(fb.length).div(z.length).times(100), 0)})` : 'n/a'} | ${fb.length ? n2(M(fb).expectancyR) : 'n/a'} / ${ok.length ? n2(M(ok).expectancyR) : 'n/a'} | ${Object.entries(x.exits).map(([k, c]) => `${k} ${c}`).join(', ') || '–'} |`);
}

h('11. Sensitivitas parameter (seluruh pengembangan, DOGE + XRP, C0) — untuk transparansi, bukan untuk memilih');
log('| Keluarga | Parameter | Sinyal | Trade | Expectancy R | PF | Total bersih |');
log('|---|---|---:|---:|---:|---:|---:|');
for (const fam of FAMILIES) {
  for (const v of familyVariants('fokus', fam, 'C0_produksi')) {
    const x = M(v.trades);
    log(`| ${FAMILY_LABEL[fam]} | ${v.paramId}${v.paramId === DEFAULT_PARAM[fam] ? ' (default)' : ''} | ${v.signals} | ${x.trades} | ${x.trades ? n2(x.expectancyR) : 'n/a'} | ${pf(x)} | ${x.trades ? idr(x.totalNet) : 'n/a'} |`);
  }
}

h('12. Pembanding pasif: buy & hold per setengah tahun (biaya C0)');
const c0 = resolveCosts();
log(`| Pair | ${halves.map((p) => p.label).join(' | ')} | Seluruh pengembangan |`);
log(`|---|${halves.map(() => '---:').join('|')}|---:|`);
for (const s of series) {
  const bh = (p: Period) => {
    const cs = s.c60.filter((c) => inP(c.openTime, p));
    if (!cs.length) return 'n/a';
    const cost = cs[0]!.open.times(Dec.add(1, buyCostRate(c0)));
    return formatPercent(cs.at(-1)!.close.times(Dec.sub(1, sellCostRate(c0))).minus(cost).div(cost).times(100), 0);
  };
  log(`| ${s.pair} | ${halves.map(bh).join(' | ')} | ${bh(DEV)} |`);
}

h('13. Asumsi dan keterbatasan');
const fee = Object.values(manifest.pairs)[0]!;
for (const l of [
  `**Biaya (ASUMSI):** C0 = fee 0,20% + pajak 0,11% per sisi (default produksi, pajak belum terverifikasi). Fee taker ${fee.takerFeePct}% / maker ${fee.makerFeePct}% dari Indodax /api/pairs per ${manifest.createdAt.slice(0, 10)} — tarif saat ini, belum diverifikasi dengan bukti transaksi, dan tarif historis 2024–2026 bisa berbeda. *C2 = semua leg maker: batas atas yang tidak realistis (SL dan market order tidak bisa maker). C3: maker hanya untuk entry limit yang benar-benar menunggu di bawah ask dan untuk TP; sizing dan R/R tetap memakai taker.`,
  `**Spread (ASUMSI):** spread historis TIDAK tersedia. Dipakai satu sampel live per pair (${Object.entries(manifest.pairs).map(([p, v]) => `${p} ${Number(v.spreadPctSample).toFixed(2)}%`).join(', ')}, diambil ${manifest.createdAt.slice(0, 16)}), dianggap konstan selama 2,5 tahun. Spread nyata saat volatil hampir pasti lebih lebar.`,
  '**Order book (ASUMSI):** order book dan arus trade historis TIDAK tersedia: syarat G8 dinetralkan, batas kedalaman order book tidak diterapkan, slippage SL hanya nilai minimum 0,15%. Hasil cenderung optimistis.',
  '**Fill (ESTIMASI):** limit dianggap terisi bila harga diperdagangkan di bawah limit dan volume candle ≥ jumlah order — tidak membuktikan antrean order terisi. Entry market breakout di open 15m berikutnya + setengah spread + slippage 0,15% (ASUMSI). SL dianggap lebih dulu bila SL & TP tersentuh di candle yang sama; gap melewati SL keluar di harga open.',
  '**Survivorship bias:** 4 pair dipilih hari ini dan masih aktif; pair yang di-delist atau gagal selama 2023–2026 tidak ada dalam uji. Pemilihan DOGE/XRP sebagai fokus juga dilakukan setelah melihat likuiditasnya saat ini.',
  `**Multiple testing:** ${variants.length} varian disimulasikan. Walk-forward mengurangi tetapi tidak menghilangkan bias pemilihan; peringkat antarvarian di bagian 11 tidak boleh dipakai untuk memilih.`,
  '**Sampel:** jumlah trade per keluarga kecil (lihat tanda ⚠ untuk < 30 trade); interval kepercayaan expectancy lebar.',
  'Periode Sep 2024 (penghentian perdagangan) dan pasar 2024–2026 adalah satu sejarah; tidak ada jaminan berulang.',
  '**Backtest ini TIDAK menyimpulkan bahwa strategi mana pun profitable.**',
]) log(`- ${l}`);

mkdirSync(LONG_REPORT_DIR, { recursive: true });
const path = join(LONG_REPORT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(path, out.join('\n'));
console.error(`\nLaporan: ${path}`);
