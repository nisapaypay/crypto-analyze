import { ANALYSIS_DEFAULTS } from '../analysis/config.js';
import type { AnalysisResult } from '../analysis/technical-analysis-service.js';
import type { Logger } from '../app/logger/logger.js';
import { startOfDayInZone, withinActiveHours } from '../app/time.js';
import type { PairMarketData } from '../market/market-data-service.js';
import { TIMEFRAME_SECONDS, type Candle } from '../market/types.js';
import { computeRiskState, type JournalLedger, type LedgerSignal, type RiskState } from '../risk/risk-ledger.js';
import { STRATEGY_DEFAULTS, type StrategyConfig } from './config.js';
import { advanceLifecycle } from './lifecycle.js';
import { marketContextFrom } from './market-context.js';
import { rankDecisions } from './ranking.js';
import type { SignalRepository, StoredBuySignal } from './signal-repository.js';
import type { StrategySettings, StrategySettingsProvider } from './settings.js';
import { evaluateStrategy } from './strategy-engine.js';
import type { StrategyDecision } from './types.js';

export interface PairStrategyResult extends AnalysisResult {
  decision: StrategyDecision;
  signalId: number | null;
  /** A BUY for this pair + candle was issued earlier and still stands. */
  existingBuyId: number | null;
}

export interface ScanResult {
  evaluatedAt: Date;
  results: PairStrategyResult[];
  /** The single primary candidate (BUY first, else the strongest EARLY_WARNING). */
  best: PairStrategyResult | null;
  risk: RiskState;
  settings: StrategySettings;
}

export interface StrategyServiceDeps {
  analysis: { analyzeMany(pairs: string[]): Promise<AnalysisResult[]> };
  market: { refresh(pair: string): Promise<PairMarketData> };
  signals: SignalRepository;
  settings: StrategySettingsProvider;
  journal: JournalLedger;
  logger: Logger;
  timeZone: string;
  now?: () => Date;
  config?: StrategyConfig;
}

/**
 * Milestone 4: analysis → lifecycle update → three-part risk ledger →
 * deterministic decision → one primary candidate → stored signal.
 * Recommendations only: nothing here can place an order.
 */
export class StrategyService {
  private readonly cfg: StrategyConfig;
  private readonly now: () => Date;
  /** Serialises scans so two commands can never both issue against the same limits. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StrategyServiceDeps) {
    this.cfg = deps.config ?? STRATEGY_DEFAULTS;
    this.now = deps.now ?? (() => new Date());
  }

  scan(pairs: string[]): Promise<ScanResult> {
    const run = this.queue.then(() => this.runScan(pairs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async evaluate(pair: string): Promise<PairStrategyResult & { risk: RiskState; settings: StrategySettings }> {
    const scan = await this.scan([pair]);
    return { ...scan.results[0]!, risk: scan.risk, settings: scan.settings };
  }

  /** Current ledgers without running a market scan (for /risk). */
  async riskOverview(): Promise<{ risk: RiskState; settings: StrategySettings }> {
    const settings = await this.deps.settings.load();
    const { risk } = await this.ledger(settings, this.now());
    return { risk, settings };
  }

  private async runScan(pairs: string[]): Promise<ScanResult> {
    const analysed = await this.deps.analysis.analyzeMany(pairs);
    const settings = await this.deps.settings.load();
    const now = this.now();

    await this.advanceLifecycles(new Map(analysed.map((r) => [r.market.pair, r.market.finalCandles])));
    const { signals, realized, dayStart } = await this.ledger(settings, now);
    const active = withinActiveHours(now, this.deps.timeZone, settings.activeHours.start, settings.activeHours.end);

    const decisions = analysed.map(({ market, analysis }) => {
      // Re-evaluating a candle that already has a BUY must not be blocked by that BUY itself.
      const others = signals.filter(
        (s) => !(s.pair === market.pair && analysis.main?.lastCandleOpen && s.candleOpenTime.getTime() === analysis.main.lastCandleOpen.getTime()),
      );
      return evaluateStrategy({
        analysis,
        candles: market.finalCandles,
        market: marketContextFrom(market, this.cfg.sizing.depthBandPct),
        pairInfo: market.pairInfo,
        qualityIssueCodes: market.quality.issues.map((i) => i.code),
        risk: computeRiskState(others, settings.limits, realized, dayStart),
        costs: settings.costs,
        maxAllocPct: settings.maxAllocPct,
        withinActiveHours: active,
        now,
        cfg: this.cfg,
        periods: { atr: ANALYSIS_DEFAULTS.atrPeriod, rsi: ANALYSIS_DEFAULTS.rsiPeriod, volume: ANALYSIS_DEFAULTS.volumePeriod },
      });
    });

    // One candidate at a time: only the top-ranked BUY survives this scan.
    const ranked = rankDecisions(decisions);
    const top = ranked[0]?.decision === 'BUY_CANDIDATE' ? ranked[0] : null;
    const final = decisions.map((d) =>
      d.decision === 'BUY_CANDIDATE' && d !== top
        ? {
            ...d,
            decision: 'EARLY_WARNING' as const,
            reasons: [`setup lengkap, tetapi ${top!.pair.toUpperCase()} lebih kuat; hanya satu kandidat pada satu waktu`, ...d.reasons],
            earlyWarningSignals: ['setup lengkap, kalah peringkat'],
          }
        : d,
    );

    const results: PairStrategyResult[] = [];
    for (const [i, d] of final.entries()) {
      const { market, analysis } = analysed[i]!;
      let decision = d;
      let signalId: number | null = null;
      let existingBuyId: number | null = null;
      try {
        const reserved = d.decision === 'BUY_CANDIDATE' && d.plan?.sizing.ok ? d.plan.sizing.atStop.netLoss : null;
        const rec = await this.deps.signals.record(d, { snapshotId: market.snapshotId, reservedRisk: reserved });
        signalId = rec.id;
        if (rec.storedDecision === 'BUY_CANDIDATE' && !rec.issuedNow) existingBuyId = rec.id;
      } catch (error) {
        this.deps.logger.error({ err: error instanceof Error ? error.message : error, pair: d.pair }, 'Gagal menyimpan sinyal');
        // Without a stored record the daily limits cannot be guaranteed: never show an unrecorded BUY.
        if (d.decision === 'BUY_CANDIDATE') {
          decision = {
            ...d,
            decision: 'EARLY_WARNING',
            reasons: ['rekomendasi tidak dapat dicatat ke database; batas harian tidak dapat dijamin', ...d.reasons],
            earlyWarningSignals: ['gagal mencatat rekomendasi'],
          };
        }
      }
      results.push({ market, analysis, decision, signalId, existingBuyId });
    }

    const { risk } = await this.ledger(settings, now);
    const order = rankDecisions(results.map((r) => r.decision));
    const bestDecision = order.find((d) => d.decision === 'BUY_CANDIDATE' || d.decision === 'EARLY_WARNING') ?? null;
    return {
      evaluatedAt: now,
      results,
      best: bestDecision ? results.find((r) => r.decision === bestDecision)! : null,
      risk,
      settings,
    };
  }

  private async ledger(settings: StrategySettings, now: Date) {
    const dayStart = startOfDayInZone(now, this.deps.timeZone);
    const [today, open, realized] = await Promise.all([
      this.deps.signals.buySignalsSince(dayStart),
      this.deps.signals.openBuySignals(),
      this.deps.journal.realizedLossSince(dayStart),
    ]);
    const signals: StoredBuySignal[] = [...new Map([...today, ...open].map((s) => [s.id, s])).values()];
    const risk = computeRiskState(signals as LedgerSignal[], settings.limits, realized, dayStart);
    return { signals, realized, dayStart, risk };
  }

  /** Move open recommendations forward from observed final candles (never from user actions). */
  private async advanceLifecycles(candlesByPair: Map<string, Candle[]>): Promise<void> {
    const open = await this.deps.signals.openBuySignals();
    const settings = await this.deps.settings.load();
    for (const s of open) {
      try {
        const candles = candlesByPair.get(s.pair) ?? (await this.deps.market.refresh(s.pair)).finalCandles;
        const tfMs = TIMEFRAME_SECONDS[candles[0]?.timeframe ?? '15'] * 1000;
        const update = advanceLifecycle(
          {
            lifecycle: s.lifecycle,
            candleOpenTime: s.candleOpenTime,
            expiresAt: s.expiresAt,
            order: { entryMax: s.entryMax, stop: s.stopLoss, takeProfit: s.takeProfit, quantity: s.quantity },
          },
          candles,
          tfMs,
          this.cfg.signal.timeStopCandles,
          settings.costs,
        );
        if (update) await this.deps.signals.updateLifecycle(s.id, update.lifecycle, update.at, update.hypo);
      } catch (error) {
        // Keep the conservative state (lock held) when market data is unavailable.
        this.deps.logger.warn({ err: error instanceof Error ? error.message : error, signal: s.id }, 'Gagal memperbarui lifecycle rekomendasi');
      }
    }
  }
}
