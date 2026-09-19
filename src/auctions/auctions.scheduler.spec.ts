import { AuctionsScheduler } from './auctions.scheduler';

const makeScheduler = (closed: any[]) => {
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const findMany = jest.fn().mockResolvedValue(closed);
  const prisma = { auction: { updateMany, findMany } } as never;
  const emitAuctionEnded = jest.fn().mockReturnValue(true);
  const scheduler = new AuctionsScheduler(prisma, {
    emitAuctionEnded,
  } as never);
  return { scheduler, updateMany, findMany, emitAuctionEnded };
};

const endedAuction = (overrides: Record<string, any> = {}) => ({
  id: 'auction-1',
  title: 'Vintage Camera',
  currentBid: 100,
  endTime: new Date(Date.now() - 60_000),
  bids: [
    {
      amount: 150,
      user: { id: 'user-2', name: 'Bob' },
      createdAt: new Date(Date.now() - 120_000),
    },
  ],
  _count: { bids: 2 },
  ...overrides,
});

describe('AuctionsScheduler', () => {
  it('broadcasts auction:ended with winner, finalPrice and bidCount on close', async () => {
    const { scheduler, emitAuctionEnded } = makeScheduler([endedAuction()]);

    await scheduler.syncAuctionStatuses();

    expect(emitAuctionEnded).toHaveBeenCalledTimes(1);
    expect(emitAuctionEnded).toHaveBeenCalledWith(
      'auction-1',
      expect.objectContaining({
        auctionId: 'auction-1',
        winner: { id: 'user-2', name: 'Bob' },
        finalPrice: 150,
        bidCount: 2,
      }),
    );
  });

  it('still broadcasts an already-ENDED auction with stale updatedAt (the missed-tick regression)', async () => {
    // Under the old updatedAt-window heuristic this row was never selected,
    // so the close went silent forever. The new logic selects every ENDED
    // auction past its endTime regardless of updatedAt.
    const stale = {
      ...endedAuction(),
      endTime: new Date(Date.now() - 24 * 3_600_000),
      updatedAt: new Date(Date.now() - 24 * 3_600_000),
    };
    const { scheduler, emitAuctionEnded } = makeScheduler([stale]);

    await scheduler.syncAuctionStatuses();

    expect(emitAuctionEnded).toHaveBeenCalledTimes(1);
  });

  it('broadcasts winner null with currentBid fallback when nobody bid', async () => {
    const { scheduler, emitAuctionEnded } = makeScheduler([
      endedAuction({ bids: [], _count: { bids: 0 }, currentBid: 50 }),
    ]);

    await scheduler.syncAuctionStatuses();

    expect(emitAuctionEnded).toHaveBeenCalledWith(
      'auction-1',
      expect.objectContaining({ winner: null, finalPrice: 50 }),
    );
  });

  it('does not re-broadcast the same close on the next tick', async () => {
    const { scheduler, emitAuctionEnded } = makeScheduler([endedAuction()]);

    await scheduler.syncAuctionStatuses();
    await scheduler.syncAuctionStatuses();

    expect(emitAuctionEnded).toHaveBeenCalledTimes(1);
  });

  it('retries an emit that failed instead of marking it announced', async () => {
    const { scheduler, emitAuctionEnded } = makeScheduler([endedAuction()]);
    emitAuctionEnded.mockReturnValueOnce(false);

    await scheduler.syncAuctionStatuses();
    await scheduler.syncAuctionStatuses();

    expect(emitAuctionEnded).toHaveBeenCalledTimes(2);
  });

  it('one failing row does not abort the rest of the batch', async () => {
    const { scheduler, emitAuctionEnded } = makeScheduler([
      endedAuction({ id: 'bad-1' }),
      endedAuction({ id: 'good-2' }),
    ]);
    emitAuctionEnded.mockImplementation((id: string) => {
      if (id === 'bad-1') throw new Error('boom');
      return true;
    });

    await scheduler.syncAuctionStatuses();

    expect(emitAuctionEnded).toHaveBeenCalledTimes(2);
  });
});
