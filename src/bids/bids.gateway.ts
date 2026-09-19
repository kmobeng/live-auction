import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import {
  Inject,
  Logger,
  UseFilters,
  UseGuards,
  UsePipes,
  ValidationPipe,
  forwardRef,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';
import { WsIsEmailVerifiedGuard } from '../common/guards/ws-is-email-verified.guard';
import { PrismaService } from '../prisma.service';
import { AuctionStatus } from '../../generated/prisma/enums';
import { WsCurrentUser } from '../common/decorators/ws-current-user.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { WsExceptionFilter } from '../common/filters/ws-exception.filter';
import { BidsService } from './bids.service';
import { CreateBidDto } from './dto/create-bid.dto';

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Normalizes the incoming `auctionId` from a WS payload.
 *
 * - Accepts the payload as an object (`{ auctionId }`) or as a
 *   stringified-JSON payload (some Socket.IO clients / Postman Text mode
 *   deliver the body as a string).
 * - Trims surrounding whitespace (copy-pasted IDs often carry a trailing
 *   space or newline, which breaks the anchored UUID check).
 * - Returns `undefined` when no usable ID can be extracted.
 */
function normalizeAuctionId(data: unknown): string | undefined {
  let payload: unknown = data;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  const auctionId = (payload as { auctionId?: unknown } | null)?.auctionId;
  if (typeof auctionId !== 'string') return undefined;
  const trimmed = auctionId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type LiveState = {
  id: string;
  title: string;
  status: AuctionStatus;
  seller: { id: string; name: string | null };
  startTime: Date;
  endTime: Date;
  bidCount: number;
  participantCount: number;
  topBid: {
    amount: number;
    createdAt: Date;
    bidder: { id: string; name: string | null };
  } | null;
  serverTime: string;
  timeRemainingMs: number;
} | null;

@UseFilters(WsExceptionFilter)
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class BidsGateway {
  private readonly logger = new Logger(BidsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BidsService))
    private readonly bidsService: BidsService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);

    const user = (client as any).data?.user as AccessJWTPayload | undefined;
    if (user?.sub) {
      void client.join(this.userRoomName(user.sub));
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    if (!this.server) return;
    try {
      const rooms = (client as any).rooms as Set<string> | undefined;
      if (rooms) {
        for (const room of rooms) {
          if (room.startsWith('auction:')) {
            const auctionId = room.slice('auction:'.length);
            // client already left, get size after leave
            const participantCount = this.getRoomSize(auctionId);
            this.server.to(room).emit('auction:participantCount', {
              auctionId,
              participantCount,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('joinAuction')
  async handleJoinAuction(
    @MessageBody() data: { auctionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const auctionId = normalizeAuctionId(data);
    if (!auctionId || !isUUID(auctionId)) {
      this.logger.warn(
        `joinAuction rejected: invalid auctionId (received ${typeof data}, ` +
          `preview: ${JSON.stringify(data)?.slice(0, 60)})`,
      );
      throw new WsException('Invalid auctionId');
    }

    const user = (client as any).data?.user;
    if (!user?.sub) {
      throw new WsException('Unauthorized');
    }

    const auction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      select: {
        id: true,
        status: true,
        startTime: true,
        endTime: true,
      },
    });

    if (!auction) {
      throw new WsException('Auction not found');
    }

    const now = new Date();
    if (
      auction.endTime.getTime() <= now.getTime() ||
      auction.status === AuctionStatus.ENDED
    ) {
      throw new WsException('Auction has ended');
    }

    const room = this.roomName(auctionId);
    await client.join(room);
    // Ensure personal outbid room exists
    await client.join(this.userRoomName(user.sub));
    this.logger.log(`User ${user.sub} joined room ${room}`);

    const fullAuction = await this.prisma.auction.findUnique({
      where: { id: auctionId },
      include: {
        seller: { select: { id: true, name: true } },
        _count: { select: { bids: true } },
        bids: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            amount: true,
            createdAt: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    const participantCount = this.getRoomSize(auctionId);

    const liveState: LiveState = fullAuction
      ? {
          id: fullAuction.id,
          title: fullAuction.title,
          status: fullAuction.status,
          seller: fullAuction.seller,
          startTime: fullAuction.startTime,
          endTime: fullAuction.endTime,
          bidCount: fullAuction._count.bids,
          participantCount,
          topBid: fullAuction.bids[0]
            ? {
                amount: Number(fullAuction.bids[0].amount),
                createdAt: fullAuction.bids[0].createdAt,
                bidder: fullAuction.bids[0].user,
              }
            : null,
          serverTime: new Date().toISOString(),
          timeRemainingMs:
            fullAuction.status === AuctionStatus.ENDED
              ? 0
              : Math.max(
                  (fullAuction.status === AuctionStatus.UPCOMING
                    ? fullAuction.startTime
                    : fullAuction.endTime
                  ).getTime() - Date.now(),
                  0,
                ),
        }
      : null;

    // Broadcast live count to room (including joiner for sync)
    this.server.to(room).emit('auction:participantCount', {
      auctionId,
      participantCount,
    });
    // Broadcast participant joined event to room (excluding joiner)
    client.to(room).emit('participant:joined:ws', {
      auctionId,
      userId: user.sub,
    });

    // Send live state to the joiner
    return { event: 'joined', data: liveState };
  }

  @UseGuards(WsJwtGuard, WsIsEmailVerifiedGuard)
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  @SubscribeMessage('placeBid')
  async handlePlaceBid(
    @MessageBody() dto: CreateBidDto,
    @WsCurrentUser() user: AccessJWTPayload,
    @ConnectedSocket() client: Socket,
  ) {
    if (!user?.sub) throw new WsException('Unauthorized');
    // Ensure personal room for outbid before bid
    await client.join(this.userRoomName(user.sub));
    // Delegate to service which handles FOR UPDATE locking + broadcasts
    const result = await this.bidsService.createBidService(user.sub, dto);
    // Return ack to bidder (also broadcast already sent)
    return { event: 'bid:placed', data: result };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('leaveAuction')
  async handleLeaveAuction(
    @MessageBody() data: { auctionId: string },
    @WsCurrentUser() user: AccessJWTPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const auctionId = normalizeAuctionId(data);
    if (!auctionId || !isUUID(auctionId)) {
      this.logger.warn(
        `leaveAuction rejected: invalid auctionId (received ${typeof data}, ` +
          `preview: ${JSON.stringify(data)?.slice(0, 60)})`,
      );
      throw new WsException('Invalid auctionId');
    }
    const room = this.roomName(auctionId);
    await client.leave(room);
    this.logger.log(`Client ${client.id} left room ${room}`);
    const participantCount = this.getRoomSize(auctionId);
    this.server.to(room).emit('auction:participantCount', {
      auctionId,
      participantCount,
    });
    // Broadcast participant left event to room (excluding leaver)
    client.to(room).emit('participant:left:ws', {
      auctionId,
      userId: user.sub,
    });
    return { event: 'left', data: { auctionId, participantCount } };
  }

  getRoomSize(auctionId: string): number {
    if (!this.server) return 0; // If the server is not available, return 0
    const room = this.roomName(auctionId);
    return this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
  }

  emitBidCreated(
    auctionId: string,
    payload: {
      id: string;
      amount: any;
      userId: string;
      userName?: string | null;
      createdAt: Date;
      currentBid: any;
      bidCount: number;
    },
  ) {
    if (!this.server) return;
    const room = this.roomName(auctionId);
    this.server.to(room).emit('bid:created', payload);
    this.server.to(room).emit('auction:currentBid', {
      auctionId,
      currentBid: payload.currentBid,
      bidCount: payload.bidCount,
    });
  }

  emitOutbid(
    outbidUserId: string,
    payload: {
      auctionId: string;
      message: string;
      previousAmount: any;
      newAmount: any;
      newBidderId: string;
      newBidderName?: string | null;
    },
  ) {
    if (!this.server) return;
    // Personal room — only previous top bidder receives this
    this.server.to(this.userRoomName(outbidUserId)).emit('bid:outbid', payload);
  }

  emitAuctionEnded(auctionId: string, payload: Record<string, any>) {
    if (!this.server) return;
    this.server.to(this.roomName(auctionId)).emit('auction:ended', payload);
  }

  private roomName(auctionId: string): string {
    return `auction:${auctionId}`;
  }

  private userRoomName(userId: string): string {
    return `user:${userId}`;
  }
}
