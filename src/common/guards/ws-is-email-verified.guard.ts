import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

@Injectable()
export class WsIsEmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<any>();
    const user = client?.data?.user;

    if (!user) {
      throw new WsException('Unauthorized');
    }

    if (!user.isEmailVerified) {
      throw new WsException(
        'Email not verified. Verify your email to place bids.',
      );
    }

    return true;
  }
}
