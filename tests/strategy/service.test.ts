import { describe, expect, it, vi } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import type { AnalysisResult } from '../../src/analysis/technical-analysis-service.js';
import type { TechnicalAnalysis } from '../../src/analysis/types.js';
import { createLogger } from '../../src/app/logger/logger.js';
import type { PairMarketData } from '../../src/market/market-data-service.js';
import { computeOrderBookMetrics } from '../../src/market/orderbook-service.js';
import { UnavailableJournalLedger } from '../../src/risk/risk-ledger.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { InMemorySignalRepository, type SignalRepository } from '../../src/strategy/signal-repository.js';
import { StrategyService } from '../../src/strategy/strategy-service.js';
import { makeBook, makePair, makeTicker } from '../helpers/market.js';
import { EVAL_AT, scenario, steadyCandles, type ScenarioOptions } from '../helpers/strategy.js';

function marketData(pair: string, candles = steadyCandles(3_578_000, 30_000)): PairMarketData {
  const book = makeBook([[3_575_000, '5'], [3_560_000, '5']], [[3_580_000, '5'], [3_590_000, '5']], { pair, fetchedAt: EVAL_AT });
  return {
    pair,
    pairInfo: makePair({ tickerId: pair }),
    fetchedAt: EVAL_AT,
    timeframe: '15',
    ticker: makeTicker({ pair, serverTime: EVAL_AT }),
    orderBook: book,
    metrics: computeOrderBookMetrics(book, [1, 2]),
    tradeActivity: null,
    finalCandles: candles.map((c) => ({ ...c, pair })),
    pendingCandle: null,
    quality: { status: 'OK', issues: [], checkedAt: EVAL_AT },
    trendTimeframe: '60',
    trendCandles: [],
    trendError: null,
    snapshotId: null,
  };
}

function setup(perPair: Record<string, ScenarioOptions>, signals: SignalRepository = new InMemorySignalRepository(), now = EVAL_AT) {
  const analysis = {
    analyzeMany: vi.fn(async (pairs: string[]): Promise<AnalysisResult[]> =>
      pairs.map((pair) => ({ market: marketData(pair), analysis: { ...scenario(perPair[pair] ?? {}), pair } as TechnicalAnalysis })),
    ),
  };
  const service = new StrategyService({
    analysis,
    market: { refresh: async (pair: string) => marketData(pair) },
    signals,
    settings: { load: async () => defaultStrategySettings() },
    journal: new UnavailableJournalLedger(),
    logger: createLogger({ level: 'silent' }),
    timeZone: 'Asia/Jakarta',
    now: () => now,
  });
  return { service, signals, analysis };
}

describe('StrategyService', () => {
  it('issues at most one BUY per scan; other complete setups become EARLY_WARNING', async () => {
    const { service } = setup({ qnt_idr: {}, xrp_idr: { volumeRatio: '1.3' } });
    const scan = await service.scan(['qnt_idr', 'xrp_idr']);
    const decisions = Object.fromEntries(scan.results.map((r) => [r.decision.pair, r.decision.decision]));
    expect(Object.values(decisions).filter((d) => d === 'BUY_CANDIDATE')).toHaveLength(1);
    expect(scan.best?.decision.decision).toBe('BUY_CANDIDATE');
    const other = scan.results.find((r) => r.decision !== scan.best!.decision)!;
    expect(other.decision.decision).toBe('EARLY_WARNING');
    expect(other.decision.reasons[0]).toContain('hanya satu kandidat pada satu waktu');
    expect(scan.risk.recommendationsToday).toBe(1);
    expect(scan.risk.reservedRiskToday.toFixed()).toBe('25000');
  });

  it('re-scanning the same candle never counts or reserves twice', async () => {
    const { service } = setup({ qnt_idr: {} });
    const first = await service.scan(['qnt_idr']);
    const second = await service.scan(['qnt_idr']);
    expect(first.results[0]!.decision.decision).toBe('BUY_CANDIDATE');
    expect(second.results[0]!.existingBuyId).toBe(first.results[0]!.signalId);
    expect(second.risk.recommendationsToday).toBe(1);
    expect(second.risk.reservedRiskToday.toFixed()).toBe('25000');
  });

  it('while a recommendation holds the slot, another pair is at most EARLY_WARNING', async () => {
    const signals = new InMemorySignalRepository();
    await setup({ qnt_idr: {} }, signals).service.scan(['qnt_idr']);
    const scan = await setup({ xrp_idr: {} }, signals).service.scan(['xrp_idr']);
    expect(scan.results[0]!.decision.decision).toBe('EARLY_WARNING');
    expect(scan.results[0]!.decision.restrictions.join(' ')).toContain('maksimal satu posisi');
  });

  it('stores every decision; a BUY row stores the plan, costs and reserved risk', async () => {
    const { service, signals } = setup({ qnt_idr: {}, doge_idr: { rsi: 100 } });
    await service.scan(['qnt_idr', 'doge_idr']);
    const rows = (signals as InMemorySignalRepository).rows;
    expect(rows.map((r) => [r.pair, r.decision])).toEqual([
      ['qnt_idr', 'BUY_CANDIDATE'],
      ['doge_idr', 'WAIT'],
    ]);
    const buy = rows[0]!;
    expect(buy).toMatchObject({ status: 'ISSUED', lifecycleStatus: 'ACTIVE', execution: 'UNKNOWN', quantity: '0.33408581', reservedRisk: '25000' });
    expect(buy.costAssumptions).toMatchObject({ buyTaxPct: '0.11', verified: false });
    expect(rows[1]).toMatchObject({ status: 'INFO', reservedRisk: null, lifecycleStatus: null });
  });

  it('never shows an unrecorded BUY: storage failure downgrades it', async () => {
    const failing: SignalRepository = {
      record: async () => Promise.reject(new Error('db down')),
      buySignalsSince: async () => [],
      openBuySignals: async () => [],
      updateLifecycle: async () => undefined,
    };
    const scan = await setup({ qnt_idr: {} }, failing).service.scan(['qnt_idr']);
    expect(scan.results[0]!.decision.decision).toBe('EARLY_WARNING');
    expect(scan.results[0]!.decision.reasons[0]).toContain('tidak dapat dicatat');
  });

  it('advances lifecycles from market data before evaluating (expired → reservation released)', async () => {
    const signals = new InMemorySignalRepository();
    await setup({ qnt_idr: {} }, signals).service.scan(['qnt_idr']);
    // One hour later the validity window (2 candles) has passed. Candles after the
    // issue candle stay above entry max → EXPIRED_UNFILLED, reservation released.
    const later = new Date(EVAL_AT.getTime() + 3_600_000);
    const higher = steadyCandles(3_700_000, 30_000, 304).map((c, i) => ({ ...c, openTime: new Date(c.openTime.getTime() + 4 * 900_000), pair: 'qnt_idr', low: c.low.plus(i >= 300 ? 60_000 : 0) }));
    const { service } = setup({ xrp_idr: { rsi: 100 } }, signals, later);
    (service as unknown as { deps: { market: { refresh: (p: string) => Promise<PairMarketData> } } }).deps.market.refresh = async (p) => marketData(p, higher);
    const overview = await service.riskOverview();
    expect(overview.risk.slotTaken).toBe(true); // riskOverview does not touch lifecycles
    const scan = await service.scan(['xrp_idr']);
    const row = signals.rows.find((r) => r.pair === 'qnt_idr')!;
    expect(row.lifecycleStatus).toBe('EXPIRED_UNFILLED');
    expect(scan.risk.reservedRiskToday.toFixed()).toBe('0');
    expect(scan.risk.recommendationsToday).toBe(1);
  });

  it('serialises concurrent scans', async () => {
    const { service } = setup({ qnt_idr: {}, xrp_idr: {} });
    const [a, b] = await Promise.all([service.scan(['qnt_idr']), service.scan(['xrp_idr'])]);
    const buys = [...a.results, ...b.results].filter((r) => r.decision.decision === 'BUY_CANDIDATE');
    expect(buys).toHaveLength(1);
    expect(b.risk.recommendationsToday).toBe(1);
  });

  it('realized loss stays unavailable (never Rp0) in Milestone 4', async () => {
    const { service } = setup({});
    const { risk } = await service.riskOverview();
    expect(risk.realizedLoss.available).toBe(false);
    expect(risk.realizedLossEnforced).toBe(false);
    expect(risk.nextRiskBudget.eq(new Dec(25_000))).toBe(true);
  });
});
