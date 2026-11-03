-- CreateEnum
CREATE TYPE "SignalDecision" AS ENUM ('BUY_CANDIDATE', 'EARLY_WARNING', 'WAIT', 'NO_TRADE', 'DATA_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "username" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "capital" DECIMAL(20,2) NOT NULL,
    "risk_per_trade" DECIMAL(6,3) NOT NULL,
    "daily_loss_limit" DECIMAL(6,3) NOT NULL,
    "max_daily_trades" INTEGER NOT NULL,
    "max_active_positions" INTEGER NOT NULL,
    "active_hours_start" TEXT NOT NULL,
    "active_hours_end" TEXT NOT NULL,
    "scanning_enabled" BOOLEAN NOT NULL DEFAULT true,
    "scan_interval_minutes" INTEGER NOT NULL,
    "main_timeframe" TEXT NOT NULL,
    "entry_timeframe" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "pair" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candles" (
    "id" BIGSERIAL NOT NULL,
    "pair" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "open_time" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(38,12) NOT NULL,
    "high" DECIMAL(38,12) NOT NULL,
    "low" DECIMAL(38,12) NOT NULL,
    "close" DECIMAL(38,12) NOT NULL,
    "volume" DECIMAL(38,12) NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "pair" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "last_price" DECIMAL(38,12) NOT NULL,
    "best_bid" DECIMAL(38,12) NOT NULL,
    "best_ask" DECIMAL(38,12) NOT NULL,
    "spread" DECIMAL(38,12) NOT NULL,
    "order_book_data" JSONB NOT NULL,

    CONSTRAINT "market_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_signals" (
    "id" SERIAL NOT NULL,
    "pair" TEXT NOT NULL,
    "decision" "SignalDecision" NOT NULL,
    "signal_score" DECIMAL(10,4),
    "indicator_snapshot" JSONB NOT NULL,
    "entry_min" DECIMAL(38,12),
    "entry_max" DECIMAL(38,12),
    "stop_loss" DECIMAL(38,12),
    "take_profit" DECIMAL(38,12),
    "estimated_risk" DECIMAL(20,2),
    "estimated_reward" DECIMAL(20,2),
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "pair" TEXT NOT NULL,
    "quantity" DECIMAL(38,12) NOT NULL,
    "average_entry" DECIMAL(38,12) NOT NULL,
    "average_exit" DECIMAL(38,12),
    "position_status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" SERIAL NOT NULL,
    "position_id" INTEGER NOT NULL,
    "entry_price" DECIMAL(38,12) NOT NULL,
    "exit_price" DECIMAL(38,12) NOT NULL,
    "quantity" DECIMAL(38,12) NOT NULL,
    "gross_pnl" DECIMAL(20,2) NOT NULL,
    "fees" DECIMAL(20,2) NOT NULL,
    "net_pnl" DECIMAL(20,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_scans" (
    "id" SERIAL NOT NULL,
    "pair" TEXT,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scheduled_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_user_id_pair_key" ON "watchlist"("user_id", "pair");

-- CreateIndex
CREATE UNIQUE INDEX "candles_pair_timeframe_open_time_key" ON "candles"("pair", "timeframe", "open_time");

-- CreateIndex
CREATE INDEX "market_snapshots_pair_timestamp_idx" ON "market_snapshots"("pair", "timestamp");

-- CreateIndex
CREATE INDEX "trading_signals_pair_created_at_idx" ON "trading_signals"("pair", "created_at");

-- CreateIndex
CREATE INDEX "positions_user_id_position_status_idx" ON "positions"("user_id", "position_status");

-- CreateIndex
CREATE INDEX "scheduled_scans_status_scheduled_at_idx" ON "scheduled_scans"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
