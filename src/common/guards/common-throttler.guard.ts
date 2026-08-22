import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(
    context,
    throttlerLimitDetail,
  ): Promise<void> {
    throw new ThrottlerException(
      `Too many requests. Please try again in ${Math.ceil(throttlerLimitDetail.ttl / 60000)} minutes.`,
    );
  }
}
