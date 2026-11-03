-- CreateTable
CREATE TABLE "indicator_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "pair" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "candle_open_time" TIMESTAMP(3) NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_size" INTEGER NOT NULL,
    "engine_version" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    "market_snapshot_id" BIGINT,
    "quality_status" "DataQualityStatus" NOT NULL,
    "close" DECIMAL(38,12),
    "ema9" DECIMAL(38,12),
    "ema20" DECIMAL(38,12),
    "ema50" DECIMAL(38,12),
    "rsi14" DECIMAL(20,12),
    "atr14" DECIMAL(38,12),
    "atr14_traded" DECIMAL(38,12),
    "atr14_pct" DECIMAL(20,12),
    "volume_last" DECIMAL(38,12),
    "volume_ma20" DECIMAL(38,12),
    "volume_ma20_traded" DECIMAL(38,12),
    "volume_ratio" DECIMAL(20,12),
    "volume_ratio_traded" DECIMAL(20,12),
    "zero_volume_count_20" INTEGER,
    "supports" JSONB,
    "resistances" JSONB,
    "interpretation" JSONB NOT NULL,
    "issues" JSONB NOT NULL,

    CONSTRAINT "indicator_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "indicator_snapshots_pair_timeframe_candle_open_time_idx" ON "indicator_snapshots"("pair", "timeframe", "candle_open_time");

-- CreateIndex
CREATE UNIQUE INDEX "indicator_snapshots_pair_timeframe_candle_open_time_engine__key" ON "indicator_snapshots"("pair", "timeframe", "candle_open_time", "engine_version");
