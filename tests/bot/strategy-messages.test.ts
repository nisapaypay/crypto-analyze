import { describe, expect, it } from 'vitest';
import { LOSS_WARNING, RECOMMENDATION_DISCLAIMER, scanMessage, strategyMessage } from '../../src/bot/messages/strategy.js';
import { defaultStrategySettings } from '../../src/strategy/settings.js';
import { evaluateStrategy } from '../../src/strategy/strategy-engine.js';
import type { PairStrategyResult } from '../../src/strategy/strategy-service.js';
import { engineInput, riskState } from '../helpers/strategy.js';

const TZ = 'Asia/Jakarta';

function result(input = engineInput()): PairStrategyResult {
  return { decision: evaluateStrategy(input), market: {} as never, analysis: input.analysis, signalId: 1, existingBuyId: null };
}

describe('BUY recommendation message', () => {
  const r = result();
  const text = strategyMessage({ ...r, risk: riskState(), settings: defaultStrategySettings() }, TZ);

  it('is structured with entry range, SL, TP, quantity, fees and net P/L', () => {
    expect(text).toContain('Keputusan: 🟢 KANDIDAT BELI · regime BULLISH');
    expect(text).toContain('Entry (limit buy): Rp3.572.500 – Rp3.580.000 · berlaku s/d 11:45 WIB');
    expect(text).toContain('Jumlah: 0,33408581 QNT ≈ Rp1.196.028 (23,9% modal)');
    expect(text).toContain('Stop loss: Rp3.532.500 (−1,33%, 1,58 ATR, struktural)');
    expect(text).toContain('Take profit: Rp3.722.500 (+3,98%, batas R/R)');
    expect(text).toContain('Rugi maks (bersih): Rp25.000 · Untung (bersih): Rp40.044 · R/R bersih 1:1,6');
    expect(text).toContain('Estimasi biaya: fee beli Rp2.393 · pajak beli Rp1.316');
    expect(text).toContain('Alasan:');
    expect(text).toContain('✅ RSI 15m 50–70: RSI 60');
  });

  it('always carries the cost assumptions, the loss warning and the disclaimer', () => {
    expect(text).toContain('(BELUM TERVERIFIKASI)');
    expect(text).toContain(LOSS_WARNING);
    expect(text).toContain('gap harga, likuiditas tipis');
    expect(text).toContain(RECOMMENDATION_DISCLAIMER);
    expect(text).not.toMatch(/\bSELL\b/);
  });
});

describe('WAIT / NO_TRADE messages explain why', () => {
  it('WAIT lists the failed conditions and a non-binding simulation', () => {
    const text = strategyMessage({ ...result(engineInput({ scenario: { resistances: [3_660_000] } })), risk: riskState(), settings: defaultStrategySettings() }, TZ);
    expect(text).toContain('Keputusan: ⚪ WAIT');
    expect(text).toContain('• Validasi risiko (R/R bersih ≥ 1,5): R/R bersih');
    expect(text).toContain('Simulasi (bukan rekomendasi)');
    expect(text).not.toContain('KANDIDAT BELI');
  });

  it('scan without a BUY says so', () => {
    const r = result(engineInput({ scenario: { rsi: 100 } }));
    const text = scanMessage({ evaluatedAt: r.decision.evaluatedAt, results: [r], best: null, risk: riskState(), settings: defaultStrategySettings() }, TZ);
    expect(text).toContain('Belum ada setup BUY yang memenuhi syarat.');
    expect(text).toContain('QNT/IDR ⚪ WAIT (BULLISH) — RSI 15m 50–70: RSI 100');
  });
});
