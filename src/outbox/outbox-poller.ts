import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../prisma.service';

type OutboxEvent = {
  id: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, any>;
  createdAt: Date;
  processedAt: Date | null;
};

@Injectable()
export class OutboxPoller {
  private readonly logger = new Logger(OutboxPoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async dispatchOutboxEvents() {
    const events = (await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })) as OutboxEvent[];

    if (events.length === 0) return;

    for (const event of events) {
      try {
        await this.handleEvent(event);

        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
      } catch (err) {
        this.logger.error(
          {
            outboxEventId: event.id,
            eventType: event.eventType,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to dispatch outbox event',
        );
      }
    }
  }

  private async handleEvent(event: OutboxEvent) {
    const eventType = event.eventType;

    switch (eventType) {
      case 'user-registered':
        await this.notificationService.enqueueEmailVerification({
          to: event.payload.email,
          token: event.payload.verificationToken,
        });
        break;
      case 'password-reset-requested':
        await this.notificationService.enqueuePasswordReset({
          to: event.payload.email,
          token: event.payload.resetToken,
        });
        break;
      case 'email-verification-requested':
        await this.notificationService.enqueueEmailVerification({
          to: event.payload.email,
          token: event.payload.token,
        });
        break;
      default:
        this.logger.warn(
          { eventType },
          `Unhandled outbox event type: ${eventType}`,
        );
    }
  }
}
