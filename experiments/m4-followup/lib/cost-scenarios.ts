import { Dec } from '../../../src/app/decimal.js';
import { DEFAULT_COSTS, resolveCosts, type CostAssumptions } from '../../../src/risk/costs.js';
import type { PairFees } from './series.js';

/**
 * Experiment 3 — fee scenarios. Production costs (DEFAULT_COSTS / user_settings)
 * are NOT changed; every scenario builds its own CostAssumptions object.
 *
 * How each leg is charged:
 *   entry  'market'          → taker (market buy)
 *          'limit_marketable'→ taker (limit at/above the ask fills immediately)
 *          'limit_resting'   → maker ONLY in scenarios that allow it, and only
 *                              because the order rested below the ask first
 *   exit   'tp'              → limit sell resting since entry (maker-eligible)
 *          'stop'/'time'/'end' → market sell (taker)
 */
export type EntryLeg = 'market' | 'limit_marketable' | 'limit_resting';
export type ExitLeg = 'tp' | 'stop' | 'time' | 'end';

export interface CostScenario {
  id: string;
  label: string;
  /** Unverified rates in this scenario (always shown as ASUMSI). */
  assumptions: string[];
  /** Costs used for gates G10/G11 and position sizing (conservative side). */
  planning: CostAssumptions;
  buyFeePct(leg: EntryLeg): Dec;
  sellFeePct(leg: ExitLeg): Dec;
}

const TAX = DEFAULT_COSTS.buyTaxPct; // 0.11% per side — ASUMSI (not verified with a receipt)

export function costScenarios(fees: Record<string, PairFees>): CostScenario[] {
  const takers = new Set(Object.values(fees).map((f) => f.takerFeePct));
  const makers = new Set(Object.values(fees).map((f) => f.makerFeePct));
  if (takers.size !== 1 || makers.size !== 1 || [...takers][0] === null || [...makers][0] === null) {
    throw new Error(`Fee per pair berbeda/tidak tersedia: taker ${[...takers].join(',')} maker ${[...makers].join(',')}`);
  }
  const taker = new Dec([...takers][0]!);
  const maker = new Dec([...makers][0]!);
  const at = (buy: Dec, sell: Dec) =>
    resolveCosts({ buyFeePct: buy, sellFeePct: sell, buyTaxPct: TAX, sellTaxPct: TAX });
  const pairsNote = `fee taker ${taker.toFixed()}% / maker ${maker.toFixed()}% dari Indodax /api/pairs (${Object.values(fees)[0]!.fetchedAt.slice(0, 10)}) — ASUMSI: belum diverifikasi dengan bukti transaksi`;
  const taxNote = `pajak ${TAX}% per sisi — ASUMSI (belum terverifikasi)`;
  const slipNote = `slippage SL minimum ${DEFAULT_COSTS.stopSlippagePct}%, entry limit ${DEFAULT_COSTS.entrySlippagePct}%, TP ${DEFAULT_COSTS.tpSlippagePct}% — ASUMSI`;

  const production = resolveCosts();
  return [
    {
      id: 'C0_produksi',
      label: 'Produksi saat ini (fee 0,20% + pajak 0,11% per sisi, semua leg)',
      assumptions: [`fee ${DEFAULT_COSTS.buyFeePct}% per sisi (default produksi) — ASUMSI`, taxNote, slipNote],
      planning: production,
      buyFeePct: () => production.buyFeePct,
      sellFeePct: () => production.sellFeePct,
    },
    {
      id: 'C1_taker',
      label: 'Semua leg taker',
      assumptions: [pairsNote, taxNote, slipNote],
      planning: at(taker, taker),
      buyFeePct: () => taker,
      sellFeePct: () => taker,
    },
    {
      id: 'C2_maker_ideal',
      label: 'Semua leg maker — BATAS ATAS OPTIMISTIS, tidak realistis (SL & market tidak bisa maker)',
      assumptions: [pairsNote, taxNote, slipNote],
      planning: at(maker, maker),
      buyFeePct: () => maker,
      sellFeePct: () => maker,
    },
    {
      id: 'C3_campuran',
      label: 'Campuran realistis: maker hanya untuk limit yang benar-benar menunggu (entry di bawah ask, TP); market/SL/time-stop taker',
      assumptions: [pairsNote, taxNote, slipNote, 'Sizing & R/R memakai taker di kedua sisi (maker tidak dijamin)'],
      planning: at(taker, taker),
      buyFeePct: (leg) => (leg === 'limit_resting' ? maker : taker),
      sellFeePct: (leg) => (leg === 'tp' ? maker : taker),
    },
  ];
}

/** Costs actually charged on one trade, given how each leg executed. */
export function chargedCosts(s: CostScenario, entry: EntryLeg, exit: ExitLeg): CostAssumptions {
  return { ...s.planning, buyFeePct: s.buyFeePct(entry), sellFeePct: s.sellFeePct(exit) };
}
