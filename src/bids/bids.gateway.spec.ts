import { WsException } from '@nestjs/websockets';
import { AuctionStatus } from '../../generated/prisma/enums';
import { BidsGateway } from './bids.gateway';

const AUCTION_ID = 'bcecd76a-87ba-4776-871d-bfbbfaac56bb';

const makeSocket = () => ({
  join: jest.fn().mockResolvedValue(undefined),
  leave: jest.fn().mockResolvedValue(undefined),
  to: jest.fn(() => ({ emit: jest.fn() })),
  data: { user: { sub: 'user-1' } },
});

const makeGateway = () => {
  const findUnique = jest.fn();
  const prisma = { auction: { findUnique } } as never;
  const gateway = new BidsGateway(prisma, {} as never);
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
});
