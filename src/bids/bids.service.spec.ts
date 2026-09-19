import { Test, TestingModule } from '@nestjs/testing';
import { BidsService } from './bids.service';
import { PrismaService } from '../prisma.service';
import { BidsGateway } from './bids.gateway';

describe('BidsService', () => {
  let service: BidsService;
  let prisma: {
    auction: { findUnique: jest.Mock };
    bid: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let gateway: { emitBidCreated: jest.Mock; emitOutbid: jest.Mock };

  const now = Date.now();
  const auctionRow = {
    id: 'auction-1',
    sellerId: 'seller-1',
    status: 'ACTIVE',
    startTime: new Date(now - 60_000),
    endTime: new Date(now + 3_600_000),
    startingBid: 50,
    currentBid: 100,
  };
  const lockedRow = { ...auctionRow };

  const runTransaction = (txImpl: Record<string, any>) => {
    prisma.$transaction.mockImplementation((cb: any) => cb(txImpl));
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BidsService,
        {
          provide: PrismaService,
          useValue: {
            auction: { findUnique: jest.fn() },
            bid: { create: jest.fn() },
            $transaction: jest.fn(),
          },
        },
        {
          provide: BidsGateway,
          useValue: { emitBidCreated: jest.fn(), emitOutbid: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<BidsService>(BidsService);
    prisma = module.get(PrismaService);
    gateway = module.get(BidsGateway);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('pushes bid:outbid exactly once to the previous top bidder on takeover', async () => {
    prisma.auction.findUnique.mockResolvedValue(auctionRow);
    runTransaction({
      $queryRaw: jest.fn().mockResolvedValue([lockedRow]),
      bid: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ userId: 'prev-user', amount: 100 }),
        create: jest.fn().mockResolvedValue({
          id: 'bid-2',
          auctionId: 'auction-1',
          userId: 'new-user',
          amount: 150,
          createdAt: new Date(),
          user: { id: 'new-user', name: 'Nina' },
        }),
      },
      auction: {
        update: jest
          .fn()
          .mockResolvedValue({ currentBid: 150, _count: { bids: 2 } }),
      },
    });

    await service.createBidService('new-user', {
      auctionId: 'auction-1',
      amount: 150,
    });

    expect(gateway.emitBidCreated).toHaveBeenCalledTimes(1);
    expect(gateway.emitOutbid).toHaveBeenCalledTimes(1);
    expect(gateway.emitOutbid).toHaveBeenCalledWith(
      'prev-user',
      expect.objectContaining({
        auctionId: 'auction-1',
        newAmount: 150,
        newBidderId: 'new-user',
      }),
    );
  });

  it('skips the outbid push for the first bid but notifies on self outbids', async () => {
    prisma.auction.findUnique.mockResolvedValue(auctionRow);

    // First bid: no previous top bidder.
    runTransaction({
      $queryRaw: jest.fn().mockResolvedValue([lockedRow]),
      bid: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'bid-1',
          auctionId: 'auction-1',
          userId: 'new-user',
          amount: 150,
          createdAt: new Date(),
          user: { id: 'new-user', name: 'Nina' },
        }),
      },
      auction: {
        update: jest
          .fn()
          .mockResolvedValue({ currentBid: 150, _count: { bids: 1 } }),
      },
    });
    await service.createBidService('new-user', {
      auctionId: 'auction-1',
      amount: 150,
    });
    expect(gateway.emitOutbid).not.toHaveBeenCalled();

    // Self outbid: previous top is the same user — still notified.
    gateway.emitOutbid.mockClear();
    runTransaction({
      $queryRaw: jest.fn().mockResolvedValue([lockedRow]),
      bid: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ userId: 'new-user', amount: 150 }),
        create: jest.fn().mockResolvedValue({
          id: 'bid-2',
          auctionId: 'auction-1',
          userId: 'new-user',
          amount: 160,
          createdAt: new Date(),
          user: { id: 'new-user', name: 'Nina' },
        }),
      },
      auction: {
        update: jest
          .fn()
          .mockResolvedValue({ currentBid: 160, _count: { bids: 2 } }),
      },
    });
    await service.createBidService('new-user', {
      auctionId: 'auction-1',
      amount: 160,
    });
    expect(gateway.emitOutbid).toHaveBeenCalledTimes(1);
    expect(gateway.emitOutbid).toHaveBeenCalledWith(
      'new-user',
      expect.objectContaining({
        auctionId: 'auction-1',
        newAmount: 160,
        newBidderId: 'new-user',
      }),
    );
  });
});
