import type { Dec } from '../app/decimal.js';
import type { Pressure } from '../indicators/orderbook-pressure.js';

/**
 * Descriptive labels for indicator values. They describe a condition only;
 * Milestone 3 never produces BUY/SELL/WAIT or any trading instruction.
 */

export function rsiLabel(rsi: Dec | null): string | null {
  if (rsi === null) return null;
  if (rsi.eq(100)) return 'RSI 100: tidak ada candle turun dalam periode smoothing — bukan sinyal beli';
  if (rsi.eq(0)) return 'RSI 0: tidak ada candle naik dalam periode smoothing — bukan otomatis kesempatan beli';
  if (rsi.gt(70)) return 'overbought (jenuh beli) — momentum sudah tinggi';
  if (rsi.gte(50)) return 'momentum naik';
  if (rsi.gte(30)) return 'momentum lemah';
  return 'oversold (jenuh jual) — tekanan turun kuat, bukan otomatis kesempatan beli';
}

export function volumeLabel(ratio: Dec | null): string | null {
  if (ratio === null) return null;
  if (ratio.lt(0.8)) return 'rendah';
  if (ratio.lt(1.2)) return 'normal';
  if (ratio.lt(2)) return 'meningkat';
  return 'lonjakan';
}

export function pressureLabel(pressure: Pressure | null): string {
  if (pressure === null) return '-';
  return pressure === 'seimbang' ? 'seimbang' : `tekanan ${pressure}`;
}

export function stackLabel(stack: 'naik' | 'turun' | 'campuran' | null): string {
  switch (stack) {
    case 'naik':
      return 'naik (EMA9 > EMA20 > EMA50)';
    case 'turun':
      return 'turun (EMA9 < EMA20 < EMA50)';
    case 'campuran':
      return 'campuran (belum searah)';
    default:
      return '-';
  }
}

export const DISCLAIMER = 'Ini kondisi indikator, bukan sinyal beli/jual.';
