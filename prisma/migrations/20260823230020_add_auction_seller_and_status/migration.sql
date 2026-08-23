/*
  Warnings:

  - Added the required column `sellerId` to the `Auction` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AuctionStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'ENDED');

-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "sellerId" TEXT NOT NULL,
ADD COLUMN     "status" "AuctionStatus" NOT NULL DEFAULT 'UPCOMING';

-- CreateIndex
CREATE INDEX "Auction_status_endTime_idx" ON "Auction"("status", "endTime");

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
