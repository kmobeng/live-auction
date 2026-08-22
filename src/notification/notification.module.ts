import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { BullModule } from '@nestjs/bullmq';
import { EmailService } from '../common/utils/email.util';
import { NotificationProcessor } from './notification.provider';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'notification',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    }),
  ],
  providers: [NotificationService, EmailService, NotificationProcessor],
  exports: [NotificationService],
})
export class NotificationModule {}
