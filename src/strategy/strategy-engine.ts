import { Dec } from '../app/decimal.js';
import { formatNumber } from '../bot/messages/format.js';
import type { Reading, TechnicalAnalysis } from '../analysis/types.js';
import type { Candle, PairInfo } from '../market/types.js';
import type { CostAssumptions } from '../risk/costs.js';
import type { RiskState } from '../risk/risk-ledger.js';
import type { StrategyConfig } from './config.js';
import { earlyWarningSignals } from './early-warning.js';
import { effectiveAtr, technicalGates } from './gates.js';
import { buildTradePlan } from './plan.js';
import { scoreDecision } from './ranking.js';
import { detectRegime } from './regime.js';
import type { DECISION_RANK, Decision, GateResult, MarketContext, RegimeResult, StrategyDecision, TradePlan } from './types.js';

export interface StrategyInput {
  analysis: TechnicalAnalysis;
  /** The same final 15m candles the analysis used. */
  candles: Candle[];
  market: MarketContext | null;
  pairInfo: PairInfo | null;
  /** Milestone 2 quality issue codes (to tell pair blocks from data failures). */
  qualityIssueCodes: string[];
  risk: RiskState;
  costs: CostAssumptions;
  maxAllocPct: Dec;
  /** False outside active hours: no new BUY (PRD §10.3). */
  withinActiveHours: boolean;
  now: Date;
  cfg: StrategyConfig;
  /** M3 periods, needed for derived series. */
  periods: { atr: number; rsi: number; volume: number };
  /** Backtest speed-ups with identical results: a regime already computed for these candles… */
  precomputedRegime?: RegimeResult;
  /** …and skipping EARLY_WARNING signals (only BUYs trade in a backtest). Default true. */
  earlyWarning?: boolean;
}

const PAIR_BLOCK_CODES = new Set(['PAIR_MAINTENANCE', 'PAIR_SUSPENDED', 'PAIR_NOT_FOUND']);

/**
 * Deterministic strategy decision. Pure: no I/O, same input → same output.
 * Order: DATA_UNAVAILABLE → NO_TRADE → BUY_CANDIDATE → EARLY_WARNING → WAIT.
 */
export function evaluateStrategy(input: StrategyInput): StrategyDecision {
  const { analysis: a, cfg, risk, market } = input;
  const base = {
    pair: a.pair,
    engineVersion: cfg.engineVersion,
    evaluatedAt: input.now,
    candleOpenTime: a.main?.lastCandleOpen ?? null,
    costs: input.costs,
    regime: null,
    gates: [] as GateResult[],
    restrictions: [] as string[],
    earlyWarningSignals: [] as string[],
    plan: null as TradePlan | null,
    planRejection: null as string | null,
    score: null,
    indicators: compactIndicators(a, market),
  };

  // 1. Data gate: UNAVAILABLE can never produce BUY (nothing below even runs).
  if (a.status === 'UNAVAILABLE' || !a.main || a.main.unavailableReason || !market) {
    const pairBlocked = input.qualityIssueCodes.some((c) => PAIR_BLOCK_CODES.has(c));
    const reasons = a.unavailableReasons.length ? a.unavailableReasons : ['data pasar tidak lengkap'];
    return { ...base, decision: pairBlocked ? 'NO_TRADE' : 'DATA_UNAVAILABLE', reasons };
  }

  const regime = input.precomputedRegime ?? detectRegime(a, input.candles, cfg.regime, input.periods.atr);
  const atr = effectiveAtr(a);
  const gates: GateResult[] = [];
  gates.push({
    id: 'G1',
    label: 'Data valid dan segar (OK)',
    passed: a.status === 'OK',
    detail: a.status === 'OK' ? 'status OK' : `status ${a.status}: ${a.dataWarnings.join('; ')}`,
  });
  const tech = technicalGates(a, input.candles, market, regime, input.costs, atr, cfg);
  gates.push(...tech);

  // Plan + sizing (G11). Computed whenever possible so WAIT can show why.
  let plan: TradePlan | null = null;
  let planRejection: string | null = null;
  if (!atr) planRejection = 'ATR tidak tersedia';
  else {
    const built = buildTradePlan({
      analysis: a,
      market,
      pairInfo: input.pairInfo,
      atr,
      costs: input.costs,
      riskBudget: risk.nextRiskBudget,
      capital: risk.limits.capital,
      maxAllocPct: input.maxAllocPct,
      cfg,
    });
    if (built.ok) plan = built.plan;
    else planRejection = built.reason;
  }
  const sizing = plan?.sizing;
  const g11Pass = !!sizing?.ok && sizing.netRr.gte(cfg.minNetRr);
  gates.push({
    id: 'G11',
    label: `Validasi risiko (R/R bersih ≥ ${formatNumber(new Dec(cfg.minNetRr), 2)})`,
    // Not evaluable only without ATR; a rejected stop/target is a failure.
    passed: plan ? g11Pass : atr ? false : null,
    detail: !plan
      ? (planRejection ?? 'rencana trade tidak tersedia')
      : !sizing!.ok
        ? sizing!.reason
        : `R/R bersih ${formatNumber(sizing!.netRr, 2)}${g11Pass ? '' : ` < ${formatNumber(new Dec(cfg.minNetRr), 2)}`}`,
  });

  // Restrictions: anything that caps the decision at EARLY_WARNING.
  const restrictions: string[] = [];
  if (a.status === 'DEGRADED') restrictions.push(`data DEGRADED (${a.dataWarnings.join('; ')})`);
  restrictions.push(...reliabilityRestrictions(a));
  if (!regime.confirmed1h) restrictions.push('konfirmasi tren 1 jam tidak tersedia');
  if (!input.withinActiveHours) restrictions.push('di luar jam aktif: rekomendasi beli baru tidak diterbitkan');
  if (risk.slotTaken) {
    const s = risk.slotHolders[0]!;
    restrictions.push(
      `rekomendasi ${s.pair.toUpperCase()} (#${s.id}) masih ${s.lifecycle === 'ACTIVE' ? 'berlaku' : 'mungkin terisi'}; maksimal satu posisi`,
    );
  }

  gates.push({
    id: 'G12',
    label: 'Status risiko harian & slot posisi',
    passed: risk.blocks.length === 0 && !risk.slotTaken && input.withinActiveHours,
    detail:
      [...risk.blocks.map((b) => b.message), risk.slotTaken ? 'slot posisi terpakai' : null, input.withinActiveHours ? null : 'di luar jam aktif']
        .filter(Boolean)
        .join('; ') || `rekomendasi hari ini ${risk.recommendationsToday}/${risk.limits.maxDailyRecommendations}`,
  });

  const result = (decision: Decision, reasons: string[], extra: Partial<StrategyDecision> = {}): StrategyDecision => {
    const d: StrategyDecision = { ...base, decision, reasons, regime, gates, restrictions, plan, planRejection, ...extra };
    return { ...d, score: decision === 'BUY_CANDIDATE' || decision === 'EARLY_WARNING' ? scoreDecision(d, cfg) : null };
  };

  // 2. NO_TRADE: risk state and unfit market, regardless of the setup.
  if (risk.blocks.length > 0) return result('NO_TRADE', risk.blocks.map((b) => b.message));
  if (market.spreadPct.gt(cfg.gates.hardMaxSpreadPct)) {
    return result('NO_TRADE', [`spread ${formatNumber(market.spreadPct, 2)}% > ${formatNumber(new Dec(cfg.gates.hardMaxSpreadPct), 2)}%`]);
  }

  // Decision cap from regime and restrictions.
  let cap: keyof typeof DECISION_RANK =
    regime.regime === 'BULLISH' ? 'BUY_CANDIDATE' : regime.regime === 'SIDEWAYS' ? 'EARLY_WARNING' : 'WAIT';
  if (restrictions.length > 0 && cap === 'BUY_CANDIDATE') cap = 'EARLY_WARNING';

  const techPass = tech.filter((g) => g.id !== 'G2').every((g) => g.passed === true);
  const failed = gates.filter((g) => g.passed !== true && g.id !== 'G1' && g.id !== 'G12');

  if (techPass && g11Pass) {
    if (cap === 'BUY_CANDIDATE') {
      return result('BUY_CANDIDATE', gates.filter((g) => g.passed).map((g) => `${g.label}: ${g.detail}`));
    }
    if (cap === 'EARLY_WARNING') {
      const why = regime.regime === 'SIDEWAYS' ? ['regime SIDEWAYS: maksimal EARLY_WARNING'] : [];
      return result('EARLY_WARNING', ['semua syarat teknikal terpenuhi, tetapi BUY ditahan:', ...why, ...restrictions], {
        earlyWarningSignals: ['setup lengkap tertahan pembatasan'],
      });
    }
    return result('WAIT', [`regime ${regime.regime}: beli spot tidak disarankan`, ...regime.notes]);
  }

  // Setup otherwise complete but risk validation fails structurally (PRD §8.4).
  if (techPass && cap === 'BUY_CANDIDATE' && sizing && !sizing.ok && (sizing.kind === 'min_order' || sizing.kind === 'liquidity')) {
    return result('NO_TRADE', [`validasi risiko gagal: ${sizing.reason}`]);
  }

  if (cap !== 'WAIT' && input.earlyWarning !== false) {
    const signals = earlyWarningSignals(a, input.candles, atr, cfg.earlyWarning, input.periods.rsi, input.periods.volume);
    if (signals.length >= cfg.earlyWarning.minSignals) {
      return result('EARLY_WARNING', [...signals, 'belum ada konfirmasi BUY'], { earlyWarningSignals: signals });
    }
  }

  // The regime line replaces G2 so the same reason is not shown twice.
  const reasons = failed.filter((g) => g.id !== 'G2').slice(0, 4).map((g) => `${g.label}: ${g.detail}`);
  if (regime.regime !== 'BULLISH' || !regime.confirmed1h) {
    reasons.unshift(`regime ${regime.regime}${regime.notes.length ? ` (${regime.notes.join('; ')})` : ''}`);
  }
  return result('WAIT', reasons.slice(0, 5));
}

function reliabilityRestrictions(a: TechnicalAnalysis): string[] {
  const out: string[] = [];
  const check = (name: string, r: Reading<unknown> | undefined) => {
    if (r?.reliability === 'kurang_andal') out.push(`${name} kurang andal`);
  };
  for (const t of [a.main, a.trend]) {
    if (!t || t.unavailableReason) continue;
    const tf = t.timeframe === '60' ? '1j' : '15m';
    check(`EMA9 ${tf}`, t.ema9);
    check(`EMA20 ${tf}`, t.ema20);
    check(`EMA50 ${tf}`, t.ema50);
    if (t === a.main) check(`RSI14 ${tf}`, t.rsi14);
  }
  check('Rasio volume', a.volume?.ratio);
  return out;
}

function compactIndicators(a: TechnicalAnalysis, m: MarketContext | null): Record<string, string | null> {
  const s = (v: Dec | null | undefined) => (v ? v.toFixed() : null);
  return {
    status: a.status,
    close: s(a.main?.close),
    ema9: s(a.main?.ema9.value),
    ema20: s(a.main?.ema20.value),
    ema50: s(a.main?.ema50.value),
    rsi14: s(a.main?.rsi14.value),
    stack15m: a.main?.stack.value ?? null,
    stack1h: a.trend?.stack.value ?? null,
    atr14: s(a.volatility?.atr14.value),
    atr14Traded: s(a.volatility?.atr14Traded.value),
    volumeRatio: s(a.volume?.ratio.value),
    spreadPct: s(m?.spreadPct),
    imbalance1: s(m?.imbalance1),
    tradeBuyRatio: s(m?.tradeBuyRatio),
  };
}
