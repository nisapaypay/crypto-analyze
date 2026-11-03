/**
 * Initial user configuration (PRD §2). All values are adjustable later
 * through Telegram; these are only the seed defaults.
 *
 * Timeframes use Indodax OHLC `tf` codes. 5m candles are not available from
 * the documented API, so both main and entry timeframes default to 15m.
 */
export const DEFAULT_SETTINGS = {
  timezone: 'Asia/Jakarta',
  capital: '5000000',
  riskPerTradePercent: '0.5',
  dailyLossLimitPercent: '1.5',
  maxDailyTrades: 3,
  maxActivePositions: 1,
  activeHoursStart: '09:00',
  activeHoursEnd: '22:00',
  scanIntervalMinutes: 15,
  mainTimeframe: '15',
  entryTimeframe: '15',
} as const;

/** Indodax `ticker_id` format. */
export const DEFAULT_WATCHLIST = ['qnt_idr', 'doge_idr', 'xrp_idr', 'link_idr'] as const;
