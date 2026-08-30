import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TokenUtils } from './auth.util';

const makeTokenUtils = (nodeEnv = 'test') => {
  const configValues: Record<string, string> = {
    JWT_SECRET: 'test-access-secret',
    JWT_EXPIRES_IN: '15m',
    REFRESH_JWT_SECRET: 'test-refresh-secret',
    REFRESH_JWT_EXPIRES_IN: '7d',
    REFRESH_JWT_COOKIE_EXPIRES_IN: '7',
    NODE_ENV: nodeEnv,
  };

  const configService = {
    get: (key: string) => configValues[key],
  } as unknown as ConfigService;

  const client = {
    sadd: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };

  const redisService = {
    getClient: () => client,
  };

  return {
    tokenUtils: new TokenUtils(
      new JwtService({}),
      configService,
      redisService as never,
    ),
    client,
  };
};

describe('TokenUtils', () => {
  describe('access tokens', () => {
    it('round-trips the payload, injects a jti and registers it in Redis', async () => {
      const { tokenUtils, client } = makeTokenUtils();

      const token = await tokenUtils.generateAccessToken({
        sub: 'user-1',
        email: 'jane@example.com',
        role: 'USER',
        provider: 'local',
        isEmailVerified: false,
      });

      const payload = tokenUtils.verifyAccessToken(token);

      expect(payload.sub).toBe('user-1');
      expect(payload.email).toBe('jane@example.com');
      expect(payload.role).toBe('USER');
      expect(payload.provider).toBe('local');
      expect(payload.isEmailVerified).toBe(false);
      expect(typeof payload.jti).toBe('string');

      // jti registry write with the access-token lifetime as TTL
      expect(client.sadd).toHaveBeenCalledWith(
        'active-jtis:user-1',
        payload.jti,
      );
      expect(client.expire).toHaveBeenCalledWith('active-jtis:user-1', 900);
    });

    it('rejects an access token signed with another secret', () => {
      const { tokenUtils } = makeTokenUtils();

      expect(() => tokenUtils.verifyAccessToken('not-a-real-token')).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refresh tokens', () => {
    it('round-trips the subject', () => {
      const { tokenUtils } = makeTokenUtils();

      const refreshToken = tokenUtils.generateRefreshToken({ sub: 'user-9' });
      const payload = tokenUtils.verifyRefreshToken(refreshToken);

      expect(payload.sub).toBe('user-9');
    });

    it('rejects an invalid refresh token', () => {
      const { tokenUtils } = makeTokenUtils();

      expect(() => tokenUtils.verifyRefreshToken('garbage')).toThrow(
        UnauthorizedException,
      );
    });
  });

  it('keeps the two token types from validating against each other', async () => {
    const { tokenUtils } = makeTokenUtils();

    const accessToken = await tokenUtils.generateAccessToken({
      sub: 'user-1',
      email: 'jane@example.com',
      role: 'USER',
      provider: 'local',
      isEmailVerified: false,
    });
    const refreshToken = tokenUtils.generateRefreshToken({ sub: 'user-1' });

    expect(() => tokenUtils.verifyRefreshToken(accessToken)).toThrow(
      UnauthorizedException,
    );
    expect(() => tokenUtils.verifyAccessToken(refreshToken)).toThrow(
      UnauthorizedException,
    );
  });

  describe('revokeAllAccessTokens', () => {
    it('blacklists every registered jti and clears the registry', async () => {
      const { tokenUtils, client } = makeTokenUtils();
      client.smembers.mockResolvedValue(['jti-a', 'jti-b']);

      await tokenUtils.revokeAllAccessTokens('user-1');

      expect(client.smembers).toHaveBeenCalledWith('active-jtis:user-1');
      expect(client.set).toHaveBeenCalledTimes(2);
      expect(client.set).toHaveBeenCalledWith(
        'blacklist:jti-a',
        'true',
        'EX',
        900,
      );
      expect(client.set).toHaveBeenCalledWith(
        'blacklist:jti-b',
        'true',
        'EX',
        900,
      );
      expect(client.del).toHaveBeenCalledWith('active-jtis:user-1');
    });

    it('still clears the registry when no jtis were ever registered', async () => {
      const { tokenUtils, client } = makeTokenUtils();
      client.smembers.mockResolvedValue([]);

      await tokenUtils.revokeAllAccessTokens('user-42');

      expect(client.set).not.toHaveBeenCalled();
      expect(client.del).toHaveBeenCalledWith('active-jtis:user-42');
    });
  });

  describe('blacklistAccessToken', () => {
    it('blacklists a single live jti for its remaining lifetime', async () => {
      const { tokenUtils, client } = makeTokenUtils();

      await tokenUtils.blacklistAccessToken('jti-c', 120);

      expect(client.set).toHaveBeenCalledWith(
        'blacklist:jti-c',
        'true',
        'EX',
        120,
      );
    });

    it('does nothing when the token already expired', async () => {
      const { tokenUtils, client } = makeTokenUtils();

      await tokenUtils.blacklistAccessToken('jti-c', 0);

      expect(client.set).not.toHaveBeenCalled();
    });
  });

  describe('refresh cookie options', () => {
    it('is httpOnly and not secure outside production', () => {
      const { tokenUtils } = makeTokenUtils('development');

      const before = Date.now();
      const options = tokenUtils.setRefreshTokenCookieOptions();
      const after = Date.now();

      expect(options.httpOnly).toBe(true);
      expect(options.secure).toBeUndefined();
      expect(options.sameSite).toBeUndefined();

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(options.expires.getTime()).toBeGreaterThanOrEqual(
        before + sevenDaysMs,
      );
      expect(options.expires.getTime()).toBeLessThanOrEqual(
        after + sevenDaysMs,
      );
    });

    it('hardens with secure and sameSite strict in production', () => {
      const { tokenUtils } = makeTokenUtils('production');

      const options = tokenUtils.setRefreshTokenCookieOptions();

      expect(options.httpOnly).toBe(true);
      expect(options.secure).toBe(true);
      expect(options.sameSite).toBe('strict');
    });
  });
});
