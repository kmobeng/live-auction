import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { BidsGateway } from '../bids/bids.gateway';

@Injectable()
export class AuctionsScheduler {
  private readonly logger = new Logger(AuctionsScheduler.name);

  constructor(
    private readonly prismaService: PrismaService,
    @Inject(forwardRef(() => BidsGateway))
    private readonly bidsGateway: BidsGateway,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async syncAuctionStatuses() {
    const now = new Date();

    try {
      const activated = await this.prismaService.auction.updateMany({
        where: {
          status: 'UPCOMING',
          startTime: { lte: now },
          endTime: { gt: now },
        },
        data: { status: 'ACTIVE' },
      });

      const endedResult = await this.prismaService.auction.updateMany({
        where: {
          status: { in: ['UPCOMING', 'ACTIVE'] },
          endTime: { lte: now },
        },
        data: { status: 'ENDED' },
      });

      if (activated.count > 0 || endedResult.count > 0) {
        this.logger.log(
          `Auction status sync: ${activated.count} activated, ${endedResult.count} ended`,
        );
      }

      // Broadcast auction:ended for each auction that just closed.
      // We derive winner from last bid (highest) — no winnerId column.
      if (endedResult.count > 0) {
        const recentlyEnded = await this.prismaService.auction.findMany({
          where: {
            status: 'ENDED',
            endTime: { lte: now },
            // only those updated very recently to avoid re-broadcasting old ENDED
            updatedAt: { gte: new Date(now.getTime() - 60_000) },
          },
          select: {
            id: true,
            title: true,
            currentBid: true,
            endTime: true,
            bids: {
              orderBy: [{ amount: 'desc' }, { createdAt: 'desc' }],
              take: 1,
              select: {
                amount: true,
                user: { select: { id: true, name: true } },
                createdAt: true,
              },
            },
            _count: { select: { bids: true } },
          },
        });

        for (const auction of recentlyEnded) {
          const top = (auction as any).bids?.[0] ?? null;
          this.bidsGateway.emitAuctionEnded(auction.id, {
            auctionId: auction.id,
            title: (auction as any).title,
            winner: top ? top.user : null,
            finalPrice: top ? top.amount : (auction as any).currentBid,
            bidCount: (auction as any)._count.bids,
            endedAt: (auction as any).endTime,
          });
        }
      }
    } catch (err) {
      this.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to sync auction statuses',
      );
    }
  }
}
