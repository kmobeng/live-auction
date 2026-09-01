import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BidsGateway } from './bids.gateway';
import { CreateBidDto } from './dto/create-bid.dto';
import { Prisma } from '../../generated/prisma/client';

@Injectable()
export class BidsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: BidsGateway,
  ) {}

  async createBidService(userId: string, dto: CreateBidDto) {
    const auction = await this.prisma.auction.findUnique({
      where: { id: dto.auctionId },
      select: {
        id: true,
        sellerId: true,
        status: true,
        startTime: true,
        endTime: true,
        startingBid: true,
        currentBid: true,
      },
    });

    if (!auction) {
      throw new NotFoundException('Auction not found');
    }

    const now = new Date();

    // Must be ACTIVE by time window
    if (
      auction.status === 'ENDED' ||
      auction.endTime.getTime() <= now.getTime() ||
      auction.startTime.getTime() > now.getTime()
    ) {
      throw new BadRequestException('Auction is not active');
    }

    if (auction.sellerId === userId) {
      throw new ForbiddenException('You cannot bid on your own auction');
    }

    // WS-only: must be signed in already enforced by JwtAuthGuard, no join gate
    // Validate amount > currentBid
    const currentBidValue = auction.currentBid
      ? Number(auction.currentBid)
      : Number(auction.startingBid);
    if (dto.amount <= currentBidValue) {
      throw new BadRequestException(
        `Bid must be higher than current bid (${currentBidValue})`,
      );
    }

    // Transaction: create bid + update currentBid atomically
    const result = await this.prisma.$transaction(async (tx) => {
      // Re-check currentBid inside tx to prevent race (select for update via transaction isolation)
      const fresh = await tx.auction.findUnique({
        where: { id: dto.auctionId },
        select: { currentBid: true, startingBid: true },
      });
      const freshCurrent = fresh?.currentBid
        ? Number(fresh.currentBid)
        : Number(fresh?.startingBid ?? 0);
      if (dto.amount <= freshCurrent) {
        throw new BadRequestException(
          `Bid must be higher than current bid (${freshCurrent})`,
        );
      }

      const bid = await tx.bid.create({
        data: {
          auctionId: dto.auctionId,
          userId,
          amount: new Prisma.Decimal(dto.amount),
        },
        include: {
          user: { select: { id: true, name: true } },
        },
      });

      const updatedAuction = await tx.auction.update({
        where: { id: dto.auctionId },
        data: { currentBid: new Prisma.Decimal(dto.amount) },
        select: { currentBid: true, _count: { select: { bids: true } } },
      });

      return { bid, updatedAuction };
    });

    const bid = result.bid;
    const bidCount = result.updatedAuction._count.bids;

    // Emit WS after DB commit succeeded
    this.gateway.emitBidCreated(dto.auctionId, {
      id: bid.id,
      amount: bid.amount,
      userId: bid.userId,
      userName: (bid as any).user?.name ?? null,
      createdAt: bid.createdAt,
      currentBid: result.updatedAuction.currentBid,
      bidCount,
    });

    return {
      id: bid.id,
      auctionId: bid.auctionId,
      userId: bid.userId,
      amount: bid.amount,
      createdAt: bid.createdAt,
      currentBid: result.updatedAuction.currentBid,
      bidCount,
    };
  }
}
