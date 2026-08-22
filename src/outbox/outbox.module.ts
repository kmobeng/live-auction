import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { NotificationModule } from '../notification/notification.module';
import { OutboxPoller } from './outbox-poller';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [NotificationModule],
  providers: [OutboxService, OutboxPoller, PrismaService],
  exports: [OutboxService],
})
export class OutboxModule {}
