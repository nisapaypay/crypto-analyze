-- CreateEnum
CREATE TYPE "SignalLifecycleStatus" AS ENUM ('ACTIVE', 'EXPIRED_UNFILLED', 'POSSIBLY_FILLED', 'HYPO_CLOSED');

-- CreateEnum
CREATE TYPE "SignalExecutionStatus" AS ENUM ('UNKNOWN', 'TAKEN', 'NOT_TAKEN');

-- AlterTable
ALTER TABLE "trading_signals" ADD COLUMN     "candle_open_time" TIMESTAMP(3),
ADD COLUMN     "cost_assumptions" JSONB,
ADD COLUMN     "engine_version" TEXT,
ADD COLUMN     "entry_fee_est" DECIMAL(20,2),
ADD COLUMN     "execution_status" "SignalExecutionStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "exit_fee_est" DECIMAL(20,2),
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "gates" JSONB,
ADD COLUMN     "hypo_result" JSONB,
ADD COLUMN     "lifecycle_at" TIMESTAMP(3),
ADD COLUMN     "lifecycle_status" "SignalLifecycleStatus",
ADD COLUMN     "market_snapshot_id" BIGINT,
ADD COLUMN     "net_rr" DECIMAL(20,6),
ADD COLUMN     "quantity" DECIMAL(38,12),
ADD COLUMN     "reasons" JSONB,
ADD COLUMN     "regime" TEXT,
ADD COLUMN     "reserved_risk" DECIMAL(20,2),
ADD COLUMN     "slippage_est" DECIMAL(20,2),
ADD COLUMN     "tax_est" DECIMAL(20,2);

-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "buy_fee_pct" DECIMAL(8,4),
ADD COLUMN     "buy_tax_pct" DECIMAL(8,4),
ADD COLUMN     "costs_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "entry_slippage_pct" DECIMAL(8,4),
ADD COLUMN     "max_position_alloc_pct" DECIMAL(6,3),
ADD COLUMN     "sell_fee_pct" DECIMAL(8,4),
ADD COLUMN     "sell_tax_pct" DECIMAL(8,4),
ADD COLUMN     "stop_slippage_pct" DECIMAL(8,4),
ADD COLUMN     "tp_slippage_pct" DECIMAL(8,4);

-- CreateIndex
CREATE INDEX "trading_signals_decision_created_at_idx" ON "trading_signals"("decision", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "trading_signals_pair_candle_open_time_engine_version_key" ON "trading_signals"("pair", "candle_open_time", "engine_version");

