import { Dec } from '../../../src/app/decimal.js';
import type { ExpTrade } from '../../m4-followup/lib/sim.js';

const DEC_FIELDS = ['entryFill', 'exitPrice', 'quantity', 'reservedRisk', 'grossPnl', 'fees', 'taxes', 'slippage', 'netPnl', 'r', 'zoneHigh'] as const;
const DATE_FIELDS = ['decisionAt', 'entryAt', 'exitAt', 'breakoutOpenTime'] as const;

export interface RawVariant {
  id: string;
  family: string;
  paramId: string;
  costId: string;
  signals: number;
  signalTimes: string[];
  expiredUnfilled: number;
  cancelled: Record<string, number>;
  rejections: Record<string, number>;
  trades: Record<string, unknown>[];
}

export interface RawRun {
  universe: string;
  tf: string;
  createdAt: string;
  seconds: number;
  variants: RawVariant[];
}

export function tradeToJson(t: ExpTrade): Record<string, unknown> {
  const o: Record<string, unknown> = { ...t };
  for (const k of DEC_FIELDS) if (t[k] !== undefined) o[k] = (t[k] as Dec).toFixed();
  for (const k of DATE_FIELDS) if (t[k] !== undefined) o[k] = (t[k] as Date).toISOString();
  return o;
}

export function tradeFromJson(o: Record<string, unknown>): ExpTrade {
  const t = { ...o } as Record<string, unknown>;
  for (const k of DEC_FIELDS) if (typeof o[k] === 'string') t[k] = new Dec(o[k] as string);
  for (const k of DATE_FIELDS) if (typeof o[k] === 'string') t[k] = new Date(o[k] as string);
  return t as unknown as ExpTrade;
}
