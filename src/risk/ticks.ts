import type { Dec } from '../app/decimal.js';

/** Largest multiple of `step` ≤ value. A missing/zero step leaves the value unchanged. */
export function floorToStep(value: Dec, step: Dec | null): Dec {
  if (!step || step.lte(0)) return value;
  return value.div(step).floor().times(step);
}

/** Smallest multiple of `step` ≥ value. */
export function ceilToStep(value: Dec, step: Dec | null): Dec {
  if (!step || step.lte(0)) return value;
  return value.div(step).ceil().times(step);
}

export function isOnStep(value: Dec, step: Dec | null): boolean {
  if (!step || step.lte(0)) return true;
  return value.mod(step).isZero();
}
