/** Approved Milestone 5 scheduler parameters. Plain constants, easy to tune. */
export const SCHEDULER_DEFAULTS = {
  /** Data is collected on every 15m candle close, 24/7 (approved). */
  slotMinutes: 15,
  /** Slots run this long after the candle close (= M2 candle settle time). */
  settleSec: 90,
  /** A slot that starts later than this after its time is MISSED (LATE), never run late. */
  staleSlotSec: 300,
  /** One attempt of a slot may take at most this long. */
  watchdogMs: 120_000,
  /** Retries of a failed slot (only after a successful preflight). */
  slotRetryDelaysMs: [30_000, 60_000],
  /** After this many failed slots in a row, slots stop retrying until a slot succeeds. */
  circuitBreakerFailures: 3,

  heartbeatMs: 60_000,
  /** A heartbeat gap larger than this means the process was not running (sleep/stall). */
  sleepDetectMs: 90_000,
  /** Missed-slot backfill looks back at most this far (older periods are recorded as one range). */
  maxMissedLookbackMs: 30 * 86_400_000,

  /** |local − Indodax time| above this stops every trading decision (data collection runs on server time). */
  clockMaxSkewMs: 30_000,
  /** Consecutive valid clock checks required before decisions resume (fail-closed). */
  clockValidChecks: 2,

  /** Server time (data collection): consecutive samples must agree within this. */
  serverTimeMaxDriftMs: 5_000,
  /** A server-time anchor older than this (≈ one slot + margin) is no longer trusted. */
  serverTimeMaxAnchorAgeMs: 20 * 60_000,
  /** A response cached longer than this cannot anchor server time. */
  serverTimeMaxCacheAgeSec: 120,

  /** Candle continuity: look back this far for missing 15m/1H candles. */
  continuityLookbackMs: 45 * 86_400_000,
  continuityTimeframes: ['15', '60'],
  /** Request budget of one continuity pass (keeps the per-minute peak low). */
  continuityMaxRequests: 20,
  /** Candles per history request (Indodax returns at most ~865 / ~649). */
  continuityChunkCandles: { '15': 800, '60': 600 },

  /** Request/memory metrics are written to the audit log at this interval (soak report). */
  metricsIntervalMs: 3_600_000,

  /** Entry monitor: 1-minute ticks for an ACTIVE BUY, hard cap per signal. */
  monitorTickMs: 60_000,
  monitorMaxTicks: 31,

  /** Graceful shutdown: wait this long for a running slot. */
  shutdownDrainMs: 20_000,

  /** Pair used for the preflight/clock check when the watchlist is empty. */
  fallbackClockPair: 'btc_idr',
} as const;

export type SchedulerConfig = typeof SCHEDULER_DEFAULTS;
