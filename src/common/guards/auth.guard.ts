import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenUtils } from '../../auth/utils/auth.util';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenUtils: TokenUtils,
    private readonly redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    let token: string | undefined;
    if (
      request.headers.authorization &&
      request.headers.authorization.startsWith('Bearer ')
    ) {
      token = request.headers.authorization.split(' ')[1];
    }

    if (!token) {
      throw new UnauthorizedException('Access token is missing');
    }

    const payload = this.tokenUtils.verifyAccessToken(token);

    const isBlacklisted = await this.redisService
      .getClient()
      .get(`blacklist:${payload.jti}`);

    if (isBlacklisted) {
      throw new UnauthorizedException(
        'Session has expired. Please log in again.',
      );
    }

    request.user = payload;

    return true;
  }
}
