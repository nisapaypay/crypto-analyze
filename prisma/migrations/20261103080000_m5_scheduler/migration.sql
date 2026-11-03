-- CreateEnum
CREATE TYPE "ScanKind" AS ENUM ('STRATEGY_SCAN', 'COLLECT', 'MONITOR', 'SUMMARY', 'BACKUP');

-- CreateEnum
CREATE TYPE "ScanTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'RECOVERY');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "DataGapKind" AS ENUM ('SNAPSHOT', 'CANDLE');

-- CreateEnum
CREATE TYPE "DataGapStatus" AS ENUM ('OPEN', 'BACKFILLED', 'PERMANENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScanStatus" ADD VALUE 'SKIPPED';
ALTER TYPE "ScanStatus" ADD VALUE 'INTERRUPTED';
ALTER TYPE "ScanStatus" ADD VALUE 'MISSED';

-- AlterTable
ALTER TABLE "scheduled_scans" ADD COLUMN     "cause" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "finished_at" TIMESTAMP(3),
ADD COLUMN     "kind" "ScanKind" NOT NULL DEFAULT 'STRATEGY_SCAN',
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'ALL',
ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "summary" JSONB,
ADD COLUMN     "trigger" "ScanTrigger" NOT NULL DEFAULT 'SCHEDULED';

-- CreateTable
CREATE TABLE "scan_run_items" (
    "id" BIGSERIAL NOT NULL,
    "scan_id" INTEGER NOT NULL,
    "pair" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "decision" "SignalDecision",
    "signal_id" INTEGER,
    "market_snapshot_id" BIGINT,
    "quality_status" "DataQualityStatus",
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_run_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "pair" TEXT,
    "signal_id" INTEGER,
    "dedup_key" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "suppressed_reason" TEXT,
    "template" TEXT NOT NULL,
    "text_hash" TEXT,
    "telegram_message_id" BIGINT,
    "ai_used" BOOLEAN NOT NULL DEFAULT false,
    "ai_rejected_reason" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_gaps" (
    "id" SERIAL NOT NULL,
    "kind" "DataGapKind" NOT NULL,
    "pair" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL DEFAULT '-',
    "gap_start" TIMESTAMP(3) NOT NULL,
    "gap_end" TIMESTAMP(3) NOT NULL,
    "cause" TEXT NOT NULL,
    "status" "DataGapStatus" NOT NULL DEFAULT 'OPEN',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "details" JSONB,

    CONSTRAINT "data_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduler_state" (
    "id" INTEGER NOT NULL,
    "instance_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL,
    "last_slot_at" TIMESTAMP(3),
    "clock_status" TEXT,
    "clock_skew_ms" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduler_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_run_items_pair_created_at_idx" ON "scan_run_items"("pair", "created_at");

-- CreateIndex
CREATE INDEX "scan_run_items_signal_id_idx" ON "scan_run_items"("signal_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "notifications"("dedup_key");

-- CreateIndex
CREATE INDEX "notifications_kind_created_at_idx" ON "notifications"("kind", "created_at");

-- CreateIndex
CREATE INDEX "notifications_pair_kind_created_at_idx" ON "notifications"("pair", "kind", "created_at");

-- CreateIndex
CREATE INDEX "data_gaps_pair_gap_start_idx" ON "data_gaps"("pair", "gap_start");

-- CreateIndex
CREATE UNIQUE INDEX "data_gaps_kind_pair_timeframe_gap_start_key" ON "data_gaps"("kind", "pair", "timeframe", "gap_start");

-- CreateIndex
CREATE INDEX "scheduled_scans_kind_scheduled_at_idx" ON "scheduled_scans"("kind", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_scans_kind_scope_scheduled_at_key" ON "scheduled_scans"("kind", "scope", "scheduled_at");

-- AddForeignKey
ALTER TABLE "scan_run_items" ADD CONSTRAINT "scan_run_items_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scheduled_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
