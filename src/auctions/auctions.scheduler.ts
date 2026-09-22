import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { BidsGateway } from '../bids/bids.gateway';

@Injectable()
export class AuctionsScheduler {
  private readonly logger = new Logger(AuctionsScheduler.name);

  // Ids are added only after a successful emit, so failures retry next tick.
  private readonly announcedEnded = new Set<string>();

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

      // Announce every unannounced ENDED auction; winner is the highest bid.
      const closedUnannounced = await this.prismaService.auction.findMany({
        where: {
          status: 'ENDED',
          endTime: { lte: now },
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

      for (const auction of closedUnannounced) {
        if (this.announcedEnded.has(auction.id)) continue;
        try {
          const top = auction.bids?.[0] ?? null;
          const emitted = this.bidsGateway.emitAuctionEnded(auction.id, {
            auctionId: auction.id,
            title: auction.title,
            winner: top ? top.user : null,
            finalPrice: top ? top.amount : auction.currentBid,
            bidCount: auction._count.bids,
            endedAt: auction.endTime,
          });
          if (emitted) this.announcedEnded.add(auction.id);
        } catch (err) {
          this.logger.error(
            `Failed to broadcast auction:ended for auction ${auction.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
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
