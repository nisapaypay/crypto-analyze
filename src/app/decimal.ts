import { Decimal } from 'decimal.js';

/**
 * Arbitrary-precision decimal used for every price, volume and IDR amount.
 * A private clone so global settings (and Prisma's own copy) are unaffected.
 */
export const Dec = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export type Dec = Decimal;

export const ZERO = new Dec(0);

export function sum(values: Iterable<Dec>): Dec {
  let total: Dec = ZERO;
  for (const v of values) total = total.plus(v);
  return total;
}
