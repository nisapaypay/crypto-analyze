import { startOfDayInZone, withinActiveHours } from '../app/time.js';

/**
 * Pure slot arithmetic. A slot is a 15m candle close plus the settle time
 * (e.g. 09:01:30 for the 08:45–09:00 candle). Every slot collects data; a slot
 * is a strategy slot only when its time is inside active hours and on the
 * configured scan interval.
 */

export const SLOT_MS = 15 * 60_000;

export type SlotKind = 'STRATEGY_SCAN' | 'COLLECT';

/** Earliest slot at or after `t`. */
export function slotAtOrAfter(t: Date, settleSec: number): Date {
  const offset = settleSec * 1000;
  return new Date(Math.ceil((t.getTime() - offset) / SLOT_MS) * SLOT_MS + offset);
}

/** Latest slot at or before `t`. */
export function slotAtOrBefore(t: Date, settleSec: number): Date {
  const offset = settleSec * 1000;
  return new Date(Math.floor((t.getTime() - offset) / SLOT_MS) * SLOT_MS + offset);
}

/** Slots strictly after `from` and at or before `to`, ascending. */
export function slotsBetween(from: Date, to: Date, settleSec: number): Date[] {
  const out: Date[] = [];
  for (let s = slotAtOrAfter(new Date(from.getTime() + 1), settleSec); s <= to; s = new Date(s.getTime() + SLOT_MS)) out.push(s);
  return out;
}

/** Close time of the candle a slot belongs to. */
export function candleCloseOf(slot: Date, settleSec: number): Date {
  return new Date(slot.getTime() - settleSec * 1000);
}

/** user_settings.scan_interval_minutes rounded to a multiple of 15 (15…240). */
export function normalizeInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return 15;
  return Math.min(240, Math.max(15, Math.round(minutes / 15) * 15));
}

export interface SlotRules {
  settleSec: number;
  intervalMinutes: number;
  timeZone: string;
  activeHours: { start: string; end: string };
}

/**
 * STRATEGY_SCAN when the slot time (= nominal decision time) is inside active
 * hours — the same check the M4 engine applies to its own decision time — and
 * the candle close lies on the scan interval; otherwise COLLECT.
 *
 * With 09:00–22:00 the first strategy slot is 09:01:30 (candle 08:45–09:00) and
 * the last is 21:46:30 (candle 21:30–21:45); 22:01:30 is data collection only.
 */
export function slotKind(slot: Date, r: SlotRules): SlotKind {
  if (!withinActiveHours(slot, r.timeZone, r.activeHours.start, r.activeHours.end)) return 'COLLECT';
  const closeMinute = Math.round(candleCloseOf(slot, r.settleSec).getTime() / 60_000);
  return closeMinute % normalizeInterval(r.intervalMinutes) === 0 ? 'STRATEGY_SCAN' : 'COLLECT';
}

/** A slot that would start more than `staleSec` after its time must not run (decisions would be stale). */
export function isLate(slot: Date, now: Date, staleSec: number): boolean {
  return now.getTime() - slot.getTime() > staleSec * 1000;
}

/** Next occurrence of a local "HH:MM" strictly after `now`. */
export function nextDailyAt(hhmm: string, now: Date, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const minutes = h! * 60 + m!;
  for (let d = 0; d <= 2; d++) {
    const day = startOfDayInZone(new Date(now.getTime() + d * 86_400_000), timeZone);
    const at = new Date(day.getTime() + minutes * 60_000);
    if (at > now) return at;
  }
  throw new Error(`waktu harian ${hhmm} tidak dapat dihitung`);
}
