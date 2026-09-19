import { WsException } from '@nestjs/websockets';
import { AuctionStatus } from '../../generated/prisma/enums';
import { BidsGateway } from './bids.gateway';

const AUCTION_ID = 'bcecd76a-87ba-4776-871d-bfbbfaac56bb';

const makeSocket = (
  handshake: Record<string, any> = {},
  data: Record<string, any> = { user: { sub: 'user-1' } },
) => ({
  join: jest.fn().mockResolvedValue(undefined),
  leave: jest.fn().mockResolvedValue(undefined),
  to: jest.fn(() => ({ emit: jest.fn() })),
  data,
  handshake: { auth: {}, headers: {}, query: {}, ...handshake },
});

const makeAuthMocks = (
  opts: {
    payload?: any;
    verifyError?: unknown;
    blacklisted?: string | null;
  } = {},
) => {
  const tokenUtils = {
    verifyAccessToken: jest.fn(() => {
      if (opts.verifyError) throw opts.verifyError;
      return opts.payload ?? { sub: 'user-1' };
    }),
  };
  const redisClient = {
    get: jest.fn().mockResolvedValue(opts.blacklisted ?? null),
  };
  return {
    tokenUtils,
    redisClient,
    redisService: { getClient: () => redisClient },
  };
};

const makeGateway = (authOpts: Parameters<typeof makeAuthMocks>[0] = {}) => {
  const findUnique = jest.fn();
  const prisma = { auction: { findUnique } } as never;
  const auth = makeAuthMocks(authOpts);
  const gateway = new BidsGateway(
    prisma,
    {} as never,
    auth.tokenUtils as never,
    auth.redisService as never,
  );
  gateway.server = {
    to: jest.fn(() => ({ emit: jest.fn() })),
    sockets: {
      adapter: { rooms: new Map([[`auction:${AUCTION_ID}`, new Set(['a'])]]) },
    },
  } as never;

  const now = Date.now();
  findUnique.mockImplementation(({ select }: any) => {
    if (select) {
      return Promise.resolve({
        id: AUCTION_ID,
        status: AuctionStatus.ACTIVE,
        startTime: new Date(now - 60_000),
        endTime: new Date(now + 3_600_000),
      });
    }
    return Promise.resolve({
      id: AUCTION_ID,
      title: 'Vintage Camera',
      status: AuctionStatus.ACTIVE,
      seller: { id: 'seller-1', name: 'Ada' },
      startTime: new Date(now - 60_000),
      endTime: new Date(now + 3_600_000),
      _count: { bids: 0 },
      bids: [],
    });
  });

  return { gateway, findUnique };
};

describe('BidsGateway auctionId normalization', () => {
  describe('joinAuction', () => {
    it('accepts the exact UUID from the bug report', async () => {
      const { gateway } = makeGateway();
      const result = await gateway.handleJoinAuction(
        { auctionId: AUCTION_ID },
        makeSocket() as never,
      );
      expect(result).toMatchObject({ event: 'joined' });
    });

    it('accepts a whitespace-padded UUID (copy-paste)', async () => {
      const { gateway } = makeGateway();
      const result = await gateway.handleJoinAuction(
        { auctionId: `  ${AUCTION_ID}\n` },
        makeSocket() as never,
      );
      expect(result).toMatchObject({ event: 'joined' });
    });

    it('accepts a stringified-JSON payload (Postman Text mode)', async () => {
      const { gateway } = makeGateway();
      const result = await gateway.handleJoinAuction(
        JSON.stringify({ auctionId: AUCTION_ID }) as never,
        makeSocket() as never,
      );
      expect(result).toMatchObject({ event: 'joined' });
    });

    it('still rejects garbage with Invalid auctionId', async () => {
      const { gateway, findUnique } = makeGateway();
      for (const bad of [
        { auctionId: 'not-a-uuid' },
        { auctionId: '' },
        {},
        'not json at all',
      ]) {
        await expect(
          gateway.handleJoinAuction(bad as never, makeSocket() as never),
        ).rejects.toMatchObject({ message: 'Invalid auctionId' });
      }
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('leaveAuction', () => {
    it('accepts a whitespace-padded UUID', async () => {
      const { gateway } = makeGateway();
      const result = await gateway.handleLeaveAuction(
        { auctionId: ` ${AUCTION_ID} ` },
        { sub: 'user-1' } as never,
        makeSocket() as never,
      );
      expect(result).toMatchObject({ event: 'left' });
    });

    it('still rejects garbage with Invalid auctionId', async () => {
      const { gateway } = makeGateway();
      await expect(
        gateway.handleLeaveAuction(
          { auctionId: 'nope' },
          { sub: 'user-1' } as never,
          makeSocket() as never,
        ),
      ).rejects.toBeInstanceOf(WsException);
    });
  });

  describe('handleConnection', () => {
    it('joins the personal outbid room when the handshake token is valid', async () => {
      const { gateway } = makeGateway({
        payload: { sub: 'user-9', jti: 'jti-9' },
      });
      const socket = makeSocket({ auth: { token: 'good-token' } }, {});

      await gateway.handleConnection(socket as never);

      expect(socket.join).toHaveBeenCalledWith('user:user-9');
      expect(socket.data.user).toEqual({ sub: 'user-9', jti: 'jti-9' });
    });

    it('skips the join without throwing when no token is supplied', async () => {
      const { gateway } = makeGateway();
      const socket = makeSocket({}, {});

      await expect(
        gateway.handleConnection(socket as never),
      ).resolves.toBeUndefined();
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('skips the join without throwing for an invalid or blacklisted token', async () => {
      const badToken = makeGateway({
        payload: undefined,
        verifyError: new Error('Invalid or expired access token'),
      });
      const badSocket = makeSocket({ auth: { token: 'bad' } }, {});
      await expect(
        badToken.gateway.handleConnection(badSocket as never),
      ).resolves.toBeUndefined();
      expect(badSocket.join).not.toHaveBeenCalled();

      const blacklisted = makeGateway({
        payload: { sub: 'user-9', jti: 'jti-9' },
        blacklisted: 'true',
      });
      const blSocket = makeSocket({ auth: { token: 'old-token' } }, {});
      await expect(
        blacklisted.gateway.handleConnection(blSocket as never),
      ).resolves.toBeUndefined();
      expect(blSocket.join).not.toHaveBeenCalled();
    });
  });

  describe('emitOutbid', () => {
    it('emits bid:outbid to the previous top bidder personal room', () => {
      const { gateway } = makeGateway();
      const toSpy = jest.fn(() => ({ emit: jest.fn() }));
      (gateway as any).server = {
        to: toSpy,
        sockets: { adapter: { rooms: new Map() } },
      };
      const payload = {
        auctionId: AUCTION_ID,
        message: "you've been outbid",
        previousAmount: 100,
        newAmount: 150,
        newBidderId: 'user-1',
      };

      gateway.emitOutbid('user-2', payload);

      expect(toSpy).toHaveBeenCalledWith('user:user-2');
      expect(toSpy.mock.results[0].value.emit).toHaveBeenCalledWith(
        'bid:outbid',
        payload,
      );
    });
  });
});
