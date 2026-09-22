import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BidsGateway } from './bids.gateway';
import { CreateBidDto } from './dto/create-bid.dto';
import { Prisma } from '../../generated/prisma/client';

@Injectable()
export class BidsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BidsGateway))
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

    const currentBidValue = auction.currentBid
      ? Number(auction.currentBid)
      : Number(auction.startingBid);
    if (dto.amount <= currentBidValue) {
      throw new BadRequestException(
        `Bid must be higher than current bid (${currentBidValue})`,
      );
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        const lockedRows = await tx.$queryRaw<
          Array<{
            id: string;
            sellerId: string;
            status: string;
            startTime: Date;
            endTime: Date;
            startingBid: any;
            currentBid: any;
          }>
        >`SELECT id, "sellerId", status, "startTime", "endTime", "startingBid", "currentBid" FROM "Auction" WHERE id = ${dto.auctionId} FOR UPDATE`;

        const locked = lockedRows[0];
        if (!locked) {
          throw new NotFoundException('Auction not found');
        }

        const txNow = new Date();
        if (
          locked.status === 'ENDED' ||
          new Date(locked.endTime).getTime() <= txNow.getTime() ||
          new Date(locked.startTime).getTime() > txNow.getTime()
        ) {
          throw new BadRequestException('Auction is not active');
        }
        if (locked.sellerId === userId) {
          throw new ForbiddenException('You cannot bid on your own auction');
        }

        const freshCurrent = locked.currentBid
          ? Number(locked.currentBid)
          : Number(locked.startingBid ?? 0);
        if (dto.amount <= freshCurrent) {
          throw new BadRequestException(
            `Bid must be higher than current bid (${freshCurrent})`,
          );
        }

        const previousTop = await tx.bid.findFirst({
          where: { auctionId: dto.auctionId },
          orderBy: [{ amount: 'desc' }, { createdAt: 'desc' }],
          select: {
            userId: true,
            amount: true,
            user: { select: { name: true } },
          },
        });

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

        return { bid, updatedAuction, previousTop };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    const bid = result.bid;
    const bidCount = result.updatedAuction._count.bids;

    this.gateway.emitBidCreated(dto.auctionId, {
      id: bid.id,
      amount: bid.amount,
      userId: bid.userId,
      userName: bid.user?.name ?? null,
      createdAt: bid.createdAt,
      currentBid: result.updatedAuction.currentBid,
      bidCount,
    });

    // Notify only a different previous top bidder.
    const prev = result.previousTop;
    if (prev && prev.userId !== userId) {
      this.gateway.emitOutbid(prev.userId, {
        auctionId: dto.auctionId,
        message: "you've been outbid",
        previousAmount: prev.amount,
        newAmount: dto.amount,
        newBidderId: userId,
        newBidderName: bid.user?.name ?? null,
      });
    }

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
