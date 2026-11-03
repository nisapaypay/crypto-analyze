/**
 * Walk-forward backtest of the Milestone 4 strategy on downloaded history.
 * No network, no database: reads data/backtest/*.json (pnpm backtest:fetch).
 *
 *   pnpm backtest                    # development (walk-forward) + locked holdout
 *   pnpm backtest --skip-holdout     # development only; the holdout stays unseen
 *   pnpm backtest --reset-holdout    # re-run the holdout with different parameters (reported as contaminated)
 *   pnpm backtest qnt doge           # subset of pairs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toJsonSafe } from '../src/analysis/types.js';
import { DEFAULT_SETTINGS, DEFAULT_WATCHLIST } from '../src/app/config/defaults.js';
import { Dec } from '../src/app/decimal.js';
import { buyAndHoldPct, randomEntryBaseline } from '../src/backtest/baseline.js';
import { BACKTEST_DIR, fromRows, loadSeries, pairInfoFromMeta } from '../src/backtest/dataset.js';
import { computeMetrics } from '../src/backtest/metrics.js';
import { BACKTEST_CAVEATS, metricLines } from '../src/backtest/report.js';
import { simulate, type PairSeries, type SimTrade } from '../src/backtest/simulator.js';
import {
  checkHoldoutLock,
  DEFAULT_COMBO_ID,
  hash,
  holdoutDataHash,
  parameterGrid,
  planPeriods,
  selectCombo,
  truncateSeries,
  walkForward,
  writeHoldoutLock,
} from '../src/backtest/walk-forward.js';
import { formatPercent } from '../src/bot/messages/format.js';
import { resolveCosts } from '../src/risk/costs.js';
import { defaultStrategySettings } from '../src/strategy/settings.js';

const args = process.argv.slice(2);
const skipHoldout = args.includes('--skip-holdout');
const resetHoldout = args.includes('--reset-holdout');
const requested = args.filter((a) => !a.startsWith('--'));
const TZ = DEFAULT_SETTINGS.timezone;
const LOCK_PATH = join(BACKTEST_DIR, 'holdout-lock.json');

const settings = defaultStrategySettings();
const costs = resolveCosts();
const out: string[] = [];
const log = (line = '') => {
  out.push(line);
  console.log(line);
};

const pairs = (requested.length ? requested : [...DEFAULT_WATCHLIST]).map((p) => (p.includes('_') ? p : `${p.toLowerCase()}_idr`));
const series: PairSeries[] = pairs.map((pair) => {
  const s15 = loadSeries(pair, '15');
  const s60 = loadSeries(pair, '60');
  return {
    pair,
    info: pairInfoFromMeta(s15.meta),
    spreadPct: new Dec(s15.meta.spreadPctSample ?? '0.3'),
    c15: fromRows(pair, '15', s15.candles),
    c60: fromRows(pair, '60', s60.candles),
  };
});
const periods = planPeriods(series);
const grid = parameterGrid();
const capital = settings.limits.capital;
const simBase = {
  costs,
  limits: settings.limits,
  maxAllocPct: settings.maxAllocPct,
  activeHours: settings.activeHours,
  timeZone: TZ,
};
const day = (d: Date) => d.toISOString().slice(0, 10);
const byKey = (trades: SimTrade[], key: (t: SimTrade) => string) => {
  const m = new Map<string, SimTrade[]>();
  for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
};
const section = (title: string) => log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`);
const breakdown = (trades: SimTrade[]) => {
  log('Per pair:');
  for (const s of series) {
    log(` ${s.pair}`);
    for (const l of metricLines(computeMetrics(trades.filter((t) => t.pair === s.pair), capital, TZ), '   ')) log(l);
  }
  log('Per market regime (saat keputusan):');
  for (const [regime, t] of byKey(trades, (x) => x.regime)) {
    log(` ${regime}`);
    for (const l of metricLines(computeMetrics(t, capital, TZ), '   ')) log(l);
  }
};

section('BACKTEST MILESTONE 4 — STRATEGY & RISK ENGINE (estimasi historis, bukan jaminan)');
log(`Pair: ${pairs.join(', ')} · data ${day(series[0]!.c15[0]!.openTime)} → ${day(series[0]!.c15.at(-1)!.openTime)} (15m + 1j asli)`);
log(`Modal Rp5.000.000 · risiko/trade 0,5% · batas harian 1,5% · maks 3 sinyal/hari · 1 posisi · jam ${settings.activeHours.start}–${settings.activeHours.end} WIB`);
log(`Biaya: fee ${formatPercent(costs.buyFeePct)}/${formatPercent(costs.sellFeePct)} · pajak ${formatPercent(costs.buyTaxPct)}/${formatPercent(costs.sellTaxPct)} (belum terverifikasi) · slippage SL ≥${formatPercent(costs.stopSlippagePct)}`);
log(`Spread asumsi (sampel live): ${series.map((s) => `${s.pair} ${formatPercent(s.spreadPct)}`).join(' · ')}`);
log(`Periode: ${periods.blocks.map((b) => `${b.label} ${day(b.start)}`).join(' · ')}`);
log(`Pengembangan: ${day(periods.development.start)} → ${day(periods.development.end)} · Holdout: ${day(periods.holdout.start)} → ${day(periods.holdout.end)}`);
log(`Grid parameter (8): ${grid.map((g) => g.id).join(', ')} · default ${DEFAULT_COMBO_ID}`);

// ---- 1. Development: the holdout candles are physically removed. ----
const devSeries = truncateSeries(series, periods.holdout.start);
let t0 = Date.now();
const dev = simulate({
  ...simBase,
  series: devSeries,
  combos: grid,
  start: periods.development.start,
  end: periods.development.end,
  rejectionsFor: DEFAULT_COMBO_ID,
  onProgress: (at) => {
    if (at.getUTCDate() === 1) process.stderr.write(`  simulasi pengembangan: ${day(at)}\n`);
  },
});
const devSeconds = ((Date.now() - t0) / 1000).toFixed(0);

section(`1. PENGEMBANGAN — parameter default (${DEFAULT_COMBO_ID}), ${periods.development.label} · ${devSeconds} dtk`);
const devDefault = dev.find((r) => r.combo === DEFAULT_COMBO_ID)!;
log(`Sinyal BUY ${devDefault.signals} · tidak terisi (kedaluwarsa) ${devDefault.expiredUnfilled} · trade ${devDefault.trades.length}`);
for (const l of metricLines(computeMetrics(devDefault.trades, capital, TZ))) log(l);
breakdown(devDefault.trades);
log('Penolakan per syarat (pair × langkah 15m dalam jam aktif, satu langkah bisa gagal beberapa syarat):');
for (const [k, v] of Object.entries(devDefault.rejections).sort((a, b) => b[1] - a[1])) log(`  ${k}: ${v}`);

section('2. WALK-FORWARD (latih 4 bulan → uji 1 bulan berikutnya, min 30 trade untuk memilih)');
const folds = walkForward(dev, periods.blocks, 9);
const wfTrades: SimTrade[] = [];
for (const f of folds) {
  wfTrades.push(...f.testTrades);
  log(`Fold latih ${f.train.label} → uji ${f.test.label}: pilih ${f.chosen} (${f.reason})`);
  for (const l of metricLines(computeMetrics(f.testTrades, capital, TZ), '   ')) log(l);
}
log('Gabungan seluruh bulan uji walk-forward (out-of-sample bergulir):');
for (const l of metricLines(computeMetrics(wfTrades, capital, TZ))) log(l);
log('Semua kombinasi grid pada seluruh periode pengembangan (untuk transparansi):');
for (const r of dev) {
  const m = computeMetrics(r.trades, capital, TZ);
  log(`  ${r.combo}: ${m.trades} trade · expectancy ${m.expectancyR ? m.expectancyR.toFixed(3) : '-'} R · total ${m.totalNet.toDecimalPlaces(0).toFixed()}`);
}

// ---- 2. Final parameters, chosen BEFORE the holdout is loaded. ----
const final = selectCombo(dev, periods.development);
const finalCombo = grid.find((g) => g.id === final.combo)!;
section(`3. PARAMETER FINAL: ${final.combo} — ${final.reason}`);

// ---- 3. Holdout (locked). ----
let holdoutTrades: SimTrade[] = [];
let holdoutStatus = 'tidak dijalankan (--skip-holdout)';
if (!skipHoldout) {
  const paramsHash = hash({ combo: final.combo, cfg: finalCombo.cfg, costs: toJsonSafe(costs), limits: toJsonSafe(settings.limits) });
  const dataHash = holdoutDataHash(series, periods.holdout);
  const lock = checkHoldoutLock(LOCK_PATH, paramsHash, dataHash, resetHoldout);
  if (!lock.ok) {
    holdoutStatus = `DITOLAK: ${lock.reason}`;
  } else {
    t0 = Date.now();
    const [h] = simulate({ ...simBase, series, combos: [finalCombo], start: periods.holdout.start, end: periods.holdout.end });
    holdoutTrades = h!.trades;
    holdoutStatus = `${lock.firstRun ? 'evaluasi pertama' : 'pengulangan dengan parameter & data yang sama'}${lock.contaminated ? ' — TERKONTAMINASI (parameter berubah setelah holdout dilihat)' : ''} · ${((Date.now() - t0) / 1000).toFixed(0)} dtk`;
    if (lock.firstRun) {
      writeHoldoutLock(LOCK_PATH, {
        createdAt: new Date().toISOString(),
        combo: final.combo,
        paramsHash,
        dataHash,
        period: { start: periods.holdout.start.toISOString(), end: periods.holdout.end.toISOString() },
      });
    }
    section(`4. HOLDOUT ${periods.holdout.label} — ${holdoutStatus}`);
    log(`Sinyal BUY ${h!.signals} · tidak terisi ${h!.expiredUnfilled} · trade ${holdoutTrades.length}`);
    for (const l of metricLines(computeMetrics(holdoutTrades, capital, TZ))) log(l);
    breakdown(holdoutTrades);
  }
}
if (skipHoldout || holdoutTrades.length === 0) log(`Holdout: ${holdoutStatus}`);

section('5. PEMBANDING (biaya sama)');
for (const s of series) {
  const devBh = buyAndHoldPct(s, periods.development, costs);
  const hoBh = buyAndHoldPct(s, periods.holdout, costs);
  log(`${s.pair}: buy & hold pengembangan ${devBh ? formatPercent(devBh) : '-'} · holdout ${skipHoldout ? '(tidak dilihat)' : hoBh ? formatPercent(hoBh) : '-'}`);
}
const strategyByPair = new Map(byKey(devDefault.trades, (t) => t.pair));
for (const s of series) {
  const n = strategyByPair.get(s.pair)?.length ?? 0;
  const runs = randomEntryBaseline(s, periods.development, Math.max(n, 30), grid[0]!.cfg, costs, { seeds: 20, timeZone: TZ, activeHours: settings.activeHours });
  if (runs.length === 0) continue;
  const sorted = [...runs].sort((a, b) => a - b);
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  log(`${s.pair}: entry acak (${Math.max(n, 30)} trade × 20 seed, SL/TP/biaya sama) → rata-rata ${avg.toFixed(3)} R (seed ${sorted[0]!.toFixed(3)} … ${sorted.at(-1)!.toFixed(3)})`);
}

section('KETERBATASAN DAN KESIMPULAN');
for (const c of BACKTEST_CAVEATS) log(`• ${c}`);

const reportPath = join(BACKTEST_DIR, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
writeFileSync(reportPath, out.join('\n'));
writeFileSync(
  reportPath.replace('.txt', '.json'),
  JSON.stringify(
    toJsonSafe({
      periods,
      final,
      holdoutStatus,
      development: dev.map((r) => ({ combo: r.combo, signals: r.signals, expired: r.expiredUnfilled, metrics: computeMetrics(r.trades, capital, TZ) })),
      walkForward: folds.map((f) => ({ train: f.train, test: f.test, chosen: f.chosen, reason: f.reason, metrics: computeMetrics(f.testTrades, capital, TZ) })),
      holdout: computeMetrics(holdoutTrades, capital, TZ),
      trades: { development: devDefault.trades, holdout: holdoutTrades },
    }),
    null,
    1,
  ),
);
console.log(`\nLaporan disimpan: ${reportPath}`);
