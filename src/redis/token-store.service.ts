import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

const TOKEN_TTL_SECONDS = 10 * 60;

@Injectable()
export class TokenStoreService {
  constructor(private readonly redisService: RedisService) {}

  private client() {
    return this.redisService.getClient();
  }

  async issueEmailVerificationCode(
    userId: string,
    hashedCode: string,
  ): Promise<void> {
    await this.client().set(
      `verify-email:${userId}`,
      hashedCode,
      'EX',
      TOKEN_TTL_SECONDS,
    );
  }

  async consumeEmailVerificationCode(
    userId: string,
    hashedCode: string,
  ): Promise<boolean> {
    const key = `verify-email:${userId}`;
    const stored = await this.client().get(key);
    if (!stored || stored !== hashedCode) {
      return false;
    }

    await this.client().del(key);
    return true;
  }

  async issueEmailChange(userId: string, hashedCode: string): Promise<void> {
    await this.client().set(
      `email-change:${userId}`,
      hashedCode,
      'EX',
      TOKEN_TTL_SECONDS,
    );
  }

  async consumeEmailChange(
    userId: string,
    hashedCode: string,
  ): Promise<boolean> {
    const key = `email-change:${userId}`;
    const raw = await this.client().get(key);
    if (!raw) {
      return false;
    }
    if (raw !== hashedCode) {
      return false;
    }

    await this.client().del(key);
    return true;
  }

  async issuePasswordReset(userId: string, tokenHash: string): Promise<void> {
    const client = this.client();
    const ownerKey = `reset-pw-owner:${userId}`;

    // Replace-on-request: drop the previous link so only the newest one works
    const previousHash = await client.get(ownerKey);
    if (previousHash) {
      await client.del(`reset-pw:${previousHash}`);
    }

    await client.set(`reset-pw:${tokenHash}`, userId, 'EX', TOKEN_TTL_SECONDS);
    await client.set(ownerKey, tokenHash, 'EX', TOKEN_TTL_SECONDS);
  }

  async consumePasswordReset(tokenHash: string): Promise<string | null> {
    const client = this.client();
    const key = `reset-pw:${tokenHash}`;

    const userId = await client.get(key);
    if (!userId) {
      return null;
    }

    await client.del(key, `reset-pw-owner:${userId}`);
    return userId;
  }
}
