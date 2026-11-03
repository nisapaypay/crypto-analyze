# PRD — Agentic AI Crypto Analyst

**Project:** Personal Agentic AI Crypto Analyst  
**Exchange:** Indodax  
**Mode:** Market Analysis Only / Manual Execution  
**Interface:** Telegram Bot  
**Initial Trading Capital:** Rp5.000.000  
**Market:** Spot  
**Timezone:** Asia/Jakarta (WIB)

---

# 1. Product Overview

## 1.1 Objective

Build a personal AI crypto trading analyst that continuously monitors cryptocurrency markets on Indodax and sends actionable trading recommendations through Telegram.

The system must analyze market conditions, identify potential trading opportunities, calculate suggested entry prices, position sizes, stop losses, and take profits.

The user is responsible for manually executing all buy and sell transactions through the Indodax application.

**The system must NEVER execute trades, place orders, cancel orders, or transfer funds.**

## 1.2 Core Responsibilities

1. Retrieve live and historical cryptocurrency market data.
2. Monitor a configurable cryptocurrency watchlist.
3. Analyze candlestick charts and technical indicators.
4. Analyze order book, volume, spread, and recent trades.
5. Identify early trading opportunities.
6. Generate BUY, WAIT, NO TRADE, and EARLY WARNING signals.
7. Calculate suggested limit buy, quantity, stop loss, and take profit.
8. Calculate estimated profit and loss in IDR.
9. Automatically schedule the next market scan.
10. Send notifications through Telegram.
11. Track manually reported positions.
12. Generate daily trading performance reports.

## 1.3 Trading Philosophy

- Aggressive opportunity scanning, disciplined risk management.
- Aim for small, consistent opportunities, without guaranteeing daily profit.
- Never force a trade when conditions are unfavorable.
- Avoid FOMO and chasing pumps.
- Focus on one best cryptocurrency opportunity at a time.
- No futures, margin, or leverage.
- All execution remains under user control.
- Always use fresh market data.
- Include transaction fees and estimated slippage in profit calculations.

---

# 2. User Configuration

| Parameter | Initial Value |
|---|---|
| Exchange | Indodax |
| Mode | Analysis Only |
| Capital | Rp5.000.000 |
| Market | Spot |
| Timezone | Asia/Jakarta |
| Main timeframe | 15 minutes |
| Entry timeframe | 5 minutes |
| Maximum active positions | 1 |
| Maximum suggested trades/day | 3 |
| Risk per trade | 0.5% |
| Daily loss limit | 1.5% |
| Watchlist | QNT, DOGE, XRP, LINK |

All configuration values must be adjustable.

## 2.1 Watchlist

Initial pairs:

- QNT/IDR
- DOGE/IDR
- XRP/IDR
- LINK/IDR

Verify that each pair exists and is active on Indodax before scanning.

The user must be able to add or remove pairs through Telegram.

## 2.2 Trading Capital

Initial analytical capital: Rp5.000.000.

The capital is used for position sizing and estimated P/L calculations only.

The application does not have access to the user's wallet or account balance.

Allow manual capital updates through Telegram.

---

# 3. API Configuration

## 3.1 Exchange API

Use official Indodax Public API for market data.

Documentation:

https://github.com/btcid/indodax-official-api-docs

Relevant documentation:

- Public REST API
- Market Data WebSocket
- Public market information

Do not implement Private Trade API in the MVP.

## 3.2 API Credentials

Keep these environment variables empty initially:

```env
INDODAX_API_KEY=
INDODAX_SECRET_KEY=
```

Important:

- Do not require API credentials for public market data.
- Do not generate or request API secrets during initial setup.
- Do not expose API credentials in Telegram.
- Do not include credentials in AI prompts.
- Do not log API secrets.
- Private API integration is out of scope for this MVP.

If future development requires read-only account balance access, implement it as a separate optional module with explicit user approval.

## 3.3 AI Configuration

```env
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
```

The application must validate required environment variables at startup.

If Claude credentials are missing, market data collection and deterministic analysis should still work. AI explanations can be disabled gracefully.

## 3.4 Telegram Configuration

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_ID=
```

Only the configured Telegram user ID may control the bot.

---

# 4. System Architecture

```text
                    TELEGRAM
                       |
                       v
                  Telegram Bot
                       |
                       v
                 Application Core
                       |
          +------------+------------+
          |                         |
          v                         v
     Market Scanner             User Settings
          |
          v
     Indodax Public API
          |
     +----+-------------------+
     |                        |
     v                        v
  REST API                WebSocket
     |                        |
     +------------+-----------+
                  |
                  v
             Market Data
                  |
                  v
          Technical Analysis
                  |
                  v
           Strategy Engine
                  |
                  v
             Risk Engine
                  |
                  v
             Claude Agent
                  |
                  v
           Signal Generator
                  |
                  v
           Telegram Alert
                  |
                  v
               USER
                  |
                  v
       Manual Indodax Trading
```

The system must not contain an order execution service.

---

# 5. Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js |
| Language | TypeScript |
| Telegram Bot | grammY |
| AI | Anthropic Claude API |
| Database | PostgreSQL |
| ORM | Prisma |
| Scheduler | BullMQ |
| Queue | Redis |
| Technical Indicators | technicalindicators |
| Exchange Integration | Custom Indodax Public API Adapter |
| Logging | Pino |
| Deployment | VPS + Docker |

Use modular architecture and TypeScript strict mode.

---

# 6. Market Data Integration

## 6.1 Primary Data Source

Indodax Public API.

The application must retrieve:

- Current ticker.
- Market summary.
- OHLCV candles.
- Order book.
- Recent trades.
- 24-hour high and low.
- Best bid and best ask.

Use REST for initial data retrieval and fallback.

Use WebSocket for live market updates where supported.

Do not scrape TradingView or the Indodax website.

## 6.2 WebSocket

Official endpoint documented by Indodax:

`wss://ws3.indodax.com/ws/`

Use supported market channels for:

- Chart.
- Market summary.
- Trade activity.
- Order book.

Implement:

- Automatic reconnect.
- Heartbeat.
- Re-subscription.
- Duplicate event handling.
- Connection monitoring.
- REST fallback.

Verify exact channel names, payload formats, and subscription messages using current official documentation.

## 6.3 Required Market Data

| Data | Purpose |
|---|---|
| OHLCV 5m | Entry timing |
| OHLCV 15m | Trend analysis |
| EMA 9 | Short momentum |
| EMA 20 | Short trend |
| EMA 50 | Main trend |
| RSI 14 | Momentum |
| ATR 14 | Volatility |
| Volume MA 20 | Volume comparison |
| Bid/Ask | Order book |
| Spread | Transaction efficiency |
| Recent trades | Buyer/seller activity |
| 24h High/Low | Market context |
| Last price | Current valuation |

Indicators must be calculated locally by TypeScript.

Do not rely on Claude to calculate technical indicators.

## 6.4 Data Quality

Before producing any recommendation, validate:

- Pair is active.
- Data timestamps are valid.
- Candles are sufficiently complete.
- Latest market price is available.
- Order book is available.
- Spread calculation is correct.
- Market data is not stale.
- WebSocket connection is healthy or REST fallback works.

If critical data is missing, return `DATA_UNAVAILABLE`.

Never generate BUY recommendations from incomplete or stale data.

---

# 7. Technical Analysis Engine

## 7.1 Timeframes

Main timeframe: 15 minutes.

Entry timeframe: 5 minutes.

Use completed candles for confirmed indicator decisions.

Current unfinished candles may be used for early warnings but must be clearly identified as unconfirmed.

## 7.2 Indicators

### EMA

Calculate:

- EMA 9
- EMA 20
- EMA 50

Timeframes: 5m and 15m.

### RSI

- Period: 14.
- Timeframes: 5m and 15m.

### ATR

- Period: 14.
- Timeframe: 5m.

### Volume

Calculate:

- Current volume.
- Average volume of last 20 completed candles.
- Volume ratio.

Formula:

`Volume Ratio = Current Volume / Average Volume 20`

### Order Book

Calculate:

- Best bid.
- Best ask.
- Bid/ask spread.
- Bid volume.
- Ask volume.
- Bid/ask imbalance.
- Liquidity near the current price.

Do not rely exclusively on the displayed buy/sell percentage.

Order book analysis must consider recent trades and rapid order cancellations where possible.

---

# 8. Strategy Engine

The Strategy Engine is deterministic.

Claude explains and evaluates the output but cannot invent or override technical values.

## 8.1 BUY Criteria

Initial configurable rules:

1. EMA 9 > EMA 20 on 5m.
2. EMA 9 > EMA 20 on 15m.
3. Price above EMA 20 on 15m.
4. Trend is not declining sharply.
5. RSI 5m between 50 and 70.
6. Volume ratio >= 1.2.
7. Spread is within acceptable limits.
8. Order book does not show strong selling pressure.
9. Expected reward/risk >= 1.5.
10. Data is fresh and valid.

All conditions must be evaluated before producing a BUY recommendation.

## 8.2 EARLY WARNING

Early Warning is important because the user does not want to miss good entry opportunities.

Trigger an EARLY WARNING when:

- Price approaches a predefined support or breakout area.
- EMA alignment is beginning to improve.
- Volume starts increasing.
- RSI begins recovering.
- Price approaches a potential entry zone.
- Conditions are promising but not fully confirmed.

EARLY WARNING is not a BUY recommendation.

Example:

```text
EARLY WARNING — QNT/IDR

Harga mendekati area entry.
Momentum mulai membaik.
Volume mulai meningkat.

Belum ada konfirmasi BUY.

Pantau candle berikutnya.
```

## 8.3 WAIT

Return WAIT when:

- Trend is unclear.
- EMA alignment is not confirmed.
- Volume is weak.
- Spread is too wide.
- Price is too extended.
- Order book is inconclusive.
- Reward/risk is insufficient.

## 8.4 NO TRADE

Return NO TRADE when:

- Market is suspended.
- Data is stale.
- Pair is unavailable.
- Market data API is unhealthy.
- The daily loss limit has been reached.
- Risk validation fails.

## 8.5 Signal Priority

The system should prioritize:

1. Confirmed BUY candidate.
2. EARLY WARNING.
3. WAIT.
4. NO TRADE.

Recommend at most one primary coin at a time.

If multiple coins qualify, rank them using deterministic scoring.

---

# 9. Risk Management Engine

## 9.1 Initial Configuration

| Parameter | Value |
|---|---:|
| Analytical capital | Rp5.000.000 |
| Risk per trade | 0.5% |
| Maximum risk per trade | Rp25.000 |
| Daily loss limit | 1.5% |
| Maximum daily loss | Rp75.000 |
| Maximum suggested trades/day | 3 |
| Maximum positions | 1 |

These are configurable defaults, not guaranteed safe limits.

## 9.2 Position Sizing

Formula:

`Risk Budget = Capital × Risk Percentage`

`Risk Per Coin = Entry Price - Stop Loss`

`Quantity = Risk Budget / Risk Per Coin`

Then validate:

- Available analytical capital.
- Maximum position allocation.
- Estimated trading fees.
- Estimated slippage.
- Exchange minimum order value.
- Pair precision.

Round quantity down to supported precision.

Display both quantity and total IDR value.

## 9.3 Stop Loss

Use technical support and ATR.

Initial formula:

`SL = Entry Price - (ATR × ATR Multiplier)`

The ATR multiplier must be configurable.

Ensure stop loss is below entry price for a long spot position.

## 9.4 Take Profit

Initial minimum reward/risk ratio: 1.5.

`TP = Entry Price + (Entry Price - SL) × Reward/Risk`

Account for estimated trading fees and slippage.

## 9.5 Profit and Loss

Display:

- Gross estimated profit.
- Estimated buy fee.
- Estimated sell fee.
- Estimated slippage.
- Net estimated profit.
- Net estimated loss.

Never present gross profit as net profit.

Use configurable fee rates and label them as estimates until verified.

---

# 10. Automatic Market Scanning

## 10.1 Scheduler

Default active hours:

09:00–22:00 WIB.

Normal scan interval:

15 minutes.

The scan interval is configurable.

## 10.2 Automatic Recheck

If no opportunity exists:

1. Save the scan result.
2. Determine next scan time.
3. Schedule the next job.
4. Notify the user when appropriate.
5. Scan again automatically.

Example:

```text
11:00 — Market scan
11:01 — WAIT
11:01 — Next scan: 11:15

11:15 — Market scan
11:16 — EARLY WARNING: QNT
11:16 — Next scan: 11:20

11:20 — Market scan
11:21 — BUY candidate confirmed
11:21 — Telegram notification sent
```

Do not create duplicate jobs.

## 10.3 Dynamic Scanning

- Normal conditions: 15 minutes.
- Approaching entry zone: 5 minutes.
- Confirmed breakout conditions: 1–5 minutes if data quality allows.
- Outside active hours: no new BUY recommendations.
- API failure: exponential backoff.

Open-position monitoring is optional and separate from market scanning.

---

# 11. Telegram Bot

## 11.1 Commands

| Command | Description |
|---|---|
| `/start` | Start bot |
| `/scan` | Run immediate scan |
| `/status` | Show system status |
| `/watchlist` | Show monitored coins |
| `/addcoin` | Add pair |
| `/removecoin` | Remove pair |
| `/capital` | Update analytical capital |
| `/risk` | Show risk configuration |
| `/pause` | Pause scanning |
| `/resume` | Resume scanning |
| `/bought` | Record manual buy |
| `/sold` | Record manual sell |
| `/positions` | Show manually recorded positions |
| `/history` | Show trading history |
| `/report` | Show performance report |
| `/help` | Show help |

## 11.2 Market Scan Message

Example:

```text
CRYPTO MARKET SCAN
02 NOV 2026 — 11:30 WIB

WATCHLIST

QNT/IDR  — BUY CANDIDATE
DOGE/IDR — WAIT
XRP/IDR  — EARLY WARNING
LINK/IDR — WAIT

BEST OPPORTUNITY: QNT/IDR

Limit Buy: Rp...
Suggested Quantity: ...
Position Value: Rp...

Stop Loss: Rp...
Take Profit: Rp...

Estimated Risk: Rp...
Estimated Net Reward: Rp...

Reward/Risk: 1:1.5

Reason:
- EMA alignment confirmed
- Volume increased
- RSI supports momentum
- Spread acceptable

ACTION:
Review this opportunity in Indodax.
The user must execute the trade manually.
```

All prices must come from the latest market data and be timestamped.

## 11.3 WAIT Notification

```text
MARKET UPDATE

Belum ada setup BUY yang memenuhi syarat.

Market masih sideways.
Volume belum mendukung breakout.

Next scan: 11:45 WIB.
```

Avoid excessive notifications. Send updates when there is a meaningful change in signal status.

---

# 12. Manual Position Tracking

Since the application cannot access private account data, users can report their actual transactions through Telegram.

## 12.1 Manual Buy

Command:

`/bought`

Ask for:

- Pair.
- Actual buy price.
- Quantity.
- Trading fee if known.

Save the position in the database.

## 12.2 Manual Sell

Command:

`/sold`

Ask for:

- Pair.
- Actual sell price.
- Quantity sold.
- Trading fee if known.

Calculate:

- Gross P/L.
- Total fees.
- Net P/L.
- Return percentage.

## 12.3 Position Tracking

The system may compare manually recorded positions with public market prices.

Display:

- Actual entry.
- Current market price.
- Unrealized P/L estimate.
- Suggested stop loss.
- Suggested take profit.

Clearly distinguish estimated market valuation from verified exchange account data.

The user remains responsible for manually executing exits.

---

# 13. Claude AI Agent

## 13.1 Responsibilities

Claude is responsible for:

- Explaining market conditions.
- Summarizing technical indicators.
- Comparing watchlist coins.
- Explaining BUY, WAIT, EARLY WARNING, and NO TRADE.
- Explaining risks.
- Generating Telegram notifications.
- Summarizing daily performance.

## 13.2 Restrictions

Claude must not:

- Invent market prices.
- Invent indicator values.
- Execute trades.
- Request private exchange credentials.
- Claim to know actual account balance.
- Override risk calculations.
- Treat EARLY WARNING as BUY.
- Guarantee profit.

## 13.3 Structured Output

Use Zod validation.

Example:

```json
{
  "decision": "BUY_CANDIDATE",
  "pair": "qnt_idr",
  "timestamp": "2026-11-02T11:30:00+07:00",
  "confidence": 0.82,
  "entry_zone": {
    "min": 3570000,
    "max": 3580000
  },
  "suggested_quantity": 1.2,
  "stop_loss": 3540000,
  "take_profit": 3630000,
  "estimated_risk": 25000,
  "estimated_net_reward": 75000,
  "reasons": [
    "EMA alignment confirmed",
    "Volume increased",
    "Spread acceptable"
  ],
  "next_scan_minutes": 5
}
```

The example is illustrative only.

All numerical fields must originate from the Strategy Engine and Risk Engine, not be invented by Claude.

---

# 14. Database Design

Use PostgreSQL + Prisma.

Required tables:

## users

- id
- telegram_user_id
- username
- timezone
- created_at

## user_settings

- id
- user_id
- capital
- risk_per_trade
- daily_loss_limit
- max_daily_trades
- active_hours_start
- active_hours_end
- scanning_enabled

## watchlist

- id
- user_id
- pair
- enabled
- created_at

## candles

- id
- pair
- timeframe
- open_time
- open
- high
- low
- close
- volume

Unique key: pair + timeframe + open_time.

## market_snapshots

- id
- pair
- timestamp
- last_price
- best_bid
- best_ask
- spread
- order_book_data

## trading_signals

- id
- pair
- decision
- signal_score
- indicator_snapshot
- entry_min
- entry_max
- stop_loss
- take_profit
- estimated_risk
- estimated_reward
- status
- created_at

## positions

- id
- pair
- quantity
- average_entry
- average_exit
- position_status
- opened_at
- closed_at

## trades

- id
- position_id
- entry_price
- exit_price
- quantity
- gross_pnl
- fees
- net_pnl
- created_at

## scheduled_scans

- id
- pair
- scheduled_at
- status
- retry_count

## audit_logs

- id
- user_id
- action
- details
- created_at

---

# 15. Security

1. No exchange trading permission.
2. No withdrawal permission.
3. No Indodax Private API integration in MVP.
4. No API Secret required.
5. Restrict Telegram commands to the configured user ID.
6. Store Telegram and Claude credentials in environment secrets.
7. Never log secrets.
8. Validate all Telegram inputs.
9. Use rate limits.
10. Implement structured audit logs.

The application must continue to work with empty:

`INDODAX_API_KEY=`

`INDODAX_SECRET_KEY=`

These variables must not be required for public market data.

---

# 16. Testing

## Phase 1 — Foundation

- TypeScript project.
- Telegram bot.
- PostgreSQL.
- Redis.
- Prisma.
- Environment validation.

## Phase 2 — Market Data

- Indodax Public REST.
- Indodax WebSocket.
- Watchlist.
- Candles.
- Order book.
- Stale data detection.

## Phase 3 — Technical Analysis

- EMA 9/20/50.
- RSI 14.
- ATR 14.
- Volume ratio.
- Spread.
- Order book imbalance.

## Phase 4 — Strategy and Risk

- BUY criteria.
- WAIT criteria.
- EARLY WARNING.
- NO TRADE.
- Position sizing.
- SL/TP.
- Fee calculation.

## Phase 5 — Agent and Scheduler

- Claude integration.
- Structured output.
- Scheduled scanning.
- Dynamic scan interval.
- Telegram alerts.

## Phase 6 — Manual Trading Journal

- `/bought`.
- `/sold`.
- `/positions`.
- `/history`.
- `/report`.

## Phase 7 — Paper Trading

Record all signals without requiring real trades.

Evaluate:

- Win rate.
- Net P/L.
- Profit factor.
- Maximum drawdown.
- Average win/loss.
- Trading fees.
- Slippage.
- Missed opportunities.

---

# 17. Acceptance Criteria

The MVP is complete when:

- [ ] Telegram bot works.
- [ ] No Indodax private API is required.
- [ ] API Key and Secret Key can remain empty.
- [ ] Public market data is retrieved from Indodax.
- [ ] Watchlist is configurable.
- [ ] Candles are available for 5m and 15m.
- [ ] EMA, RSI, ATR, and volume are calculated.
- [ ] Order book and spread are analyzed.
- [ ] System generates BUY, WAIT, EARLY WARNING, and NO TRADE.
- [ ] System selects at most one primary opportunity.
- [ ] Suggested entry, quantity, SL, and TP are calculated.
- [ ] Estimated net P/L includes fees.
- [ ] Automatic market rechecking works.
- [ ] Telegram notifications work.
- [ ] Manual position recording works.
- [ ] Trading reports work.
- [ ] No order execution functionality exists.

---

# 18. Claude Code Instructions

Before coding:

1. Inspect official Indodax documentation.
2. Verify actual public API endpoints.
3. Verify WebSocket channel names and message structures.
4. Verify available candle intervals.
5. Verify market pair identifiers.
6. Implement only documented public endpoints.
7. Do not assume unsupported endpoint paths.

Development rules:

- Use TypeScript strict mode.
- Use modular architecture.
- Use Zod validation.
- Use dependency injection.
- Use Prisma.
- Use BullMQ for persistent jobs.
- Use Pino logging.
- Include automated tests.
- Include `.env.example`.
- Include Docker Compose.
- Include README setup instructions.

Suggested structure:

```text
src/
├── app/
│   ├── config/
│   ├── database/
│   └── logger/
├── bot/
│   ├── commands/
│   ├── callbacks/
│   ├── keyboards/
│   └── messages/
├── exchange/
│   └── indodax/
│       ├── public-rest.ts
│       ├── market-websocket.ts
│       └── types.ts
├── market/
│   ├── candle-service.ts
│   ├── orderbook-service.ts
│   ├── market-scanner.ts
│   └── market-validator.ts
├── indicators/
│   ├── ema.ts
│   ├── rsi.ts
│   ├── atr.ts
│   └── volume.ts
├── strategy/
│   ├── strategy-engine.ts
│   ├── signal-scoring.ts
│   └── strategy-rules.ts
├── risk/
│   ├── position-sizing.ts
│   ├── stop-loss.ts
│   ├── take-profit.ts
│   └── fee-calculator.ts
├── agent/
│   ├── claude-client.ts
│   ├── reasoning-agent.ts
│   └── schemas.ts
├── scheduler/
│   ├── scan-scheduler.ts
│   └── jobs.ts
├── journal/
│   ├── buy-entry.ts
│   ├── sell-entry.ts
│   └── performance.ts
└── main.ts
```

## Implementation Workflow

Do not generate the entire application in one step.

Start with Milestone 1 only.

After each milestone, report:

1. Files created.
2. Architecture decisions.
3. Commands to run.
4. Test results.
5. Known limitations.
6. Next milestone.

Do not move to the next milestone until the current one works.

**Final product principle:**

Build a reliable personal crypto market analyst, not an autonomous trading bot. Its primary job is to help the user identify good opportunities early, understand the risk, and make better manual trading decisions.