import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

type EmailVerificationData = {
  to: string;
  token: string;
};

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  constructor(@InjectQueue('notification') private notificationsQueue: Queue) {}

  async enqueueEmailVerification(data: EmailVerificationData): Promise<void> {
    await this.notificationsQueue.add('send-email-verification', data);
  }

  async enqueuePasswordReset(data: EmailVerificationData): Promise<void> {
    await this.notificationsQueue.add('send-password-reset', data);
  }
}
