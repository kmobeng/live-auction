import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AuctionsScheduler {
  private readonly logger = new Logger(AuctionsScheduler.name);

  constructor(private readonly prismaService: PrismaService) {}

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

      const ended = await this.prismaService.auction.updateMany({
        where: {
          status: { in: ['UPCOMING', 'ACTIVE'] },
          endTime: { lte: now },
        },
        data: { status: 'ENDED' },
      });

      if (activated.count > 0 || ended.count > 0) {
        this.logger.log(
          `Auction status sync: ${activated.count} activated, ${ended.count} ended`,
        );
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
