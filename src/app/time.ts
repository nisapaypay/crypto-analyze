/** Calendar helpers for a fixed IANA time zone (Asia/Jakarta has no DST). */

/** Midnight of `date`'s calendar day in `timeZone`, as a UTC instant. */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const localAsUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  const offsetMs = localAsUtc - Math.floor(date.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!) - offsetMs);
}

/** Minutes since local midnight in `timeZone`. */
export function minutesOfDayInZone(date: Date, timeZone: string): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date)
    .split(':')
    .map(Number);
  return h! * 60 + m!;
}

/** "09:00"–"22:00" inclusive start, exclusive end. */
export function withinActiveHours(date: Date, timeZone: string, start: string, end: string): boolean {
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h! * 60 + m!;
  };
  const now = minutesOfDayInZone(date, timeZone);
  const a = toMin(start);
  const b = toMin(end);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}
