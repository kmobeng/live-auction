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

  return new TokenUtils(new JwtService({}), configService);
};

describe('TokenUtils', () => {
  describe('access tokens', () => {
    it('round-trips the payload and injects a jti', () => {
      const tokenUtils = makeTokenUtils();

      const token = tokenUtils.generateAccessToken({
        sub: 'user-1',
        email: 'jane@example.com',
        role: 'USER',
        provider: 'local',
        isEmailVerified: false,
        needToChangePassword: false,
      });

      const payload = tokenUtils.verifyAccessToken(token);

      expect(payload.sub).toBe('user-1');
      expect(payload.email).toBe('jane@example.com');
      expect(payload.role).toBe('USER');
      expect(payload.provider).toBe('local');
      expect(payload.isEmailVerified).toBe(false);
      expect(payload.needToChangePassword).toBe(false);
      expect(typeof payload.jti).toBe('string');
    });

    it('rejects an access token signed with another secret', () => {
      const tokenUtils = makeTokenUtils();

      expect(() => tokenUtils.verifyAccessToken('not-a-real-token')).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refresh tokens', () => {
    it('round-trips the subject', () => {
      const tokenUtils = makeTokenUtils();

      const refreshToken = tokenUtils.generateRefreshToken({ sub: 'user-9' });
      const payload = tokenUtils.verifyRefreshToken(refreshToken);

      expect(payload.sub).toBe('user-9');
    });

    it('rejects an invalid refresh token', () => {
      const tokenUtils = makeTokenUtils();

      expect(() => tokenUtils.verifyRefreshToken('garbage')).toThrow(
        UnauthorizedException,
      );
    });
  });

  it('keeps the two token types from validating against each other', () => {
    const tokenUtils = makeTokenUtils();

    const accessToken = tokenUtils.generateAccessToken({
      sub: 'user-1',
      email: 'jane@example.com',
      role: 'USER',
      provider: 'local',
      isEmailVerified: false,
      needToChangePassword: false,
    });
    const refreshToken = tokenUtils.generateRefreshToken({ sub: 'user-1' });

    expect(() => tokenUtils.verifyRefreshToken(accessToken)).toThrow(
      UnauthorizedException,
    );
    expect(() => tokenUtils.verifyAccessToken(refreshToken)).toThrow(
      UnauthorizedException,
    );
  });

  describe('refresh cookie options', () => {
    it('is httpOnly and not secure outside production', () => {
      const tokenUtils = makeTokenUtils('development');

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
      const tokenUtils = makeTokenUtils('production');

      const options = tokenUtils.setRefreshTokenCookieOptions();

      expect(options.httpOnly).toBe(true);
      expect(options.secure).toBe(true);
      expect(options.sameSite).toBe('strict');
    });
  });
});
