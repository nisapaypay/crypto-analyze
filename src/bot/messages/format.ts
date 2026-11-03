const TIMEZONE_LABELS: Record<string, string> = {
  'Asia/Jakarta': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Jayapura': 'WIT',
};

/** "02 Nov 2026 — 11:30 WIB" */
export function formatDateTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const label = TIMEZONE_LABELS[timeZone] ?? timeZone;
  return `${parts.day} ${parts.month} ${parts.year} — ${parts.hour}:${parts.minute} ${label}`;
}

/** "16:00 WIB" */
export function formatTime(date: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return `${time} ${TIMEZONE_LABELS[timeZone] ?? timeZone}`;
}

type DecimalLike = { toFixed(): string };

/** Formats from the exact decimal string, never via a float. */
function formatDecimal(value: DecimalLike, maxFractionDigits: number, signed = false): string {
  return new Intl.NumberFormat('id-ID', {
    maximumFractionDigits: maxFractionDigits,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(value.toFixed() as `${number}`);
}

/** "Rp3.585.298" — small prices keep up to 8 decimals. */
export function formatIdr(value: DecimalLike): string {
  return `Rp${formatDecimal(value, 8)}`;
}

/** "0,29%" */
export function formatPercent(value: DecimalLike, digits = 2): string {
  return `${formatDecimal(value, digits)}%`;
}

/** Ratio −1..1 shown as a signed percent: "+19,67%". */
export function formatSignedRatio(ratio: { times(n: number): DecimalLike }, digits = 1): string {
  return `${formatDecimal(ratio.times(100), digits, true)}%`;
}

type Roundable = DecimalLike & { abs(): { gte(n: number): boolean }; toDecimalPlaces(dp: number): DecimalLike };

/** Display rounding for derived prices (EMA, ATR): fewer decimals for larger prices. */
export function formatPrice(value: Roundable): string {
  const dp = value.abs().gte(1000) ? 0 : value.abs().gte(10) ? 2 : 6;
  return formatIdr(value.toDecimalPlaces(dp));
}

/** "+0,32%" / "−1,10%" */
export function formatSignedPercent(value: DecimalLike, digits = 2): string {
  return `${formatDecimal(value, digits, true)}%`;
}

/** Plain number in Indonesian format, e.g. ratios ("1,5") or base-asset volumes. */
export function formatNumber(value: DecimalLike, digits = 2): string {
  return formatDecimal(value, digits);
}

/** "02/11 14:15 WIB" */
export function formatShortDateTime(date: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month} ${p.hour}:${p.minute} ${TIMEZONE_LABELS[timeZone] ?? timeZone}`;
}

/** "qnt_idr" → "QNT/IDR" */
export function formatPair(tickerId: string): string {
  return tickerId.toUpperCase().replace('_', '/');
}
