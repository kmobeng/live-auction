import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenUtils } from '../../auth/utils/auth.util';
import { RedisService } from '../../redis/redis.service';
import { Socket } from 'socket.io';
import { AccessJWTPayload } from '../interfaces/jwt.interface';

export interface WsClient extends Socket {
  data: {
    user: AccessJWTPayload;
  };
}

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(
    private readonly tokenUtils: TokenUtils,
    private readonly redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: WsClient = context.switchToWs().getClient<Socket>();
    const token = this.extractToken(client);

    if (!token) {
      throw new UnauthorizedException('Access token is missing');
    }

    const payload = this.tokenUtils.verifyAccessToken(token);

    if (payload.jti) {
      const isBlacklisted = await this.redisService
        .getClient()
        .get(`blacklist:${payload.jti}`);
      if (isBlacklisted) {
        throw new UnauthorizedException(
          'Session has expired. Please log in again.',
        );
      }
    }

    // Attach user to socket for handlers
    client.data = client.data || {};
    client.data.user = payload;

    return true;
  }

  private extractToken(client: Socket): string | undefined {
    // 1. Check handshake auth
    const authToken = (client.handshake.auth as any)?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken.startsWith('Bearer ')
        ? authToken.split(' ')[1]
        : authToken;
    }

    // 2. Check handshake headers
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.split(' ')[1];
    }

    // 3. Check handshake query parameters
    const queryToken = (client.handshake.query as any)?.token;
    if (typeof queryToken === 'string' && queryToken.length > 0) {
      return queryToken;
    }

    return undefined;
  }
}
