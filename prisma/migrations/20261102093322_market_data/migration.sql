-- CreateEnum
CREATE TYPE "DataQualityStatus" AS ENUM ('OK', 'DEGRADED', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "market_snapshots" ADD COLUMN     "high_24h" DECIMAL(38,12),
ADD COLUMN     "low_24h" DECIMAL(38,12),
ADD COLUMN     "order_book_age_sec" INTEGER,
ADD COLUMN     "quality_issues" JSONB,
ADD COLUMN     "quality_status" "DataQualityStatus",
ADD COLUMN     "server_time" TIMESTAMP(3),
ADD COLUMN     "spread_pct" DECIMAL(20,8),
ADD COLUMN     "trade_activity" JSONB,
ADD COLUMN     "volume_base_24h" DECIMAL(38,12),
ADD COLUMN     "volume_idr_24h" DECIMAL(38,12);
