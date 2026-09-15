import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AccessJWTPayload } from '../interfaces/jwt.interface';

export const WsCurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessJWTPayload | undefined => {
    const client = ctx.switchToWs().getClient<any>();
    return client?.data?.user as AccessJWTPayload | undefined;
  },
);
