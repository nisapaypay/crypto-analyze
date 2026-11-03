import type { Logger } from '../app/logger/logger.js';
import { MARKET_DATA_DEFAULTS } from '../market/config.js';
import type { PairMarketData } from '../market/market-data-service.js';
import { ANALYSIS_DEFAULTS, type AnalysisConfig } from './config.js';
import { computeTechnicalAnalysis } from './engine.js';
import { toIndicatorRecords, type IndicatorRepository } from './indicator-repository.js';
import type { TechnicalAnalysis } from './types.js';

export interface AnalysisResult {
  market: PairMarketData;
  analysis: TechnicalAnalysis;
}

export interface TechnicalAnalysisDeps {
  market: { refresh(pair: string): Promise<PairMarketData>; refreshMany(pairs: string[]): Promise<PairMarketData[]> };
  repository: IndicatorRepository;
  logger: Logger;
  now?: () => Date;
  config?: Partial<AnalysisConfig>;
  candleSettleSec?: number;
}

/**
 * Milestone 3: market data → indicators → stored indicator snapshot.
 * Produces descriptive indicator readings only; never a trading signal.
 */
export class TechnicalAnalysisService {
  private readonly config: AnalysisConfig;
  private readonly now: () => Date;
  private readonly settleSec: number;

  constructor(private readonly deps: TechnicalAnalysisDeps) {
    this.config = { ...ANALYSIS_DEFAULTS, ...deps.config };
    this.now = deps.now ?? (() => new Date());
    this.settleSec = deps.candleSettleSec ?? MARKET_DATA_DEFAULTS.candleSettleSec;
  }

  async analyze(pair: string): Promise<AnalysisResult> {
    return this.analyzeData(await this.deps.market.refresh(pair));
  }

  async analyzeMany(pairs: string[]): Promise<AnalysisResult[]> {
    const data = await this.deps.market.refreshMany(pairs);
    return Promise.all(data.map((d) => this.analyzeData(d)));
  }

  private async analyzeData(market: PairMarketData): Promise<AnalysisResult> {
    const analysis = computeTechnicalAnalysis(market, this.config, this.now(), this.settleSec);
    const records = toIndicatorRecords(analysis, market.snapshotId);
    if (records.length > 0) {
      await this.deps.repository.upsert(records).catch((error: unknown) =>
        this.deps.logger.warn(
          { pair: market.pair, err: error instanceof Error ? error.message : error },
          'Gagal menyimpan indicator snapshot',
        ),
      );
    }
    return { market, analysis };
  }
}
