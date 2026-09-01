import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';
import { PrismaService } from '../prisma.service';
import { AuctionStatus } from '../../generated/prisma/enums';

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

  constructor(private readonly prisma: PrismaService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('joinAuction')
  async handleJoinAuction(
    @MessageBody() data: { auctionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const auctionId = data?.auctionId;
    if (!auctionId || !isUUID(auctionId)) {
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
    client.to(room).emit('participant:joined:ws', {
      auctionId,
      userId: user.sub,
    });

    return { event: 'joined', data: liveState };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('leaveAuction')
  async handleLeaveAuction(
    @MessageBody() data: { auctionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const auctionId = data?.auctionId;
    if (!auctionId || !isUUID(auctionId)) {
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
    return { event: 'left', data: { auctionId, participantCount } };
  }

  getRoomSize(auctionId: string): number {
    if (!this.server) return 0;
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

  emitAuctionEnded(auctionId: string, payload: Record<string, any>) {
    if (!this.server) return;
    this.server.to(this.roomName(auctionId)).emit('auction:ended', payload);
  }

  private roomName(auctionId: string): string {
    return `auction:${auctionId}`;
  }
}
