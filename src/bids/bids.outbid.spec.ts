import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AddressInfo } from 'net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { BidsGateway } from './bids.gateway';
import { BidsService } from './bids.service';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';
import { WsIsEmailVerifiedGuard } from '../common/guards/ws-is-email-verified.guard';
import { PrismaService } from '../prisma.service';
import { TokenUtils } from '../auth/utils/auth.util';
import { RedisService } from '../redis/redis.service';

const AUCTION_ID = 'bcecd76a-87ba-4776-871d-bfbbfaac56bb';

const VICTIM_TOKEN = 'token-victim';
const RIVAL_TOKEN = 'token-rival';

const tokenPayload = (sub: string) => ({
  sub,
  email: `${sub}@example.com`,
  role: 'USER',
  provider: 'local',
  isEmailVerified: true,
});

const TOKENS: Record<string, unknown> = {
  [VICTIM_TOKEN]: tokenPayload('victim-1'),
  [RIVAL_TOKEN]: tokenPayload('rival-1'),
};

const activeAuction = (currentBid: number) => ({
  id: AUCTION_ID,
  sellerId: 'seller-1',
  status: 'ACTIVE',
  title: 'Vintage Camera',
  startTime: new Date(Date.now() - 60_000),
  endTime: new Date(Date.now() + 3_600_000),
  startingBid: 50,
  currentBid,
  seller: { id: 'seller-1', name: 'Ada' },
  _count: { bids: 1 },
  bids: [],
});

describe('Outbid delivery (two live sockets)', () => {
  let app: INestApplication;
  let url: string;
  let auctionRow: ReturnType<typeof activeAuction>;
  let previousTop: { userId: string; amount: number } | null;

  const txBidCreate = jest.fn();
  const txAuctionUpdate = jest.fn();
  const txBidFindFirst = jest.fn();
  const txQueryRaw = jest.fn();
  const auctionFindUnique = jest.fn();

  const tx = {
    $queryRaw: txQueryRaw,
    bid: { findFirst: txBidFindFirst, create: txBidCreate },
    auction: { update: txAuctionUpdate },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    auctionRow = activeAuction(100);
    previousTop = { userId: 'victim-1', amount: 100 };

    auctionFindUnique.mockImplementation(() =>
      Promise.resolve({ ...auctionRow }),
    );
    txQueryRaw.mockImplementation(() => Promise.resolve([{ ...auctionRow }]));
    txBidFindFirst.mockImplementation(() =>
      Promise.resolve(previousTop ? { ...previousTop } : null),
    );
    let bidSeq = 0;
    txBidCreate.mockImplementation(
      ({ data }: { data: { userId: string; amount: number } }) =>
        Promise.resolve({
          id: `bid-${++bidSeq}`,
          auctionId: AUCTION_ID,
          userId: data.userId,
          amount: data.amount,
          createdAt: new Date(),
          user: { id: data.userId, name: data.userId },
        }),
    );
    txAuctionUpdate.mockImplementation(
      ({ data }: { data: { currentBid: number } }) =>
        Promise.resolve({ currentBid: data.currentBid, _count: { bids: 2 } }),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        BidsGateway,
        BidsService,
        WsJwtGuard,
        WsIsEmailVerifiedGuard,
        {
          provide: PrismaService,
          useValue: {
            auction: { findUnique: auctionFindUnique },
            $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
          },
        },
        {
          provide: TokenUtils,
          useValue: {
            verifyAccessToken: jest.fn((token: string) => {
              const payload = TOKENS[token];
              if (!payload) {
                throw new UnauthorizedException(
                  'Invalid or expired access token',
                );
              }
              return payload;
            }),
          },
        },
        {
          provide: RedisService,
          useValue: {
            getClient: () => ({ get: jest.fn().mockResolvedValue(null) }),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.init();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  const connect = (token: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const socket = ioClient(url, {
        auth: { token },
        reconnection: false,
        transports: ['websocket'],
      });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

  // NOTE: the gateway returns `{ event, data }` (WsResponse shape), so Nest
  // delivers responses as message events (`joined`, `bid:placed`) rather
  // than invoking the emit ack callback. Tests listen for those events.
  const emitAndWait = (
    socket: ClientSocket,
    emitEvent: string,
    payload: unknown,
    listenEvent: string,
    timeoutMs = 3000,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${listenEvent} event`)),
        timeoutMs,
      );
      socket.once(listenEvent, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      socket.emit(emitEvent, payload);
    });

  const waitFor = async (
    condition: () => boolean,
    timeoutMs = 2000,
  ): Promise<void> => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for socket event');
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('pushes bid:outbid only to the previous top bidder on takeover', async () => {
    const victim = await connect(VICTIM_TOKEN);
    const rival = await connect(RIVAL_TOKEN);
    try {
      const victimOutbids: unknown[] = [];
      const rivalOutbids: unknown[] = [];
      const created: unknown[] = [];
      victim.on('bid:outbid', (p) => victimOutbids.push(p));
      rival.on('bid:outbid', (p) => rivalOutbids.push(p));
      victim.on('bid:created', (p) => created.push(p));
      rival.on('bid:created', (p) => created.push(p));

      await emitAndWait(
        victim,
        'joinAuction',
        { auctionId: AUCTION_ID },
        'joined',
      );
      await emitAndWait(
        rival,
        'joinAuction',
        { auctionId: AUCTION_ID },
        'joined',
      );

      const placed = emitAndWait(
        rival,
        'placeBid',
        {
          auctionId: AUCTION_ID,
          amount: 150,
        },
        'bid:placed',
      );

      await waitFor(() => created.length === 2);
      await waitFor(() => victimOutbids.length === 1);
      await placed;

      expect(victimOutbids[0]).toMatchObject({
        auctionId: AUCTION_ID,
        previousAmount: 100,
        newAmount: 150,
        newBidderId: 'rival-1',
      });
      expect(rivalOutbids).toHaveLength(0);
    } finally {
      victim.disconnect();
      rival.disconnect();
    }
  });

  it('stays silent on the first bid', async () => {
    previousTop = null;
    auctionRow = activeAuction(50);

    const bidder = await connect(RIVAL_TOKEN);
    try {
      const outbids: unknown[] = [];
      bidder.on('bid:outbid', (p) => outbids.push(p));

      await emitAndWait(
        bidder,
        'joinAuction',
        { auctionId: AUCTION_ID },
        'joined',
      );
      await emitAndWait(
        bidder,
        'placeBid',
        {
          auctionId: AUCTION_ID,
          amount: 100,
        },
        'bid:placed',
      );

      await new Promise((r) => setTimeout(r, 300));
      expect(outbids).toHaveLength(0);
    } finally {
      bidder.disconnect();
    }
  });

  it('stays silent on a self-outbid', async () => {
    previousTop = { userId: 'rival-1', amount: 150 };
    auctionRow = activeAuction(150);

    const bidder = await connect(RIVAL_TOKEN);
    try {
      const outbids: unknown[] = [];
      bidder.on('bid:outbid', (p) => outbids.push(p));

      await emitAndWait(
        bidder,
        'joinAuction',
        { auctionId: AUCTION_ID },
        'joined',
      );
      await emitAndWait(
        bidder,
        'placeBid',
        {
          auctionId: AUCTION_ID,
          amount: 160,
        },
        'bid:placed',
      );

      await new Promise((r) => setTimeout(r, 300));
      expect(outbids).toHaveLength(0);
    } finally {
      bidder.disconnect();
    }
  });
});
