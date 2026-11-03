import { Dec } from '../app/decimal.js';
import type { PrismaClient } from '../app/database/prisma.js';
import { DEFAULT_SETTINGS } from '../app/config/defaults.js';
import { resolveCosts, type CostAssumptions } from '../risk/costs.js';
import type { RiskLimits } from '../risk/risk-ledger.js';
import { STRATEGY_DEFAULTS } from './config.js';

export interface StrategySettings {
  limits: RiskLimits;
  costs: CostAssumptions;
  maxAllocPct: Dec;
  activeHours: { start: string; end: string };
}

export interface StrategySettingsProvider {
  load(): Promise<StrategySettings>;
}

/** Reads (never writes) capital, risk limits and cost assumptions from user_settings. */
export class PrismaStrategySettings implements StrategySettingsProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegramUserId: number,
  ) {}

  async load(): Promise<StrategySettings> {
    const s = await this.prisma.userSettings.findFirst({ where: { user: { telegramUserId: BigInt(this.telegramUserId) } } });
    if (!s) throw new Error('Pengaturan pengguna belum ada. Jalankan `pnpm db:seed`.');
    const str = (v: { toString(): string } | null) => (v === null ? null : v.toString());
    return {
      limits: {
        capital: new Dec(s.capital.toString()),
        riskPerTradePct: new Dec(s.riskPerTrade.toString()),
        dailyLossLimitPct: new Dec(s.dailyLossLimit.toString()),
        maxDailyRecommendations: s.maxDailyTrades,
        maxActivePositions: s.maxActivePositions,
        minBudgetShare: STRATEGY_DEFAULTS.minBudgetShare,
      },
      costs: resolveCosts({
        buyFeePct: str(s.buyFeePct),
        sellFeePct: str(s.sellFeePct),
        buyTaxPct: str(s.buyTaxPct),
        sellTaxPct: str(s.sellTaxPct),
        entrySlippagePct: str(s.entrySlippagePct),
        stopSlippagePct: str(s.stopSlippagePct),
        tpSlippagePct: str(s.tpSlippagePct),
        verified: s.costsVerified,
      }),
      maxAllocPct: new Dec(str(s.maxPositionAllocPct) ?? STRATEGY_DEFAULTS.sizing.maxAllocPct),
      activeHours: { start: s.activeHoursStart, end: s.activeHoursEnd },
    };
  }
}

/** Defaults from PRD §2 / §9 (tests and `--no-save` scripts). */
export function defaultStrategySettings(): StrategySettings {
  return {
    limits: {
      capital: new Dec(DEFAULT_SETTINGS.capital),
      riskPerTradePct: new Dec(DEFAULT_SETTINGS.riskPerTradePercent),
      dailyLossLimitPct: new Dec(DEFAULT_SETTINGS.dailyLossLimitPercent),
      maxDailyRecommendations: DEFAULT_SETTINGS.maxDailyTrades,
      maxActivePositions: DEFAULT_SETTINGS.maxActivePositions,
      minBudgetShare: STRATEGY_DEFAULTS.minBudgetShare,
    },
    costs: resolveCosts(),
    maxAllocPct: new Dec(STRATEGY_DEFAULTS.sizing.maxAllocPct),
    activeHours: { start: DEFAULT_SETTINGS.activeHoursStart, end: DEFAULT_SETTINGS.activeHoursEnd },
  };
}
