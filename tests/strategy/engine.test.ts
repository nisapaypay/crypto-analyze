import { describe, expect, it } from 'vitest';
import { Dec } from '../../src/app/decimal.js';
import { STRATEGY_DEFAULTS } from '../../src/strategy/config.js';
import { rankDecisions } from '../../src/strategy/ranking.js';
import { detectRegime } from '../../src/strategy/regime.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import { engineInput, ledgerSignal, marketCtx, riskState, scenario, steadyCandles } from '../helpers/strategy.js';

const gate = (d: ReturnType<typeof evaluateStrategy>, id: string) => d.gates.find((g) => g.id === id)!;

describe('market regime', () => {
  const regime = (a = scenario(), candles = steadyCandles(3_578_000, 30_000)) => detectRegime(a, candles, STRATEGY_DEFAULTS.regime, 14);

  it('BULLISH with 1H confirmation', () => {
    expect(regime()).toMatchObject({ regime: 'BULLISH', confirmed1h: true });
  });

  it('BEARISH when 1H EMAs are stacked down and close is below 1H EMA50', () => {
    expect(regime(scenario({ stack1h: 'turun', h1BelowEma50: true })).regime).toBe('BEARISH');
  });

  it('BEARISH when 15m is stacked down and the 1H slope is negative', () => {
    expect(regime(scenario({ stack15: 'turun', stack1h: 'campuran', h1Slope: '-0.1' })).regime).toBe('BEARISH');
  });

  it('SIDEWAYS otherwise', () => {
    expect(regime(scenario({ stack1h: 'campuran' })).regime).toBe('SIDEWAYS');
  });

  it('HIGH_VOLATILITY when ATR% jumps above 2× its 24h median', () => {
    const candles = steadyCandles(3_578_000, 10_000);
    // A few very wide candles at the end lift the current ATR far above its median.
    for (const c of candles.slice(-8)) Object.assign(c, { high: c.close.plus(60_000), low: c.close.minus(60_000) });
    expect(regime(scenario(), candles)).toMatchObject({ regime: 'HIGH_VOLATILITY' });
  });

  it('HIGH_VOLATILITY on a single shock candle (TR > 3 ATR)', () => {
    const candles = steadyCandles(3_578_000, 10_000);
    const c = candles.at(-1)!;
    Object.assign(c, { high: c.close.plus(20_000), low: c.close.minus(20_000) });
    expect(regime(scenario(), candles)).toMatchObject({ regime: 'HIGH_VOLATILITY', shock: true });
  });

  it('without 1H data the regime is unconfirmed (15m only)', () => {
    expect(regime(scenario({ stack1h: null }))).toMatchObject({ regime: 'BULLISH', confirmed1h: false });
  });
});

describe('decision rules', () => {
  it('DATA_UNAVAILABLE on UNAVAILABLE data: no plan, no BUY', () => {
    const d = evaluateStrategy(engineInput({ scenario: { status: 'UNAVAILABLE' } }));
    expect(d).toMatchObject({ decision: 'DATA_UNAVAILABLE', plan: null });
    expect(d.reasons[0]).toContain('Ticker basi');
  });

  it('pair maintenance/suspension is NO_TRADE, not a data failure', () => {
    const d = evaluateStrategy(engineInput({ scenario: { status: 'UNAVAILABLE' }, qualityIssueCodes: ['PAIR_SUSPENDED'] }));
    expect(d.decision).toBe('NO_TRADE');
  });

  it('missing order book (no market context) is DATA_UNAVAILABLE', () => {
    expect(evaluateStrategy(engineInput({ market: null })).decision).toBe('DATA_UNAVAILABLE');
  });

  it('DEGRADED data is capped at EARLY_WARNING even with a complete setup', () => {
    const d = evaluateStrategy(engineInput({ scenario: { status: 'DEGRADED' } }));
    expect(d.decision).toBe('EARLY_WARNING');
    expect(d.restrictions.join(' ')).toContain('data DEGRADED');
    expect(gate(d, 'G1').passed).toBe(false);
  });

  it('a less reliable required indicator caps at EARLY_WARNING', () => {
    expect(evaluateStrategy(engineInput({ scenario: { volumeNotes: ['7 dari 20 candle tanpa transaksi'] } })).decision).toBe('EARLY_WARNING');
    expect(evaluateStrategy(engineInput({ scenario: { ema9Notes: ['masa pemanasan'] } })).decision).toBe('EARLY_WARNING');
  });

  it('SIDEWAYS is at most EARLY_WARNING', () => {
    const d = evaluateStrategy(engineInput({ scenario: { stack1h: 'campuran' } }));
    expect(d.regime?.regime).toBe('SIDEWAYS');
    expect(d.decision).toBe('EARLY_WARNING');
    expect(d.reasons.join(' ')).toContain('SIDEWAYS');
  });

  it('BEARISH is WAIT even with a complete setup', () => {
    expect(evaluateStrategy(engineInput({ scenario: { stack1h: 'turun', h1BelowEma50: true } })).decision).toBe('WAIT');
  });

  it('no 1H confirmation caps at EARLY_WARNING', () => {
    expect(evaluateStrategy(engineInput({ scenario: { stack1h: null } })).decision).toBe('EARLY_WARNING');
  });

  it('outside active hours: no new BUY', () => {
    const d = evaluateStrategy(engineInput({ withinActiveHours: false }));
    expect(d.decision).toBe('EARLY_WARNING');
    expect(d.restrictions.join(' ')).toContain('di luar jam aktif');
  });

  it('RSI 100 is not a buy signal (G5 fails)', () => {
    const d = evaluateStrategy(engineInput({ scenario: { rsi: 100 } }));
    expect(d.decision).not.toBe('BUY_CANDIDATE');
    expect(gate(d, 'G5').passed).toBe(false);
  });

  it('low RSI alone is not an opportunity', () => {
    const d = evaluateStrategy(engineInput({ scenario: { rsi: 22 } }));
    expect(d.decision).not.toBe('BUY_CANDIDATE');
  });

  it('weak volume, wide spread, sell pressure and overextension each block BUY', () => {
    expect(gate(evaluateStrategy(engineInput({ scenario: { volumeRatio: '0.8' } })), 'G6').passed).toBe(false);
    const wide = evaluateStrategy(engineInput({ market: marketCtx({ bestBid: new Dec(3_560_000), bestAsk: new Dec(3_580_000) }) }));
    expect(gate(wide, 'G7').passed).toBe(false);
    expect(wide.decision).not.toBe('BUY_CANDIDATE');
    const sell = evaluateStrategy(engineInput({ market: marketCtx({ imbalance1: new Dec('-0.35') }) }));
    expect(gate(sell, 'G8').passed).toBe(false);
    const sellTrades = evaluateStrategy(engineInput({ market: marketCtx({ tradeBuyRatio: new Dec('0.2') }) }));
    expect(gate(sellTrades, 'G8').passed).toBe(false);
    const extended = evaluateStrategy(engineInput({ scenario: { ema20: 3_500_000, ema50: 3_480_000 } }));
    expect(gate(extended, 'G9').passed).toBe(false);
  });

  it('spread above the hard limit (1%) is NO_TRADE', () => {
    const d = evaluateStrategy(engineInput({ market: marketCtx({ bestBid: new Dec(3_530_000), bestAsk: new Dec(3_580_000) }) }));
    expect(d.decision).toBe('NO_TRADE');
  });

  it('a complete setup failing the minimum order is NO_TRADE (risk validation failed)', () => {
    const d = evaluateStrategy(engineInput({ pairInfo: { ...engineInput().pairInfo!, minOrderBase: new Dec(5) } }));
    expect(d.decision).toBe('NO_TRADE');
    expect(d.reasons[0]).toContain('validasi risiko gagal');
  });

  it('daily blocks are NO_TRADE; an open recommendation on another pair caps at EARLY_WARNING', () => {
    const slot = riskState([ledgerSignal({ id: 9, pair: 'xrp_idr' })]);
    const d = evaluateStrategy(engineInput({ risk: slot }));
    expect(d.decision).toBe('EARLY_WARNING');
    expect(d.restrictions.join(' ')).toContain('XRP_IDR (#9) masih berlaku');
  });

  it('EARLY_WARNING from 2 promising signals in a non-bullish but not bearish regime', () => {
    const d = evaluateStrategy(
      engineInput({
        scenario: { stack1h: 'campuran', volumeRatio: '0.5', crossover: { direction: 'ke_atas', candlesAgo: 1 }, supports: [3_570_000] },
      }),
    );
    expect(d.decision).toBe('EARLY_WARNING');
    expect(d.earlyWarningSignals).toEqual(expect.arrayContaining([expect.stringContaining('menyilang ke atas'), expect.stringContaining('support')]));
    expect(d.reasons.at(-1)).toBe('belum ada konfirmasi BUY');
  });

  it('a single promising signal is not enough: WAIT with explicit reasons', () => {
    const d = evaluateStrategy(engineInput({ scenario: { stack1h: 'campuran', volumeRatio: '0.5', crossover: { direction: 'ke_atas', candlesAgo: 1 } } }));
    expect(d.decision).toBe('WAIT');
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons.join(' ')).toContain('Rasio volume');
  });

  it('decisions never use SELL or any order wording', () => {
    for (const o of [{}, { rsi: 100 }, { stack1h: 'turun' as const, h1BelowEma50: true }, { status: 'DEGRADED' as const }]) {
      const d = evaluateStrategy(engineInput({ scenario: o }));
      expect(JSON.stringify({ r: d.reasons, g: d.gates })).not.toMatch(/\bSELL\b|order dikirim|execute/i);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(evaluateStrategy(engineInput()))).toBe(JSON.stringify(evaluateStrategy(engineInput())));
  });
});

describe('ranking', () => {
  it('BUY first, then score, then pair name', () => {
    const buy = evaluateStrategy(engineInput());
    const ew = evaluateStrategy(engineInput({ scenario: { status: 'DEGRADED' } }));
    const wait = evaluateStrategy(engineInput({ scenario: { rsi: 100 } }));
    const ranked = rankDecisions([wait, { ...ew, pair: 'aaa_idr' }, { ...buy, pair: 'zzz_idr' }]);
    expect(ranked.map((d) => d.decision)).toEqual(['BUY_CANDIDATE', 'EARLY_WARNING', 'WAIT']);
    expect(buy.score!.gt(0) && buy.score!.lte(1)).toBe(true);
  });
});
