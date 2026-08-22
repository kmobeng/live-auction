import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateEmailDto } from './dto/update-email.dto';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import type { User } from '../../generated/prisma/client';
import { TokenUtils } from '../auth/utils/auth.util';
import { OutboxService } from '../outbox/outbox.service';
import { TokenStoreService } from '../redis/token-store.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly tokenUtils: TokenUtils,
    private readonly outboxService: OutboxService,
    private readonly tokenStoreService: TokenStoreService,
  ) {}

  async findCurrentUserService(
    userId: string,
  ): Promise<Omit<User, 'password'>> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    return this.sanitize(user);
  }

  async updateProfileService(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<Omit<User, 'password'>> {
    const updated = await this.prismaService.user.update({
      where: { id: userId },
      data: { name: dto.name },
    });

    if (!updated) {
      throw new UnauthorizedException('Account no longer exists');
    }

    return this.sanitize(updated);
  }

  async requestEmailChangeService(
    userId: string,
    dto: UpdateEmailDto,
  ): Promise<void> {
    // Validate the request and ensure the user exists
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { email: true, password: true },
    });

    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    if (!(await bcrypt.compare(dto.currentPassword, user.password))) {
      throw new ConflictException('Current password is incorrect');
    }

    // Validate that the new email is different and not already taken
    if (dto.newEmail.toLowerCase() === user.email.toLowerCase()) {
      throw new BadRequestException(
        'The new email must be different from your current email',
      );
    }

    const emailTaken = await this.prismaService.user.findUnique({
      where: { email: dto.newEmail },
    });

    if (emailTaken) {
      throw new ConflictException('This email is already in use');
    }

    const token = crypto.randomInt(100000, 999999).toString();
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Store in Redis first so an outage never emails a dead code
    try {
      await this.tokenStoreService.issueEmailChange(userId, hashedToken);
    } catch (_error) {
      throw new ServiceUnavailableException(
        'Unable to process your request right now. Please try again.',
      );
    }

    await this.prismaService.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { pendingEmail: dto.newEmail },
      });

      await this.outboxService.createEvent(this.prismaService, {
        aggregateId: userId,
        aggregateType: 'user',
        eventType: 'email-change-requested',
        payload: {
          email: dto.newEmail,
          previousEmail: user.email,
          token,
        },
      });
    });
  }

  async confirmEmailChangeService(
    userId: string,
    hashedCode: string,
    remainingTtl: number,
    jti: string,
  ): Promise<Omit<User, 'password'>> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { pendingEmail: true },
    });

    if (!user || !user.pendingEmail) {
      throw new BadRequestException('No pending email change found');
    }

    const pending = user.pendingEmail;

    const isValid: boolean = await this.tokenStoreService.consumeEmailChange(
      userId,
      hashedCode,
    );

    if (!isValid) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const taken = await this.prismaService.user.findUnique({
      where: { email: pending },
    });

    if (taken && taken.id !== userId) {
      throw new ConflictException('This email is already in use');
    }

    await this.prismaService.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          email: pending,
          isEmailVerified: true,
        },
      });

      await tx.refreshToken.deleteMany({
        where: { userId },
      });
    });

    await this.tokenUtils.revokeAllAccessTokens(userId);

    if (remainingTtl > 0) {
      await this.tokenUtils.blacklistAccessToken(jti, remainingTtl);
    }

    return this.sanitize(taken!);
  }

  private sanitize(user: User): Omit<User, 'password'> {
    const { password: _password, ...rest } = user;
    return rest;
  }
}
