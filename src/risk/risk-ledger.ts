import { Dec, sum, ZERO } from '../app/decimal.js';

/** Market-observed lifecycle of a BUY recommendation (never the user's actions). */
export type LifecycleStatus = 'ACTIVE' | 'EXPIRED_UNFILLED' | 'POSSIBLY_FILLED' | 'HYPO_CLOSED';
/** Whether the user executed it. M4 has no journal, so it is always UNKNOWN. */
export type ExecutionStatus = 'UNKNOWN' | 'TAKEN' | 'NOT_TAKEN';

export interface LedgerSignal {
  id: number;
  pair: string;
  createdAt: Date;
  expiresAt: Date;
  /** Planned max net loss, set once when the recommendation is issued. */
  reservedRisk: Dec;
  lifecycle: LifecycleStatus;
  execution: ExecutionStatus;
  /** M6: the journal recorded the trade as closed (its realized result replaces the reservation). */
  journalClosed?: boolean;
}

export interface RiskLimits {
  capital: Dec;
  riskPerTradePct: Dec;
  dailyLossLimitPct: Dec;
  maxDailyRecommendations: number;
  maxActivePositions: number;
  /** Below this share of the per-trade risk, the remaining daily budget is too small. */
  minBudgetShare: number;
}

export type RealizedLoss = { available: false; reason: string } | { available: true; amount: Dec };

/** Source of realized losses. Milestone 6 (trading journal) provides the real one. */
export interface JournalLedger {
  realizedLossSince(dayStart: Date): Promise<RealizedLoss>;
}

export const JOURNAL_UNAVAILABLE_REASON = 'jurnal transaksi baru tersedia di Milestone 6';

/** Milestone 4: there is no journal, so realized losses are unknown — never zero. */
export class UnavailableJournalLedger implements JournalLedger {
  async realizedLossSince(): Promise<RealizedLoss> {
    return { available: false, reason: JOURNAL_UNAVAILABLE_REASON };
  }
}

export type RiskBlockCode = 'DAILY_RECOMMENDATION_LIMIT' | 'DAILY_RISK_BUDGET' | 'REALIZED_LOSS_LIMIT';

export interface RiskState {
  dayStart: Date;
  limits: RiskLimits;
  perTradeRisk: Dec;
  dailyRiskLimit: Dec;
  /** 1. BUY recommendations issued today, executed or not. */
  recommendationsToday: number;
  /** 2. Planned risk still reserved by today's recommendations. */
  reservedRiskToday: Dec;
  /** 3. Realized loss from the journal; unavailable in Milestone 4. */
  realizedLoss: RealizedLoss;
  /** True only when realized losses are known (Milestone 6+). */
  realizedLossEnforced: boolean;
  remainingDailyRisk: Dec;
  nextRiskBudget: Dec;
  /** Recommendations that may still occupy the single position slot. */
  slotHolders: LedgerSignal[];
  slotTaken: boolean;
  blocks: { code: RiskBlockCode; message: string }[];
}

/**
 * A recommendation reserves its risk exactly once (a property of the signal,
 * not of its transitions). The reservation is released only when the market
 * shows it could not have filled (EXPIRED_UNFILLED) or, from M6, when the
 * journal says it was not taken or has closed with a realized result.
 */
export function isReservationHeld(s: LedgerSignal): boolean {
  if (s.execution === 'NOT_TAKEN' || s.journalClosed) return false;
  return s.lifecycle !== 'EXPIRED_UNFILLED';
}

/**
 * Conservative position slot: while a recommendation is still valid or may
 * have filled, the user *might* hold a position. The system does not assume
 * execution, it only refuses to stack another BUY on top of it.
 */
export function holdsPositionSlot(s: LedgerSignal): boolean {
  if (s.execution === 'NOT_TAKEN' || s.journalClosed) return false;
  return s.lifecycle === 'ACTIVE' || s.lifecycle === 'POSSIBLY_FILLED';
}

/** Pure computation of the three separate daily ledgers. */
export function computeRiskState(signals: LedgerSignal[], limits: RiskLimits, realized: RealizedLoss, dayStart: Date): RiskState {
  // One entry per signal id: a status change can never add a second reservation.
  const unique = [...new Map(signals.map((s) => [s.id, s])).values()];
  const today = unique.filter((s) => s.createdAt >= dayStart);

  const perTradeRisk = limits.capital.times(limits.riskPerTradePct).div(100);
  const dailyRiskLimit = limits.capital.times(limits.dailyLossLimitPct).div(100);
  const reservedRiskToday = sum(today.filter(isReservationHeld).map((s) => s.reservedRisk));
  const realizedAmount = realized.available ? realized.amount : ZERO;
  const remainingDailyRisk = Dec.max(dailyRiskLimit.minus(reservedRiskToday).minus(realizedAmount), 0);
  const nextRiskBudget = Dec.min(perTradeRisk, remainingDailyRisk);
  const slotHolders = unique.filter(holdsPositionSlot);

  const blocks: RiskState['blocks'] = [];
  if (today.length >= limits.maxDailyRecommendations) {
    blocks.push({
      code: 'DAILY_RECOMMENDATION_LIMIT',
      message: `batas ${limits.maxDailyRecommendations} rekomendasi per hari sudah tercapai (${today.length})`,
    });
  }
  if (nextRiskBudget.lt(perTradeRisk.times(limits.minBudgetShare))) {
    blocks.push({ code: 'DAILY_RISK_BUDGET', message: 'sisa batas risiko terencana harian terlalu kecil' });
  }
  if (realized.available && realized.amount.gte(dailyRiskLimit)) {
    blocks.push({ code: 'REALIZED_LOSS_LIMIT', message: 'batas rugi harian (terealisasi) sudah tercapai' });
  }

  return {
    dayStart,
    limits,
    perTradeRisk,
    dailyRiskLimit,
    recommendationsToday: today.length,
    reservedRiskToday,
    realizedLoss: realized,
    realizedLossEnforced: realized.available,
    remainingDailyRisk,
    nextRiskBudget,
    slotHolders,
    slotTaken: slotHolders.length >= limits.maxActivePositions,
    blocks,
  };
}
