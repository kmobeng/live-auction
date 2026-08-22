import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AccessJWTPayload,
  RefreshJWTPayload,
} from '../../common/interfaces/jwt.interface';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';

const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;

@Injectable()
export class TokenUtils {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  setRefreshTokenCookieOptions() {
    const RefreshCookieOptions: any = {
      expires: new Date(
        Date.now() +
          Number(this.configService.get('REFRESH_JWT_COOKIE_EXPIRES_IN')) *
            24 *
            60 *
            60 *
            1000,
      ),
      httpOnly: true,
    };

    if (this.configService.get('NODE_ENV') === 'production') {
      RefreshCookieOptions.secure = true;
      RefreshCookieOptions.sameSite = 'strict';
    }
    return RefreshCookieOptions;
  }

  async generateAccessToken(payload: AccessJWTPayload): Promise<string> {
    const jti = randomUUID();
    payload.jti = jti;

    const token = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_SECRET'),
      expiresIn: this.configService.get('JWT_EXPIRES_IN'),
    });

    // Track the jti so a password reset / logout-all / email change can blacklist every live access token for this user in one sweep
    const registryKey = `active-jtis:${payload.sub}`;
    const ttlSeconds = this.accessTtlSeconds();
    const client = this.redisService.getClient();
    await client.sadd(registryKey, jti);
    await client.expire(registryKey, ttlSeconds);

    return token;
  }

  async blacklistAccessToken(
    jti: string,
    remainingTtlSeconds: number,
  ): Promise<void> {
    if (remainingTtlSeconds <= 0) {
      return;
    }

    await this.redisService
      .getClient()
      .set(`blacklist:${jti}`, 'true', 'EX', remainingTtlSeconds);
  }

  async revokeAllAccessTokens(userId: string): Promise<void> {
    const client = this.redisService.getClient();
    const registryKey = `active-jtis:${userId}`;

    const jtis = await client.smembers(registryKey);
    const ttlSeconds = this.accessTtlSeconds();

    await Promise.all(
      jtis.map((jti) =>
        client.set(`blacklist:${jti}`, 'true', 'EX', ttlSeconds),
      ),
    );
    await client.del(registryKey);
  }

  sendRefreshToken(res: Response, refreshToken: string): void {
    const refreshTokenCookieOptions = this.setRefreshTokenCookieOptions();
    res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);
  }

  generateRefreshToken(payload: RefreshJWTPayload): string {
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get('REFRESH_JWT_SECRET'),
      expiresIn: this.configService.get('REFRESH_JWT_EXPIRES_IN'),
    });
    return refreshToken;
  }

  verifyAccessToken(token: string): AccessJWTPayload {
    try {
      const payload = this.jwtService.verify<AccessJWTPayload>(token, {
        secret: this.configService.get('JWT_SECRET'),
      });
      return payload;
    } catch (_error) {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  verifyRefreshToken(token: string): RefreshJWTPayload {
    try {
      const payload = this.jwtService.verify<RefreshJWTPayload>(token, {
        secret: this.configService.get('REFRESH_JWT_SECRET'),
      });
      return payload;
    } catch (_error) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private accessTtlSeconds(): number {
    const raw = this.configService.get<string>('JWT_EXPIRES_IN');
    if (!raw) {
      return DEFAULT_ACCESS_TTL_SECONDS;
    }

    // Parse the TTL string (e.g., "1h", "30m", "1d")
    const match = /^(\d+)\s*([smhd])$/.exec(raw.trim());
    if (!match) {
      return DEFAULT_ACCESS_TTL_SECONDS;
    }

    const amount = Number(match[1]);
    switch (match[2]) {
      case 's':
        return amount;
      case 'm':
        return amount * 60;
      case 'h':
        return amount * 3600;
      case 'd':
        return amount * 86400;
      default:
        return DEFAULT_ACCESS_TTL_SECONDS;
    }
  }
}
