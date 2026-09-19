import { UnauthorizedException } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { WsJwtGuard } from './ws-jwt.guard';

const makeSocket = (overrides: Record<string, any> = {}) => ({
  handshake: { auth: {}, headers: {}, query: {} },
  data: {},
  ...overrides,
});

const makeContext = (client: any) =>
  ({
    switchToWs: () => ({ getClient: () => client }),
  }) as never;

const makeGuard = (deps: {
  verify?: (token: string) => any;
  redisGet?: () => Promise<string | null>;
}) => {
  const tokenUtils = {
    verifyAccessToken: jest.fn((token: string) =>
      deps.verify ? deps.verify(token) : { sub: 'user-1' },
    ),
  };
  const redisClient = {
    get: jest.fn(() =>
      deps.redisGet ? deps.redisGet() : Promise.resolve(null),
    ),
  };
  const redisService = { getClient: () => redisClient };
  return {
    guard: new WsJwtGuard(tokenUtils as never, redisService as never),
    tokenUtils,
    redisClient,
  };
};

describe('WsJwtGuard', () => {
  it('throws WsException (not UnauthorizedException) when no token is supplied', async () => {
    const { guard } = makeGuard({});
    const client = makeSocket();

    const error = await guard.canActivate(makeContext(client)).then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(WsException);
    expect(error).not.toBeInstanceOf(UnauthorizedException);
    expect((error as WsException).message).toBe('Access token is missing');
  });

  it('converts an invalid-token UnauthorizedException into a WsException with the real message', async () => {
    const { guard } = makeGuard({
      verify: () => {
        throw new UnauthorizedException('Invalid or expired access token');
      },
    });
    const client = makeSocket({
      handshake: {
        auth: {},
        headers: { authorization: 'Bearer bad-token' },
        query: {},
      },
    });

    const error = await guard.canActivate(makeContext(client)).then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(WsException);
    expect(error).not.toBeInstanceOf(UnauthorizedException);
    expect((error as WsException).message).toBe(
      'Invalid or expired access token',
    );
  });

  it('rejects blacklisted sessions with a WsException', async () => {
    const { guard } = makeGuard({
      verify: () => ({ sub: 'user-1', jti: 'jti-1' }),
      redisGet: () => Promise.resolve('true'),
    });
    const client = makeSocket({
      handshake: {
        auth: { token: 'Bearer good-token' },
        headers: {},
        query: {},
      },
    });

    const error = await guard.canActivate(makeContext(client)).then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(WsException);
    expect((error as WsException).message).toBe(
      'Session has expired. Please log in again.',
    );
  });

  it('maps a Redis outage to a WsException instead of leaking an internal error', async () => {
    const { guard } = makeGuard({
      verify: () => ({ sub: 'user-1', jti: 'jti-1' }),
      redisGet: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const client = makeSocket({
      handshake: {
        auth: { token: 'good-token' },
        headers: {},
        query: {},
      },
    });

    const error = await guard.canActivate(makeContext(client)).then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(WsException);
    expect((error as WsException).message).toMatch(/temporarily unavailable/);
  });

  it('attaches the payload and returns true for a valid, non-blacklisted token', async () => {
    const payload = { sub: 'user-1', jti: 'jti-1' };
    const { guard } = makeGuard({ verify: () => payload });
    const client = makeSocket({
      handshake: {
        auth: { token: 'good-token' },
        headers: {},
        query: {},
      },
    });

    await expect(guard.canActivate(makeContext(client))).resolves.toBe(true);
    expect(client.data.user).toEqual(payload);
  });
});
