-- AlterEnum
ALTER TYPE "RunStatus" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "cancel_requested" BOOLEAN NOT NULL DEFAULT false;
