import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { BidsGateway } from '../bids/bids.gateway';

@Injectable()
export class AuctionsScheduler {
  private readonly logger = new Logger(AuctionsScheduler.name);

  // IDs already announced via auction:ended in this process. Prevents
  // re-broadcasting old ENDED auctions on every tick while still letting a
  // missed close through on the next tick (ids are only added after a
  // successful emit).
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

      // Broadcast auction:ended for every auction that is closed but may not
      // have been announced yet. Unlike the previous updatedAt-window
      // heuristic, this re-selects all ENDED auctions past their endTime, so
      // a close missed by one tick is picked up by the next instead of going
      // silent forever. We derive winner from last bid (highest) — no
      // winnerId column.
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
          const top = (auction as any).bids?.[0] ?? null;
          const emitted = this.bidsGateway.emitAuctionEnded(auction.id, {
            auctionId: auction.id,
            title: (auction as any).title,
            winner: top ? top.user : null,
            finalPrice: top ? top.amount : (auction as any).currentBid,
            bidCount: (auction as any)._count.bids,
            endedAt: (auction as any).endTime,
          });
          // Only mark announced on success — a failed emit is retried next tick.
          if (emitted) this.announcedEnded.add(auction.id);
        } catch (err) {
          // One bad row must not abort the rest of the batch.
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
