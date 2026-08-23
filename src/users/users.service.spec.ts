import bcrypt from 'bcrypt';
import crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { UsersService } from './users.service';
import type { PrismaService } from '../prisma.service';
import type { TokenUtils } from '../auth/utils/auth.util';
import type { OutboxService } from '../outbox/outbox.service';
import type { TokenStoreService } from '../redis/token-store.service';

const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');

const makeUser = (overrides: Record<string, any> = {}) => ({
  id: 'user-1',
  email: 'jane@example.com',
  name: 'Jane',
  password: '$2b$12$storedhash',
  role: 'USER',
  provider: 'local',
  needToChangePassword: false,
  isEmailVerified: true,
  passwordChangedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    refreshToken: { deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    user: { update: jest.Mock };
    refreshToken: { deleteMany: jest.Mock };
  };
  let tokenUtils: {
    revokeAllAccessTokens: jest.Mock;
    blacklistAccessToken: jest.Mock;
  };
  let tokenStore: {
    issueEmailChange: jest.Mock;
    consumeEmailChange: jest.Mock;
  };
  let outboxCreateEvent: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

    tx = {
      user: { update: jest.fn() },
      refreshToken: { deleteMany: jest.fn() },
    };

    prisma = {
      user: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: { deleteMany: jest.fn() },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };

    tokenUtils = {
      revokeAllAccessTokens: jest.fn().mockResolvedValue(undefined),
      blacklistAccessToken: jest.fn().mockResolvedValue(undefined),
    };

    tokenStore = {
      issueEmailChange: jest.fn().mockResolvedValue(undefined),
      consumeEmailChange: jest.fn().mockResolvedValue(null),
    };

    outboxCreateEvent = jest.fn().mockResolvedValue(undefined);

    service = new UsersService(
      prisma as unknown as PrismaService,
      tokenUtils as unknown as TokenUtils,
      { createEvent: outboxCreateEvent },
      tokenStore as unknown as TokenStoreService,
      {},
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('findCurrentUserService', () => {
    it('returns the account without the password hash', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      const result = await service.findCurrentUserService('user-1');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
      expect('password' in result).toBe(false);
      expect(result.email).toBe('jane@example.com');
    });

    it('rejects when the account behind the session is gone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findCurrentUserService('user-1')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('updateProfileService', () => {
    it('updates the profile and returns it sanitized', async () => {
      prisma.user.update.mockResolvedValue(makeUser({ name: 'Jane Doe' }));

      const result = await service.updateProfileService('user-1', {
        name: 'Jane Doe',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'Jane Doe' },
      });
      expect(result.name).toBe('Jane Doe');
      expect('password' in result).toBe(false);
    });

    it('rejects when the account no longer exists', async () => {
      prisma.user.update.mockRejectedValue(new Error('P2025'));

      await expect(
        service.updateProfileService('user-1', { name: 'X' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('requestEmailChangeService', () => {
    const dto = {
      newEmail: 'new-jane@example.com',
      currentPassword: 'pw12345',
    };

    it('rejects a missing account first', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.requestEmailChangeService('user-1', dto),
      ).rejects.toThrow(UnauthorizedException);

      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('rejects the wrong current password without storing anything', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.requestEmailChangeService('user-1', dto),
      ).rejects.toThrow(new ConflictException('Current password is incorrect'));

      expect(tokenStore.issueEmailChange).not.toHaveBeenCalled();
      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });

    it('rejects an unchanged email regardless of casing', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(
        service.requestEmailChangeService('user-1', {
          ...dto,
          newEmail: 'JANE@example.com',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an email another account already uses', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeUser({ id: 'user-2' }));

      await expect(
        service.requestEmailChangeService('user-1', dto),
      ).rejects.toThrow(ConflictException);

      expect(tokenStore.issueEmailChange).not.toHaveBeenCalled();
    });

    it('stores the pending change before queueing both emails through the outbox', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await service.requestEmailChangeService('user-1', dto);

      expect(bcrypt.compare).toHaveBeenCalledWith(
        'pw12345',
        '$2b$12$storedhash',
      );

      expect(tokenStore.issueEmailChange).toHaveBeenCalledTimes(1);
      const [issuedUserId, issuedNewEmail, issuedHash] =
        tokenStore.issueEmailChange.mock.calls[0];
      expect(issuedUserId).toBe('user-1');
      expect(issuedNewEmail).toBe(dto.newEmail);

      expect(
        tokenStore.issueEmailChange.mock.invocationCallOrder[0],
      ).toBeLessThan(outboxCreateEvent.mock.invocationCallOrder[0]);

      expect(outboxCreateEvent).toHaveBeenCalledTimes(1);
      const [outboxClient, outboxParams] = outboxCreateEvent.mock.calls[0];
      expect(outboxClient).toBe(prisma);
      expect(outboxParams.aggregateId).toBe('user-1');
      expect(outboxParams.aggregateType).toBe('user');
      expect(outboxParams.eventType).toBe('email-change-requested');
      expect(outboxParams.payload.email).toBe(dto.newEmail);
      expect(outboxParams.payload.previousEmail).toBe('jane@example.com');
      expect(outboxParams.payload.token).toMatch(/^\d{6}$/);
      expect(issuedHash).toBe(sha256(outboxParams.payload.token));

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('never queues an email when Redis cannot store the pending change', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      tokenStore.issueEmailChange.mockRejectedValue(
        new Error('connection refused'),
      );

      await expect(
        service.requestEmailChangeService('user-1', dto),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });
  });

  describe('confirmEmailChangeService', () => {
    const hashedCode = sha256('654321');

    it('swaps the email, un-verifies it and revokes every session', async () => {
      tokenStore.consumeEmailChange.mockResolvedValue({
        newEmail: 'new-jane@example.com',
        hash: hashedCode,
      });
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ email: 'new-jane@example.com', isEmailVerified: false }),
      );

      const result = await service.confirmEmailChangeService(
        'user-1',
        hashedCode,
        120,
        'jti-9',
      );

      expect(tokenStore.consumeEmailChange).toHaveBeenCalledWith(
        'user-1',
        hashedCode,
      );
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'new-jane@example.com' },
      });

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { email: 'new-jane@example.com', isEmailVerified: false },
      });
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });

      expect(tokenUtils.revokeAllAccessTokens).toHaveBeenCalledWith('user-1');
      expect(tokenUtils.blacklistAccessToken).toHaveBeenCalledWith(
        'jti-9',
        120,
      );

      expect(result.email).toBe('new-jane@example.com');
      expect('password' in result).toBe(false);
    });

    it('rejects an invalid or expired code without touching anything', async () => {
      tokenStore.consumeEmailChange.mockResolvedValue(null);

      await expect(
        service.confirmEmailChangeService('user-1', hashedCode, 120, 'jti-9'),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tokenUtils.revokeAllAccessTokens).not.toHaveBeenCalled();
      expect(tokenUtils.blacklistAccessToken).not.toHaveBeenCalled();
    });

    it('rejects when the address was claimed between request and confirm', async () => {
      tokenStore.consumeEmailChange.mockResolvedValue({
        newEmail: 'taken@example.com',
        hash: hashedCode,
      });
      prisma.user.findUnique.mockResolvedValue(makeUser({ id: 'user-2' }));

      await expect(
        service.confirmEmailChangeService('user-1', hashedCode, 120, 'jti-9'),
      ).rejects.toThrow(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('skips the caller jti blacklist when their access token already expired', async () => {
      tokenStore.consumeEmailChange.mockResolvedValue({
        newEmail: 'new-jane@example.com',
        hash: hashedCode,
      });
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        makeUser({ email: 'new-jane@example.com' }),
      );

      await service.confirmEmailChangeService('user-1', hashedCode, 0, 'jti-9');

      expect(tokenUtils.revokeAllAccessTokens).toHaveBeenCalledWith('user-1');
      expect(tokenUtils.blacklistAccessToken).not.toHaveBeenCalled();
    });
  });
});
