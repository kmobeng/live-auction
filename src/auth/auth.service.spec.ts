import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import type { PrismaService } from '../prisma.service';
import type { TokenUtils } from './utils/auth.util';
import type { RedisService } from '../redis/redis.service';

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
    user: { findUnique: jest.Mock };
    refreshToken: {
      findFirst: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
    };
    emailVerificationToken: { findUnique: jest.Mock };
    passwordResetToken: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    user: { create: jest.Mock; update: jest.Mock };
    refreshToken: {
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    emailVerificationToken: { create: jest.Mock; deleteMany: jest.Mock };
    passwordResetToken: { create: jest.Mock; deleteMany: jest.Mock };
  };
  let tokenUtils: {
    generateAccessToken: jest.Mock;
    generateRefreshToken: jest.Mock;
    verifyRefreshToken: jest.Mock;
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
      emailVerificationToken: { create: jest.fn(), deleteMany: jest.fn() },
      passwordResetToken: { create: jest.fn(), deleteMany: jest.fn() },
    };

    prisma = {
      user: { findUnique: jest.fn() },
      refreshToken: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      emailVerificationToken: { findUnique: jest.fn() },
      passwordResetToken: { findUnique: jest.fn() },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };

    tokenUtils = {
      generateAccessToken: jest.fn().mockReturnValue('new-access-token'),
      generateRefreshToken: jest.fn().mockReturnValue('raw-refresh-token'),
      verifyRefreshToken: jest.fn().mockReturnValue({ sub: 'user-1' }),
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

    it('creates the user, both tokens and an outbox event inside one transaction', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const createdUser = makeUser();
      tx.user.create.mockResolvedValue(createdUser);

      const result = await service.registerService(registerDto);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: registerDto.email },
      });
      expect(bcrypt.hash).toHaveBeenCalledWith(registerDto.password, 12);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      expect(tx.user.create).toHaveBeenCalledWith({
        data: {
          email: registerDto.email,
          password: 'hashed-password',
          name: registerDto.name,
        },
      });

      expect(tokenUtils.generateRefreshToken).toHaveBeenCalledWith({
        sub: createdUser.id,
      });

      expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
      const refreshArgs = tx.refreshToken.create.mock.calls[0][0];
      expect(refreshArgs.data.token).toBe(sha256('raw-refresh-token'));
      expect(refreshArgs.data.userId).toBe(createdUser.id);
      expect(refreshArgs.data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 6 * 24 * 60 * 60 * 1000,
      );
      expect(refreshArgs.data.expiresAt.getTime()).toBeLessThan(
        Date.now() + 8 * 24 * 60 * 60 * 1000,
      );

      expect(tx.emailVerificationToken.create).toHaveBeenCalledTimes(1);
      const verificationArgs =
        tx.emailVerificationToken.create.mock.calls[0][0];
      expect(verificationArgs.data.userId).toBe(createdUser.id);

      expect(outboxCreateEvent).toHaveBeenCalledTimes(1);
      const [outboxTx, outboxParams] = outboxCreateEvent.mock.calls[0];
      expect(outboxTx).toBe(tx);
      expect(outboxParams.aggregateId).toBe(createdUser.id);
      expect(outboxParams.aggregateType).toBe('user');
      expect(outboxParams.eventType).toBe('user-registered');
      expect(outboxParams.payload.email).toBe(registerDto.email);
      expect(outboxParams.payload.verificationToken).toMatch(/^\d{6}$/);

      expect(verificationArgs.data.token).toBe(
        sha256(outboxParams.payload.verificationToken),
      );
      expect(verificationArgs.data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 9 * 60 * 1000,
      );
      expect(verificationArgs.data.expiresAt.getTime()).toBeLessThan(
        Date.now() + 11 * 60 * 1000,
      );

      expect('password' in result).toBe(false);
      expect(result.refreshToken).toBe('raw-refresh-token');
      expect(result.id).toBe(createdUser.id);
    });

    it('rejects an existing email before writing anything', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());

      await expect(service.registerService(registerDto)).rejects.toThrow(
        ConflictException,
      );

      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });
  });

  describe('loginService', () => {
    it('stores the hashed refresh token and returns the user without the raw one', async () => {
      const user = makeUser({ password: '$2b$12$storedhash' });
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
    it('deletes every session for the user and blacklists the current access token', async () => {
      await service.logoutAllService('user-1', 300, 'jti-2');

      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(redisSet).toHaveBeenCalledWith(
        'blacklist:jti-2',
        'true',
        'EX',
        300,
      );
    });

    it('skips the blacklist when there is nothing left to invalidate', async () => {
      await service.logoutAllService('user-1', 0, 'jti-2');

      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledTimes(1);
      expect(redisSet).not.toHaveBeenCalled();
    });
  });

  describe('forgotPasswordService', () => {
    it('stays silent for an unknown email so accounts cannot be enumerated', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await service.forgotPasswordService('ghost@example.com');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(outboxCreateEvent).not.toHaveBeenCalled();
    });

    it('creates a reset token and queues the reset email through the outbox', async () => {
      const user = makeUser();
      prisma.user.findUnique.mockResolvedValue(user);

      await service.forgotPasswordService(user.email);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      expect(tx.passwordResetToken.create).toHaveBeenCalledTimes(1);
      const resetArgs = tx.passwordResetToken.create.mock.calls[0][0];
      expect(resetArgs.data.userId).toBe(user.id);
      expect(resetArgs.data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 9 * 60 * 1000,
      );
      expect(resetArgs.data.expiresAt.getTime()).toBeLessThan(
        Date.now() + 11 * 60 * 1000,
      );

      expect(outboxCreateEvent).toHaveBeenCalledTimes(1);
      const [outboxTx, outboxParams] = outboxCreateEvent.mock.calls[0];
      expect(outboxTx).toBe(tx);
      expect(outboxParams.aggregateId).toBe(user.id);
      expect(outboxParams.aggregateType).toBe('user');
      expect(outboxParams.eventType).toBe('password-reset-requested');
      expect(outboxParams.payload.email).toBe(user.email);

      expect(resetArgs.data.token).toBe(
        sha256(outboxParams.payload.resetToken),
      );
    });
  });

  describe('resetPasswordService', () => {
    it('updates the password and revokes every existing session', async () => {
      const stored = {
        userId: 'user-1',
        token: sha256('reset-token'),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      };
      prisma.passwordResetToken.findUnique.mockResolvedValue(stored);

      await service.resetPasswordService(sha256('reset-token'), 'new-hash');

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          password: 'new-hash',
          passwordChangedAt: expect.any(Date),
        }),
      });
      expect(tx.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });

    it('rejects an unknown or expired token without changing anything', async () => {
      prisma.passwordResetToken.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          userId: 'user-1',
          token: sha256('expired'),
          expiresAt: new Date(Date.now() - 1000),
        });

      await expect(
        service.resetPasswordService(sha256('unknown'), 'new-hash'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.resetPasswordService(sha256('expired'), 'new-hash'),
      ).rejects.toThrow(BadRequestException);

      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.refreshToken.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('requestEmailVerificationService', () => {
    it('creates a verification token and queues the email through the outbox in one transaction', async () => {
      await service.requestEmailVerificationService(
        'jane@example.com',
        'user-1',
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      expect(tx.emailVerificationToken.create).toHaveBeenCalledTimes(1);
      const tokenArgs = tx.emailVerificationToken.create.mock.calls[0][0];
      expect(tokenArgs.data.userId).toBe('user-1');
      expect(tokenArgs.data.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + 9 * 60 * 1000,
      );

      expect(outboxCreateEvent).toHaveBeenCalledTimes(1);
      const [outboxTx, outboxParams] = outboxCreateEvent.mock.calls[0];
      expect(outboxTx).toBe(tx);
      expect(outboxParams.aggregateId).toBe('user-1');
      expect(outboxParams.eventType).toBe('email-verification-requested');
      expect(outboxParams.payload.email).toBe('jane@example.com');
      expect(outboxParams.payload.token).toMatch(/^\d{6}$/);
      expect(tokenArgs.data.token).toBe(sha256(outboxParams.payload.token));
    });
  });

  describe('verifyEmailTokenService', () => {
    it('marks the email verified, clears tokens and blacklists the access jti', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        userId: 'user-1',
        token: sha256('654321'),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      await service.verifyEmailTokenService(
        sha256('654321'),
        'user-1',
        'jti-3',
        90,
      );

      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { isEmailVerified: true },
      });
      expect(tx.emailVerificationToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
      expect(redisSet).toHaveBeenCalledWith(
        'blacklist:jti-3',
        'true',
        'EX',
        90,
      );
    });

    it('rejects a token that belongs to another user', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        userId: 'someone-else',
        token: sha256('654321'),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      await expect(
        service.verifyEmailTokenService(
          sha256('654321'),
          'user-1',
          'jti-3',
          90,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(tx.user.update).not.toHaveBeenCalled();
      expect(redisSet).not.toHaveBeenCalled();
    });

    it('rejects an expired token without verifying anything', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        userId: 'user-1',
        token: sha256('654321'),
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(
        service.verifyEmailTokenService(
          sha256('654321'),
          'user-1',
          'jti-3',
          90,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('skips the blacklist when the access token already expired', async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        userId: 'user-1',
        token: sha256('654321'),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });

      await service.verifyEmailTokenService(
        sha256('654321'),
        'user-1',
        'jti-3',
        0,
      );

      expect(tx.user.update).toHaveBeenCalled();
      expect(redisSet).not.toHaveBeenCalled();
    });
  });
});
