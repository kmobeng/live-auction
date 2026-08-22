import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import { Logger } from '@nestjs/common';

interface SendEmailOptions {
  email: string;
  subject: string;
  message: string;
  html?: string;
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter!: Transporter;

  constructor(private readonly configService: ConfigService) {
    if (!this.configService.get('EMAIL_FROM')) {
      throw new Error('EMAIL_FROM is missing in environment variables');
    }
  }

  onModuleInit() {
    this.transporter = nodemailer.createTransport({
      host: 'localhost',
      port: 1025,
      secure: false,
    });
  }

  async sendEmailDev(options: SendEmailOptions) {
    try {
      await this.transporter.sendMail({
        from: this.configService.get('EMAIL_FROM'),
        to: options.email,
        subject: options.subject,
        text: options.message,
        html: options.html,
      });
    } catch (err) {
      this.logger.error(`Failed to send email to ${options.email}`, err);
      throw new InternalServerErrorException('Failed to send email');
    }
  }
}
