import crypto from 'crypto';
import bcrypt from 'bcrypt';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import type { PrismaService } from '../prisma.service';
import type { TokenUtils } from './utils/auth.util';
import type { OutboxService } from '../outbox/outbox.service';
import type { RedisService } from '../redis/redis.service';
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
  isEmailVerified: false,
  passwordChangedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    refreshToken: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let tx: {
    user: { create: jest.Mock; update: jest.Mock };
    refreshToken: {
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let tokenUtils: {
    generateAccessToken: jest.Mock;
    generateRefreshToken: jest.Mock;
    verifyRefreshToken: jest.Mock;
    revokeAllAccessTokens: jest.Mock;
    blacklistAccessToken: jest.Mock;
  };
  let tokenStore: {
    issueEmailVerificationCode: jest.Mock;
    consumeEmailVerificationCode: jest.Mock;
    issuePasswordReset: jest.Mock;
    consumePasswordReset: jest.Mock;
  };
  let outboxCreateEvent: jest.Mock;
  let redisSet: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashed-password');
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);

    tx = {
      user: { create: jest.fn(), update: jest.fn() },
      refreshToken: {
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
    };

    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      refreshToken: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };

    tokenUtils = {
      generateAccessToken: jest.fn().mockResolvedValue('new-access-token'),
      generateRefreshToken: jest.fn().mockReturnValue('raw-refresh-token'),
      verifyRefreshToken: jest.fn().mockReturnValue({ sub: 'user-1' }),
      revokeAllAccessTokens: jest.fn().mockResolvedValue(undefined),
      blacklistAccessToken: jest.fn().mockResolvedValue(undefined),
    };

    tokenStore = {
      issueEmailVerificationCode: jest.fn().mockResolvedValue(undefined),
      consumeEmailVerificationCode: jest.fn().mockResolvedValue(true),
      issuePasswordReset: jest.fn().mockResolvedValue(undefined),
      consumePasswordReset: jest.fn().mockResolvedValue(null),
    };

    outboxCreateEvent = jest.fn().mockResolvedValue(undefined);
    redisSet = jest.fn().mockResolvedValue('OK');

    const configGet = (key: string) =>
      key === 'REFRESH_JWT_COOKIE_EXPIRES_IN' ? '7' : undefined;

    service = new AuthService(
      prisma as unknown as PrismaService,
      tokenUtils as unknown as TokenUtils,
      { get: configGet } as unknown as ConfigService,
      { createEvent: outboxCreateEvent },
      { getClient: () => ({ set: redisSet }) } as unknown as RedisService,
      tokenStore as unknown as TokenStoreService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('registerService', () => {
    const registerDto = {
      email: 'jane@example.com',
      password: 'sup3rsecret!',
      name: 'Jane',
    };

    it('issues the verification code before writing anything to Postgres', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      tx.user.create.mockImplementation(async (args: any) =>
        makeUser({ id: args.data.id }),
      );

      await service.registerService(registerDto);

      expect(tokenStore.issueEmailVerificationCode).toHaveBeenCalledTimes(1);
      expect(
        tokenStore.issueEmailVerificationCode.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
    });

    it('creates the user and refresh session inside one transaction plus an outbox event', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      tx.user.create.mockImplementation(async (args: any) =>
        makeUser({ id: args.data.id }),
      );

      const result = await service.registerService(registerDto);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: registerDto.email },
      });
      expect(bcrypt.hash).toHaveBeenCalledWith(registerDto.password, 12);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      expect(tx.user.create).toHaveBeenCalledTimes(1);
      const createdId = tx.user.create.mock.calls[0][0].data.id;
      expect(createdId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(tx.user.create).toHaveBeenCalledWith({
        data: {
          id: createdId,
          email: registerDto.email,
          password: 'hashed-password',
          name: registerDto.name,
        },
      });

      // the code issued up front belongs to the account being created
      const [issuedUserId, issuedHash] =
        tokenStore.issueEmailVerificationCode.mock.calls[0];
      expect(issuedUserId).toBe(createdId);
      expect(issuedHash).toEqual(expect.any(String));

      expect(tokenUtils.generateRefreshToken).toHaveBeenCalledWith({
        sub: createdId,
      });

      expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
      const refreshArgs = tx.refreshToken.create.mock.calls[0][0];
      expect(refreshArgs.data.token).toBe(sha256('raw-refresh-token'));
      expect(refreshArgs.data.userId).toBe(createdId);
      expect(refreshArgs.data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 6 * 24 * 60 * 60 * 1000,
      );
      expect(refreshArgs.data.expiresAt.getTime()).toBeLessThan(
        Date.now() + 8 * 24 * 60 * 60 * 1000,
      );

      expect(outboxCreateEvent).toHaveBeenCalledTimes(1);
      const [outboxTx, outboxParams] = outboxCreateEvent.mock.calls[0];
      expect(outboxTx).toBe(tx);
      expect(outboxParams.aggregateId).toBe(createdId);
      expect(outboxParams.aggregateType).toBe('user');
      expect(outboxParams.eventType).toBe('user-registered');
      expect(outboxParams.payload.email).toBe(registerDto.email);
      expect(outboxParams.payload.verificationToken).toMatch(/^\d{6}$/);

      expect('password' in result).toBe(false);
      expect(result.refreshToken).toBe('raw-refresh-token');
      expect(result.id).toBe(createdId);
    });

    it('rejects an existing email before writing anything', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(service.registerService(registerDto)).rejects.toThrow(
        ConflictException,
      );

      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tokenStore.issueEmailVerificationCode).not.toHaveBeenCalled();
      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });

    it('leaves Postgres untouched when Redis cannot take the code', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      tokenStore.issueEmailVerificationCode.mockRejectedValue(
        new Error('connection refused'),
      );

      await expect(service.registerService(registerDto)).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });
  });

  describe('loginService', () => {
    it('stores the hashed refresh token and returns the user without the raw one', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);

      const result = await service.loginService(user.email, 'password123');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: user.email },
      });
      expect(bcrypt.compare).toHaveBeenCalledWith('password123', user.password);
      expect(tokenUtils.generateRefreshToken).toHaveBeenCalledWith({
        sub: user.id,
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      const refreshArgs = prisma.refreshToken.create.mock.calls[0][0];
      expect(refreshArgs.data.token).toBe(sha256('raw-refresh-token'));
      expect(refreshArgs.data.userId).toBe(user.id);
      expect(refreshArgs.data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 6 * 24 * 60 * 60 * 1000,
      );

      expect('password' in result).toBe(false);
      expect(result.refreshToken).toBe('raw-refresh-token');
      expect(result.email).toBe(user.email);
    });

    it('rejects an unknown email without revealing which part failed', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.loginService('ghost@example.com', 'password123'),
      ).rejects.toThrow(new ConflictException('Invalid email or password'));

      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects a wrong password without creating a session', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.loginService(user.email, 'wrong-password'),
      ).rejects.toThrow(new ConflictException('Invalid email or password'));

      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('refreshTokenService', () => {
    it('rotates the refresh token and returns a fresh pair for a valid record', async () => {
      const record = {
        id: 'rt-1',
        userId: 'user-1',
        token: sha256('old-raw-refresh-token'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        user: makeUser(),
      };
      prisma.refreshToken.findFirst.mockResolvedValue(record);

      const result = await service.refreshTokenService(
        sha256('old-raw-refresh-token'),
        'user-1',
      );

      expect(prisma.refreshToken.findFirst).toHaveBeenCalledWith({
        where: {
          token: sha256('old-raw-refresh-token'),
          userId: 'user-1',
          expiresAt: { gt: expect.any(Date) },
        },
        include: { user: true },
      });

      expect(tokenUtils.generateAccessToken).toHaveBeenCalledWith({
        sub: 'user-1',
        email: 'jane@example.com',
        role: 'USER',
        provider: 'local',
        isEmailVerified: false,
        needToChangePassword: false,
      });
      expect(tokenUtils.generateRefreshToken).toHaveBeenCalledWith({
        sub: 'user-1',
      });

      expect(prisma.refreshToken.update).toHaveBeenCalledTimes(1);
      const updateArgs = prisma.refreshToken.update.mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: 'rt-1' });
      expect(updateArgs.data.token).toBe(sha256('raw-refresh-token'));
      expect(updateArgs.data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 6 * 24 * 60 * 60 * 1000,
      );

      expect(result).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'raw-refresh-token',
      });
    });

    it('rejects when no valid record exists and rotates nothing', async () => {
      prisma.refreshToken.findFirst.mockResolvedValue(null);

      await expect(
        service.refreshTokenService(sha256('unknown'), 'user-1'),
      ).rejects.toThrow(
        new ConflictException('Invalid or expired refresh token'),
      );

      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(tokenUtils.generateAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('logoutService', () => {
    it('deletes the matching session and blacklists the access jti while it is live', async () => {
      await service.logoutService('user-1', 'raw-refresh-token', 120, 'jti-1');

      expect(tokenUtils.verifyRefreshToken).toHaveBeenCalledWith(
        'raw-refresh-token',
      );
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', token: sha256('raw-refresh-token') },
      });
      expect(redisSet).toHaveBeenCalledWith(
        'blacklist:jti-1',
        'true',
        'EX',
        120,
      );
    });

    it('skips the blacklist when the access token already expired', async () => {
      await service.logoutService('user-1', 'raw-refresh-token', 0, 'jti-1');

      expect(redisSet).not.toHaveBeenCalled();
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('logoutAllService', () => {
    it('sweeps every live access token, deletes all sessions and blacklists the caller jti', async () => {
      await service.logoutAllService('user-1', 300, 'jti-2');

      expect(tokenUtils.revokeAllAccessTokens).toHaveBeenCalledWith('user-1');
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(tokenUtils.blacklistAccessToken).toHaveBeenCalledWith(
        'jti-2',
        300,
      );
    });

    it('skips the caller jti blacklist when their access token already expired', async () => {
      await service.logoutAllService('user-1', 0, 'jti-2');

      expect(tokenUtils.revokeAllAccessTokens).toHaveBeenCalledWith('user-1');
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledTimes(1);
      expect(tokenUtils.blacklistAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('forgotPasswordService', () => {
    it('stays silent for an unknown email so accounts cannot be enumerated', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.forgotPasswordService('ghost@example.com');

      expect(tokenStore.issuePasswordReset).not.toHaveBeenCalled();
      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });

    it('stores the link in Redis before queueing the reset email', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);

      await service.forgotPasswordService(user.email);

      expect(tokenStore.issuePasswordReset).toHaveBeenCalledTimes(1);
      expect(
        tokenStore.issuePasswordReset.mock.invocationCallOrder[0],
      ).toBeLessThan(outboxCreateEvent.mock.invocationCallOrder[0]);

      const [, issuedHash] = tokenStore.issuePasswordReset.mock.calls[0];

      expect(outboxCreateEvent).toHaveBeenCalledTimes(1);
      const [outboxClient, outboxParams] = outboxCreateEvent.mock.calls[0];
      expect(outboxClient).toBe(prisma);
      expect(outboxParams.aggregateId).toBe(user.id);
      expect(outboxParams.aggregateType).toBe('user');
      expect(outboxParams.eventType).toBe('password-reset-requested');
      expect(outboxParams.payload.email).toBe(user.email);
      expect(issuedHash).toBe(sha256(outboxParams.payload.resetToken));

      // single database statement - no transaction wrapper anymore
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('never queues an email when Redis cannot store the link', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);
      tokenStore.issuePasswordReset.mockRejectedValue(
        new Error('connection refused'),
      );

      await expect(service.forgotPasswordService(user.email)).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });
  });

  describe('resetPasswordService', () => {
    it('swaps the password, revokes sessions and sweeps live access tokens', async () => {
      tokenStore.consumePasswordReset.mockResolvedValue('user-1');

      await service.resetPasswordService('hashed-url-token', 'new-hash');

      expect(tokenStore.consumePasswordReset).toHaveBeenCalledWith(
        'hashed-url-token',
      );

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          password: 'new-hash',
          passwordChangedAt: expect.any(Date),
        }),
      });
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });

      expect(tokenUtils.revokeAllAccessTokens).toHaveBeenCalledWith('user-1');
    });

    it('rejects an unknown or expired token without changing anything', async () => {
      tokenStore.consumePasswordReset.mockResolvedValue(null);

      await expect(
        service.resetPasswordService('unknown-hash', 'new-hash'),
      ).rejects.toThrow(BadRequestException);

      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
      expect(tokenUtils.revokeAllAccessTokens).not.toHaveBeenCalled();
    });
  });

  describe('requestEmailVerificationService', () => {
    it('stores the code in Redis before queueing the email', async () => {
      await service.requestEmailVerificationService(
        'jane@example.com',
        'user-1',
      );

      expect(tokenStore.issueEmailVerificationCode).toHaveBeenCalledTimes(1);
      const [issuedUserId] =
        tokenStore.issueEmailVerificationCode.mock.calls[0];
      expect(issuedUserId).toBe('user-1');

      expect(
        tokenStore.issueEmailVerificationCode.mock.invocationCallOrder[0],
      ).toBeLessThan(outboxCreateEvent.mock.invocationCallOrder[0]);

      expect(outboxCreateEvent).toHaveBeenCalledTimes(1);
      const [outboxClient, outboxParams] = outboxCreateEvent.mock.calls[0];
      expect(outboxClient).toBe(prisma);
      expect(outboxParams.aggregateId).toBe('user-1');
      expect(outboxParams.eventType).toBe('email-verification-requested');
      expect(outboxParams.payload.email).toBe('jane@example.com');
      expect(outboxParams.payload.token).toMatch(/^\d{6}$/);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('never queues an email when Redis cannot store the code', async () => {
      tokenStore.issueEmailVerificationCode.mockRejectedValue(
        new Error('connection refused'),
      );

      await expect(
        service.requestEmailVerificationService('jane@example.com', 'user-1'),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmailTokenService', () => {
    it('marks the email verified after consuming the code and blacklists the jti', async () => {
      await service.verifyEmailTokenService(
        'pre-hashed-code',
        'user-1',
        'jti-3',
        90,
      );

      expect(tokenStore.consumeEmailVerificationCode).toHaveBeenCalledWith(
        'user-1',
        'pre-hashed-code',
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { isEmailVerified: true },
      });
      expect(tokenUtils.blacklistAccessToken).toHaveBeenCalledWith('jti-3', 90);
    });

    it('rejects an invalid or expired code without verifying anything', async () => {
      tokenStore.consumeEmailVerificationCode.mockResolvedValue(false);

      await expect(
        service.verifyEmailTokenService('bad-code', 'user-1', 'jti-3', 90),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(tokenUtils.blacklistAccessToken).not.toHaveBeenCalled();
    });

    it('skips the blacklist when the access token already expired', async () => {
      await service.verifyEmailTokenService(
        'pre-hashed-code',
        'user-1',
        'jti-3',
        0,
      );

      expect(prisma.user.update).toHaveBeenCalled();
      expect(tokenUtils.blacklistAccessToken).not.toHaveBeenCalled();
    });
  });
});
