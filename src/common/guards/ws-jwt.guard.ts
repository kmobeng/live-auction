import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { TokenUtils } from '../../auth/utils/auth.util';
import { RedisService } from '../../redis/redis.service';
import { Socket } from 'socket.io';
import { AccessJWTPayload } from '../interfaces/jwt.interface';

export interface WsClient extends Socket {
  data: {
    user: AccessJWTPayload;
  };
}

/** Extracts the access token from a Socket.IO handshake (auth, header, or query). */
export function extractWsToken(client: Socket): string | undefined {
  const authToken = (client.handshake.auth as any)?.token;
  if (typeof authToken === 'string' && authToken.length > 0) {
    return authToken.startsWith('Bearer ')
      ? authToken.split(' ')[1]
      : authToken;
  }

  const header = client.handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.split(' ')[1];
  }

  const queryToken = (client.handshake.query as any)?.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  return undefined;
}

@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly tokenUtils: TokenUtils,
    private readonly redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: WsClient = context.switchToWs().getClient<Socket>();
    const token = this.extractToken(client);

    if (!token) {
      // Non-Ws exceptions surface as generic "Internal server error".
      throw new WsException('Access token is missing');
    }

    let payload: AccessJWTPayload;
    try {
      payload = this.tokenUtils.verifyAccessToken(token);
    } catch (error) {
      if (error instanceof WsException) throw error;
      const message =
        error instanceof UnauthorizedException
          ? error.message
          : 'Invalid or expired access token';
      throw new WsException(message);
    }

    if (payload.jti) {
      let isBlacklisted: string | null;
      try {
        isBlacklisted = await this.redisService
          .getClient()
          .get(`blacklist:${payload.jti}`);
      } catch (error) {
        this.logger.error(
          'Redis blacklist check failed during WS auth',
          (error as Error)?.stack ?? String(error),
        );
        throw new WsException(
          'Authentication service temporarily unavailable. Please try again.',
        );
      }
      if (isBlacklisted) {
        throw new WsException('Session has expired. Please log in again.');
      }
    }

    client.data = client.data || {};
    client.data.user = payload;

    return true;
  }

  private extractToken(client: Socket): string | undefined {
    return extractWsToken(client);
  }
}
