import type { RedisService } from './redis.service';
import { TokenStoreService } from './token-store.service';

const TOKEN_TTL_SECONDS = 10 * 60;

describe('TokenStoreService', () => {
  let service: TokenStoreService;
  let client: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };

  beforeEach(() => {
    client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    service = new TokenStoreService({
      getClient: () => client,
    } as unknown as RedisService);
  });

  describe('email verification codes', () => {
    it('stores the hashed code per user with a 10 minute TTL', async () => {
      await service.issueEmailVerificationCode('user-1', 'hash-abc');

      expect(client.set).toHaveBeenCalledWith(
        'verify-email:user-1',
        'hash-abc',
        'EX',
        TOKEN_TTL_SECONDS,
      );
    });

    it('consumes a matching code exactly once', async () => {
      client.get.mockResolvedValue('hash-abc');

      const result = await service.consumeEmailVerificationCode(
        'user-1',
        'hash-abc',
      );

      expect(result).toBe(true);
      expect(client.del).toHaveBeenCalledWith('verify-email:user-1');
    });

    it('rejects a mismatching code without deleting it so retries stay possible', async () => {
      client.get.mockResolvedValue('hash-abc');

      const result = await service.consumeEmailVerificationCode(
        'user-1',
        'hash-wrong',
      );

      expect(result).toBe(false);
      expect(client.del).not.toHaveBeenCalled();
    });

    it('rejects when no code was issued or it already expired', async () => {
      const result = await service.consumeEmailVerificationCode(
        'user-1',
        'hash-abc',
      );

      expect(result).toBe(false);
      expect(client.del).not.toHaveBeenCalled();
    });

    it('replacing an issue overwrites the previous code for that user', async () => {
      await service.issueEmailVerificationCode('user-1', 'hash-old');
      await service.issueEmailVerificationCode('user-1', 'hash-new');

      expect(client.set).toHaveBeenCalledTimes(2);
      expect(client.set).toHaveBeenLastCalledWith(
        'verify-email:user-1',
        'hash-new',
        'EX',
        TOKEN_TTL_SECONDS,
      );
    });
  });

  describe('pending email changes', () => {
    it('round-trips the new email through the stored payload', async () => {
      await service.issueEmailChange('user-1', 'new@example.com', 'hash-123');

      expect(client.set).toHaveBeenCalledWith(
        'email-change:user-1',
        JSON.stringify({ newEmail: 'new@example.com', hash: 'hash-123' }),
        'EX',
        TOKEN_TTL_SECONDS,
      );

      client.get.mockResolvedValue(
        JSON.stringify({ newEmail: 'new@example.com', hash: 'hash-123' }),
      );
      const consumed = await service.consumeEmailChange('user-1', 'hash-123');
      expect(consumed).toEqual({ newEmail: 'new@example.com', hash: 'hash-123' });
      expect(client.del).toHaveBeenCalledWith('email-change:user-1');
    });

    it('rejects a wrong code without consuming the pending change', async () => {
      client.get.mockResolvedValue(
        JSON.stringify({ newEmail: 'new@example.com', hash: 'hash-123' }),
      );

      const consumed = await service.consumeEmailChange('user-1', 'nope');

      expect(consumed).toBeNull();
      expect(client.del).not.toHaveBeenCalled();
    });

    it('returns null when nothing is pending or it expired', async () => {
      const consumed = await service.consumeEmailChange('user-1', 'hash-123');
      expect(consumed).toBeNull();
    });
  });

  describe('password reset links', () => {
    it('stores the link keyed by hash plus an owner pointer for replacement', async () => {
      await service.issuePasswordReset('user-1', 'hash-1');

      expect(client.set).toHaveBeenCalledWith(
        'reset-pw:hash-1',
        'user-1',
        'EX',
        TOKEN_TTL_SECONDS,
      );
      expect(client.set).toHaveBeenCalledWith(
        'reset-pw-owner:user-1',
        'hash-1',
        'EX',
        TOKEN_TTL_SECONDS,
      );
    });

    it('deletes the previous link when a new one is requested', async () => {
      client.get.mockResolvedValue('hash-1');

      await service.issuePasswordReset('user-1', 'hash-2');

      expect(client.del).toHaveBeenCalledWith('reset-pw:hash-1');
      expect(client.set).toHaveBeenNthCalledWith(
        1,
        'reset-pw:hash-2',
        'user-1',
        'EX',
        TOKEN_TTL_SECONDS,
      );
      expect(client.set).toHaveBeenNthCalledWith(
        2,
        'reset-pw-owner:user-1',
        'hash-2',
        'EX',
        TOKEN_TTL_SECONDS,
      );
    });

    it('consumes by hash, returns the owner and clears both keys', async () => {
      client.get.mockResolvedValueOnce('user-1');

      const userId = await service.consumePasswordReset('hash-1');

      expect(userId).toBe('user-1');
      expect(client.del).toHaveBeenCalledWith(
        'reset-pw:hash-1',
        'reset-pw-owner:user-1',
      );
    });

    it('returns null for an unknown or expired hash', async () => {
      const userId = await service.consumePasswordReset('unknown-hash');
      expect(userId).toBeNull();
      expect(client.del).not.toHaveBeenCalled();
    });
  });
});
