import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RegisterDto } from './dto/register.dto';
import bcrypt from 'bcrypt';
import { User } from '../../generated/prisma/client';
import crypto from 'crypto';
import { TokenUtils } from './utils/auth.util';
import { OutboxService } from '../outbox/outbox.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly tokenUtils: TokenUtils,
    private readonly configService: ConfigService,
    private readonly outboxService: OutboxService,
    private readonly redisService: RedisService,
  ) {}

  async registerService(
    registerDto: RegisterDto,
  ): Promise<Omit<User, 'password'> & { refreshToken: string }> {
    const existingUser = await this.prismaService.user.findUnique({
      where: { email: registerDto.email },
    });

    if (existingUser) {
      throw new ConflictException(
        'This user already has an account. Please log in instead.',
      );
    }

    const hashpassword = await bcrypt.hash(registerDto.password, 12);

    return this.prismaService.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: registerDto.email,
          password: hashpassword,
          name: registerDto.name,
        },
      });

      const refreshToken = this.tokenUtils.generateRefreshToken({
        sub: user.id,
      });

      const hashedToken = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

      await tx.refreshToken.create({
        data: {
          token: hashedToken,
          userId: user.id,
          expiresAt: new Date(
            Date.now() +
              Number(this.configService.get('REFRESH_JWT_COOKIE_EXPIRES_IN')) *
                24 *
                60 *
                60 *
                1000,
          ),
        },
      });

      const { token, hashedToken: hashedVerificationToken } =
        this.emailTokenGeneration();

      await tx.emailVerificationToken.create({
        data: {
          userId: user.id,
          token: hashedVerificationToken,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      });

      await this.outboxService.createEvent(tx, {
        aggregateId: user.id,
        aggregateType: 'user',
        eventType: 'user-registered',
        payload: {
          email: user.email,
          verificationToken: token,
        },
      });

      const { password: _, ...userWithoutPassword } = user;
      return { ...userWithoutPassword, refreshToken };
    });
  }

  emailTokenGeneration(): { token: string; hashedToken: string } {
    const token = crypto.randomInt(100000, 999999).toString();
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    return { token, hashedToken };
  }

  async loginService(
    email: string,
    password: string,
  ): Promise<Omit<User, 'password'> & { refreshToken: string }> {
    const user = await this.prismaService.user.findUnique({
      where: { email },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new ConflictException('Invalid email or password');
    }

    const refreshToken = this.tokenUtils.generateRefreshToken({
      sub: user.id,
    });

    const hashedToken = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    await this.prismaService.refreshToken.create({
      data: {
        token: hashedToken,
        userId: user.id,
        expiresAt: new Date(
          Date.now() +
            Number(this.configService.get('REFRESH_JWT_COOKIE_EXPIRES_IN')) *
              24 *
              60 *
              60 *
              1000,
        ),
      },
    });

    const { password: _, ...userWithoutPassword } = user;

    return { ...userWithoutPassword, refreshToken };
  }

  async refreshTokenService(
    hashRefreshToken: string,
    userId: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // Check if the refresh token exists and is valid
    const refreshTokenRecord = await this.prismaService.refreshToken.findFirst({
      where: {
        token: hashRefreshToken,
        userId,
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        user: true,
      },
    });

    if (!refreshTokenRecord || refreshTokenRecord.expiresAt < new Date()) {
      throw new ConflictException('Invalid or expired refresh token');
    }

    // Generate new access and refresh tokens
    const accessPayload = {
      sub: refreshTokenRecord.user.id,
      email: refreshTokenRecord.user.email,
      role: refreshTokenRecord.user.role,
      provider: refreshTokenRecord.user.provider!,
      isEmailVerified: refreshTokenRecord.user.isEmailVerified,
      needToChangePassword: refreshTokenRecord.user.needToChangePassword,
    };

    const newAccessToken = this.tokenUtils.generateAccessToken(accessPayload);

    const newRefreshToken = this.tokenUtils.generateRefreshToken({
      sub: refreshTokenRecord.user.id,
    });

    // Hash the new refresh token before storing it
    const newHashedRefreshToken = crypto
      .createHash('sha256')
      .update(newRefreshToken)
      .digest('hex');

    await this.prismaService.refreshToken.update({
      where: { id: refreshTokenRecord.id },
      data: {
        token: newHashedRefreshToken,
        expiresAt: new Date(
          Date.now() +
            Number(this.configService.get('REFRESH_JWT_COOKIE_EXPIRES_IN')) *
              24 *
              60 *
              60 *
              1000,
        ),
      },
    });

    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }

  async logoutService(
    userId: string,
    token: string,
    remainingTTl: number,
    jti: string,
  ): Promise<void> {
    this.tokenUtils.verifyRefreshToken(token);

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    await this.prismaService.refreshToken.deleteMany({
      where: {
        userId,
        token: hashedToken,
      },
    });

    if (remainingTTl > 0) {
      await this.redisService
        .getClient()
        .set(`blacklist:${jti}`, 'true', 'EX', remainingTTl);
    }
  }

  async forgotPasswordService(email: string): Promise<void> {
    // Check if the user exists
    const user = await this.prismaService.user.findUnique({
      where: { email },
    });

    if (!user) {
      return;
    }

    // Generate a random token for password reset
    const token = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    await this.prismaService.$transaction(async (tx) => {
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          token: hashedToken,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      });

      // Create an outbox event for the password reset request
      await this.outboxService.createEvent(tx, {
        aggregateId: user.id,
        aggregateType: 'user',
        eventType: 'password-reset-requested',
        payload: {
          email: user.email,
          resetToken: token,
        },
      });
    });
  }

  async resetPasswordService(token: string, password: string): Promise<void> {
    const tokenExist = await this.prismaService.passwordResetToken.findUnique({
      where: { token },
    });

    if (!tokenExist || tokenExist.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset url');
    }

    await this.prismaService.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: tokenExist.userId },
        data: {
          password,
          passwordChangedAt: new Date(),
        },
      });

      await tx.passwordResetToken.deleteMany({
        where: { userId: tokenExist.userId },
      });

      await tx.refreshToken.deleteMany({
        where: { userId: tokenExist.userId },
      });
    });
  }

  async requestEmailVerificationService(
    email: string,
    userId: string,
  ): Promise<void> {
    const { token, hashedToken: hashedVerificationToken } =
      this.emailTokenGeneration();

    await this.prismaService.$transaction(async (tx) => {
      await tx.emailVerificationToken.create({
        data: {
          userId,
          token: hashedVerificationToken,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      });

      await this.outboxService.createEvent(tx, {
        aggregateId: userId,
        aggregateType: 'user',
        eventType: 'email-verification-requested',
        payload: {
          email,
          token: token,
        },
      });
    });
  }

  async verifyEmailTokenService(
    token: string,
    userId: string,
    jti: string,
    ttl: number,
  ): Promise<void> {
    const tokenExist =
      await this.prismaService.emailVerificationToken.findUnique({
        where: { token },
      });

    if (
      !tokenExist ||
      tokenExist.expiresAt < new Date() ||
      tokenExist.userId !== userId
    ) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    await this.prismaService.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          isEmailVerified: true,
        },
      });

      await tx.emailVerificationToken.deleteMany({
        where: { userId },
      });
    });

    if (ttl > 0) {
      await this.redisService
        .getClient()
        .set(`blacklist:${jti}`, 'true', 'EX', ttl);
    }
  }

  async createRefreshToken(
    refreshToken: string,
    userId: string,
  ): Promise<void> {
    const hashedToken = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    await this.prismaService.refreshToken.create({
      data: {
        token: hashedToken,
        userId,
        expiresAt: new Date(
          Date.now() +
            Number(this.configService.get('REFRESH_JWT_COOKIE_EXPIRES_IN')) *
              24 *
              60 *
              60 *
              1000,
        ),
      },
    });
  }
}
