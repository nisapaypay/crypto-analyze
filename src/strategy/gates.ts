import { Dec } from '../app/decimal.js';
import type { TechnicalAnalysis } from '../analysis/types.js';
import type { Candle } from '../market/types.js';
import { formatNumber, formatPercent } from '../bot/messages/format.js';
import { roundTripCostPct, type CostAssumptions } from '../risk/costs.js';
import type { StrategyConfig } from './config.js';
import type { GateResult, MarketContext, RegimeResult } from './types.js';

const n = (v: Dec, dp = 2) => formatNumber(v, dp);
/** Indonesian decimal for config numbers in labels ("1,2"). */
const k = (v: number) => formatNumber(new Dec(v), 2);
/** Ratio with enough decimals that tiny values are not shown as 0. */
const ratioText = (v: Dec) => (v.gt(0) && v.lt('0.001') ? '<0,001×' : `${n(v, v.lt(0.1) ? 3 : 2)}×`);
const gate = (id: GateResult['id'], label: string, passed: boolean | null, detail: string): GateResult => ({ id, label, passed, detail });

/** max(ATR14, ATR over traded candles): never let zero-volume candles shrink the stop. */
export function effectiveAtr(a: TechnicalAnalysis): Dec | null {
  const values = [a.volatility?.atr14.value, a.volatility?.atr14Traded.value].filter((v): v is Dec => !!v && v.gt(0));
  return values.length ? Dec.max(...values) : null;
}

/** Technical gates G2–G10 (PRD §8.1 mapped to 15m entry / 1H confirmation). */
export function technicalGates(
  a: TechnicalAnalysis,
  candles: Candle[],
  market: MarketContext,
  regime: RegimeResult,
  costs: CostAssumptions,
  atr: Dec | null,
  cfg: StrategyConfig,
): GateResult[] {
  const g = cfg.gates;
  const m = a.main!;
  const close = m.close;
  const e9 = m.ema9.value;
  const e20 = m.ema20.value;
  const out: GateResult[] = [];

  out.push(
    gate(
      'G2',
      'Regime bullish terkonfirmasi 1j',
      regime.regime === 'BULLISH' && regime.confirmed1h,
      `regime ${regime.regime}${regime.confirmed1h ? '' : ' (tanpa konfirmasi 1j)'}`,
    ),
  );

  out.push(
    e9 && e20 && close
      ? gate('G3', 'EMA9 > EMA20 dan close > EMA20 (15m)', e9.gt(e20) && close.gt(e20), `EMA9 ${e9.gt(e20) ? '>' : '≤'} EMA20, close ${close.gt(e20) ? '>' : '≤'} EMA20`)
      : gate('G3', 'EMA9 > EMA20 dan close > EMA20 (15m)', null, 'EMA belum tersedia'),
  );

  const slope = m.ema20SlopePct.value;
  const lastCandle = candles.at(-1);
  const drop = lastCandle && atr ? Dec.max(lastCandle.open.minus(lastCandle.close), 0).div(atr) : null;
  out.push(
    slope && drop
      ? gate(
          'G4',
          'Tidak turun tajam',
          slope.gte(0) && drop.lte(g.maxCandleDropAtr),
          `kemiringan EMA20 ${formatPercent(slope)}, penurunan candle terakhir ${n(drop)} ATR`,
        )
      : gate('G4', 'Tidak turun tajam', null, 'kemiringan EMA20/ATR belum tersedia'),
  );

  const rsi = m.rsi14.value;
  out.push(
    rsi
      ? gate('G5', `RSI 15m ${k(g.rsiMin)}–${k(g.rsiMax)}`, rsi.gte(g.rsiMin) && rsi.lte(g.rsiMax), `RSI ${n(rsi, 1)}`)
      : gate('G5', `RSI 15m ${k(g.rsiMin)}–${k(g.rsiMax)}`, null, 'RSI tidak tersedia'),
  );

  const ratio = a.volume?.ratio.value;
  out.push(
    ratio
      ? gate('G6', `Rasio volume ≥ ${k(g.volumeRatioMin)}`, ratio.gte(g.volumeRatioMin), `rasio ${ratioText(ratio)}`)
      : gate('G6', `Rasio volume ≥ ${k(g.volumeRatioMin)}`, null, 'rasio volume tidak tersedia'),
  );

  out.push(
    atr
      ? gate(
          'G7',
          `Spread ≤ ${k(g.maxSpreadPct)}% dan ≤ ${k(g.maxSpreadAtr)} ATR`,
          market.spreadPct.lte(g.maxSpreadPct) && market.spread.lte(atr.times(g.maxSpreadAtr)),
          `spread ${formatPercent(market.spreadPct)} (${n(market.spread.div(atr))} ATR)`,
        )
      : gate('G7', `Spread ≤ ${k(g.maxSpreadPct)}%`, null, 'ATR tidak tersedia'),
  );

  if (market.orderBookNeutralised) {
    out.push(gate('G8', 'Order book & trade tidak menunjukkan tekanan jual kuat', true, 'dinetralkan: data order book historis tidak tersedia (backtest)'));
  } else if (!market.imbalance1) {
    out.push(gate('G8', 'Order book & trade tidak menunjukkan tekanan jual kuat', null, 'imbalance ±1% tidak tersedia'));
  } else {
    const obOk = market.imbalance1.gt(g.imbalanceMin);
    const trOk = market.tradeBuyRatio === null || market.tradeBuyRatio.gte(g.minTradeBuyRatio);
    out.push(
      gate(
        'G8',
        'Order book & trade tidak menunjukkan tekanan jual kuat',
        obOk && trOk,
        `imbalance ±1% ${formatPercent(market.imbalance1.times(100), 1)}, beli trade 60m ${market.tradeBuyRatio ? formatPercent(market.tradeBuyRatio.times(100), 0) : 'tidak ada trade'}`,
      ),
    );
  }

  out.push(
    close && e20 && atr
      ? gate('G9', `Tidak overextended (≤ ${k(g.maxExtensionAtr)} ATR di atas EMA20)`, close.minus(e20).lte(atr.times(g.maxExtensionAtr)), `${n(close.minus(e20).div(atr))} ATR di atas EMA20`)
      : gate('G9', 'Tidak overextended', null, 'EMA20/ATR tidak tersedia'),
  );

  const cost = roundTripCostPct(costs);
  out.push(
    close && atr
      ? gate('G10', 'Volatilitas ≥ biaya bolak-balik', atr.div(close).times(100).gte(cost), `ATR ${formatPercent(atr.div(close).times(100))} vs biaya ${formatPercent(cost)}`)
      : gate('G10', 'Volatilitas ≥ biaya bolak-balik', null, 'ATR tidak tersedia'),
  );
  return out;
}
