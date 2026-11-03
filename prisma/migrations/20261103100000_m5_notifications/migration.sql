-- AlterEnum
ALTER TYPE "NotificationStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;
