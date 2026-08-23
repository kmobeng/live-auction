import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { AuctionStatus, Prisma } from '../../generated/prisma/client';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { PaginationQueryDto, QueryAuctionsDto } from './dto/query-auctions.dto';

type AuctionRecord = Prisma.AuctionGetPayload<{
  include: { _count: { select: { bids: true } } };
}>;

@Injectable()
export class AuctionsService {
  constructor(private readonly prismaService: PrismaService) {}

  async createAuctionService(sellerId: string, dto: CreateAuctionDto) {
    // Validate start and end times
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);

    if (startTime.getTime() <= Date.now()) {
      throw new BadRequestException('Start time must be in the future');
    }

    if (endTime.getTime() <= startTime.getTime()) {
      throw new BadRequestException('End time must be after start time');
    }

    const auction = await this.prismaService.auction.create({
      data: {
        title: dto.title.trim(),
        description: dto.description?.trim() ?? null,
        startingBid: dto.startingBid,
        currentBid: dto.startingBid,
        sellerId,
        startTime,
        endTime,
      },
    });

    return auction;
  }

  async listAuctionsService(query: QueryAuctionsDto) {
    const status: AuctionStatus = query.status ?? 'ACTIVE';
    const where = this.statusWhere(status);

    return this.paginatedAuctionList(where, query, this.orderForStatus(status));
  }

  async listMyAuctionsService(sellerId: string, query: QueryAuctionsDto) {
    const where: Prisma.AuctionWhereInput = { sellerId };

    if (query.status) {
      Object.assign(where, this.statusWhere(query.status));
    }

    const order = query.status
      ? this.orderForStatus(query.status)
      : { createdAt: 'desc' as const };

    return this.paginatedAuctionList(where, query, order);
  }

  async getAuctionByIdService(id: string) {
    const auction = await this.prismaService.auction.findUnique({
      where: { id },
      include: {
        seller: { select: { id: true, name: true } },
        _count: { select: { bids: true } },
        bids: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            amount: true,
            createdAt: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!auction) {
      throw new NotFoundException('Auction not found');
    }

    return this.toLiveState(auction);
  }

  async getAuctionBidsService(id: string, query: PaginationQueryDto) {
    const auction = await this.prismaService.auction.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!auction) {
      throw new NotFoundException('Auction not found');
    }

    const { page, limit } = this.pagination(query);
    const where: Prisma.BidWhereInput = { auctionId: id };

    const [items, total] = await this.prismaService.$transaction([
      this.prismaService.bid.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          amount: true,
          createdAt: true,
          user: { select: { id: true, name: true } },
        },
      }),
      this.prismaService.bid.count({ where }),
    ]);

    return { items, pagination: this.meta(page, limit, total) };
  }

  async updateAuctionService(
    userId: string,
    role: string,
    id: string,
    dto: UpdateAuctionDto,
  ) {
    const auction = await this.getOwnedAuctionOrFail(userId, role, id);

    const now = Date.now();
    if (auction._count.bids > 0) {
      throw new ConflictException(
        'This auction already has bids and can no longer be updated',
      );
    }
    if (auction.startTime.getTime() <= now) {
      throw new ConflictException(
        'Only auctions that have not started yet can be updated',
      );
    }

    const startTime =
      dto.startTime !== undefined ? new Date(dto.startTime) : auction.startTime;
    const endTime =
      dto.endTime !== undefined ? new Date(dto.endTime) : auction.endTime;

    if (startTime.getTime() <= now) {
      throw new BadRequestException('Start time must be in the future');
    }
    if (endTime.getTime() <= startTime.getTime()) {
      throw new BadRequestException('End time must be after start time');
    }

    const data: Prisma.AuctionUpdateInput = {};

    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) {
      data.description =
        dto.description === null ? null : dto.description.trim();
    }
    if (dto.startingBid !== undefined) {
      // No bids exist yet, so currentBid still mirrors startingBid - keep it in sync
      data.startingBid = dto.startingBid;
      data.currentBid = dto.startingBid;
    }
    if (dto.startTime !== undefined) data.startTime = startTime;
    if (dto.endTime !== undefined) data.endTime = endTime;

    return this.prismaService.auction.update({ where: { id }, data });
  }

  async deleteAuctionService(userId: string, role: string, id: string) {
    await this.getOwnedAuctionOrFail(userId, role, id);

    const bidCount = await this.prismaService.bid.count({
      where: { auctionId: id },
    });

    if (bidCount > 0) {
      throw new ConflictException(
        'This auction already has bids and can no longer be deleted',
      );
    }

    await this.prismaService.auction.delete({ where: { id } });
  }

  private statusWhere(status: AuctionStatus): Prisma.AuctionWhereInput {
    const now = new Date();

    switch (status) {
      case 'UPCOMING':
        return { status, startTime: { gt: now }, endTime: { gt: now } };
      case 'ACTIVE':
        return { status, startTime: { lte: now }, endTime: { gt: now } };
      case 'ENDED':
        return { status, endTime: { lte: now } };
    }
  }

  private orderForStatus(status: AuctionStatus) {
    switch (status) {
      case 'UPCOMING':
        return { startTime: 'asc' as const };
      case 'ENDED':
        return { endTime: 'desc' as const };
      default:
        return { endTime: 'asc' as const };
    }
  }

  private async paginatedAuctionList(
    where: Prisma.AuctionWhereInput,
    query: PaginationQueryDto,
    orderBy: Prisma.AuctionOrderByWithRelationInput,
  ) {
    const { page, limit } = this.pagination(query);

    const [items, total] = await this.prismaService.$transaction([
      this.prismaService.auction.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          seller: { select: { id: true, name: true } },
          _count: { select: { bids: true } },
        },
      }),
      this.prismaService.auction.count({ where }),
    ]);

    return {
      items: items.map((auction) => this.toListItem(auction)),
      pagination: this.meta(page, limit, total),
    };
  }

  private toLiveState(
    auction: AuctionRecord & {
      seller: { id: string; name: string | null };
      bids: Array<{
        amount: number;
        createdAt: Date;
        user: { id: string; name: string | null };
      }>;
    },
  ) {
    const now = new Date();

    // Computed from wall clock so a flip the scheduler has not persisted yet
    // is never reported stale on the detail view
    let status: AuctionStatus;
    if (now < auction.startTime) {
      status = 'UPCOMING';
    } else if (now < auction.endTime) {
      status = 'ACTIVE';
    } else {
      status = 'ENDED';
    }

    const [topBid] = auction.bids;

    return {
      id: auction.id,
      title: auction.title,
      description: auction.description,
      startingBid: auction.startingBid,
      currentBid: auction.currentBid,
      status,
      seller: auction.seller,
      startTime: auction.startTime,
      endTime: auction.endTime,
      createdAt: auction.createdAt,
      bidCount: auction._count.bids,
      topBid: topBid
        ? {
            amount: topBid.amount,
            createdAt: topBid.createdAt,
            bidder: topBid.user,
          }
        : null,
      serverTime: now.toISOString(),
      timeRemainingMs:
        status === 'ENDED'
          ? 0
          : Math.max(
              (status === 'UPCOMING'
                ? auction.startTime
                : auction.endTime
              ).getTime() - now.getTime(),
              0,
            ),
    };
  }

  private async getOwnedAuctionOrFail(
    userId: string,
    role: string,
    id: string,
  ) {
    const auction = await this.prismaService.auction.findUnique({
      where: { id },
      include: { _count: { select: { bids: true } } },
    });

    if (!auction) {
      throw new NotFoundException('Auction not found');
    }

    if (auction.sellerId !== userId && role !== 'ADMIN') {
      throw new ForbiddenException(
        'You do not have permission to modify this auction',
      );
    }

    return auction;
  }

  private toListItem(
    auction: AuctionRecord & {
      seller: { id: string; name: string | null };
    },
  ) {
    const { _count, sellerId: _sellerId, ...rest } = auction;
    return { ...rest, seller: auction.seller, bidCount: _count.bids };
  }

  private pagination(query: PaginationQueryDto) {
    return { page: query.page ?? 1, limit: query.limit ?? 10 };
  }

  private meta(page: number, limit: number, total: number) {
    return {
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    };
  }
}
