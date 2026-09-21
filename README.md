# Live Auction — Real-Time Bidding Platform

<p align="center">
  <img src="https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
  <img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white" alt="Redis 7" />
  <img src="https://img.shields.io/badge/Socket.IO-4-010101?logo=socketdotio&logoColor=white" alt="Socket.IO 4" />
  <img src="https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white" alt="Prisma 7" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5.7" />
  <img src="https://img.shields.io/badge/BullMQ-6-FF6B6B" alt="BullMQ 6" />
</p>

<p align="center"><em>Real-time auction engine with room-based WebSockets and database-guaranteed single winner under concurrent bids.</em></p>

## What It Is

Live Auction is a backend for running timed, competitive auctions in real time.

Sellers create an auction with a title, description, starting price, and time window. Auctions move through a lifecycle of `UPCOMING → ACTIVE → ENDED` based on their start and end times. Buyers browse live auctions, open one to see its live state (current highest bid and bidder, bid count, watcher count, server time, and time remaining), join it over WebSocket, and bid. The highest bid is broadcast instantly to everyone watching that auction, only the previous highest bidder gets a private "you've been outbid" push, and when the timer expires the auction closes automatically with the winner and final price broadcast to the room. No further bids are accepted after close.

Bidding is WebSocket-only. Concurrent bids on the same auction are serialized with a Postgres row-level lock (`SELECT ... FOR UPDATE` inside a Prisma transaction), so only one bid can win a price point — the loser is rejected with "Bid must be higher than current bid".

## Features

- **Auctions** — Create, browse, and manage timed auctions with live state (current bid, bid count, participants, time remaining).
- **Live bidding** — WebSocket-only `placeBid`. Rules enforced server-side: auction must be `ACTIVE` by time window, bidder can't be the seller, email must be verified, and `amount` must beat the current highest (≥ 0.01).
- **Live updates** — New highest bid (`bid:created`), current price (`auction:currentBid`), and watcher count (`auction:participantCount`) broadcast instantly to room `auction:${id}`.
- **Targeted outbid notifications** — Only the previous highest bidder receives a private `bid:outbid` push in their personal `user:${id}` room.
- **Automatic lifecycle** — A 30-second cron flips `UPCOMING → ACTIVE → ENDED`, derives the winner from the last bid, and emits `auction:ended {winner, finalPrice, bidCount}`.
- **Access control** — Only the seller (or an admin) can update or delete an auction, and only before any bids exist and before it starts.

## How It Works

**Watching an auction:** the client connects with a JWT (`auth: { token }`), emits `joinAuction {auctionId}`, and joins both `auction:${id}` and its personal `user:${id}` room. The server returns the full live state as the ACK and notifies the room of the updated watcher count. Leaving via `leaveAuction` does the reverse.

**Bidding:** the client emits `placeBid {auctionId, amount}`. The server checks auth + verified email, runs a fast pre-check against the cached price, then opens a locked transaction: lock the auction row, re-validate everything against fresh data, capture the previous top bidder, insert the `Bid`, and update `Auction.currentBid`. Only after commit does it broadcast to the room and push the outbid notice.

**Closing:** once `endTime` passes, the scheduler marks the auction `ENDED` and broadcasts the winner (highest `Bid` by amount, then time) and final price. Late bids fail the time-window check inside the same locked transaction.

## Architecture

```
                ┌──────────────┐
                │   Client     │  WebSocket (Socket.IO) for bids/presence
                │  Browser/App │  + REST for auctions/auth
                └──────┬───────┘
                       │ joinAuction / placeBid / leaveAuction  (WS — bids)
                       │ POST /api/v1/auctions                   (REST — auctions)
                       ▼
                ┌─────────────────────┐
                │   NestJS (BidsGateway │  @WebSocketGateway + @Controller
                │   + Auth/JWT Guards)  │  ValidationPipe, Throttler, Filters
                └──────────┬──────────┘
                           │  FOR UPDATE
                           ▼
                ┌─────────────────────┐      ┌──────────┐
                │   BidsService (tx)  │─────▶│ Postgres │  Auction row lock
                │  prisma.$transaction│◀─────│  Prisma  │  + Bid insert + currentBid update
                └──────────┬──────────┘      └──────────┘
                           │ after commit
                ┌──────────▼──────────┐
                │  Gateway Broadcasts │──▶ room auction:${id} (all watchers)
                │  + personal outbid  │──▶ room user:${id}   (prev bidder only)
                └─────────────────────┘
                           │
                ┌──────────▼──────────┐     ┌──────────┐
                │  Scheduler (cron)   │────▶│  Redis   │ JTI / blacklist / TokenStore
                │  + Outbox Poller    │────▶│  BullMQ  │ notification queue (email)
                └─────────────────────┘     └──────────┘
                                              Mailpit (dev inbox :8025)
```

## API Reference

Global prefix: `api/v1` (except `/`).

### REST — Auctions

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auctions` | Verified user | Create auction `{title, description?, startingBid, startTime, endTime}`. |
| `GET` | `/api/v1/auctions` | Public | List auctions `?status=ACTIVE|UPCOMING|ENDED&page=&limit=`. |
| `GET` | `/api/v1/auctions/mine` | Verified user | Current seller's auctions. |
| `GET` | `/api/v1/auctions/:id` | Public | Single auction with live state. |
| `GET` | `/api/v1/auctions/:id/bids` | Public | Bid history, paginated. |
| `PATCH` | `/api/v1/auctions/:id` | Owner or admin | Update before bids exist and before start. |
| `DELETE` | `/api/v1/auctions/:id` | Owner or admin | Delete only if no bids. |

### WebSocket — Bids and Presence

| Event | Direction | Payload |
|---|---|---|
| `joinAuction` | Client → Server | `{auctionId}` — joins `auction:${id}`, returns live state. |
| `placeBid` | Client → Server | `{auctionId, amount}` — verified users only, returns `bid:placed`. |
| `leaveAuction` | Client → Server | `{auctionId}` — leaves the room. |
| `bid:created` | Server → Room | New highest bid to `auction:${id}`. |
| `auction:currentBid` | Server → Room | Updated price + bid count. |
| `bid:outbid` | Server → User | Private "you've been outbid" to previous highest bidder (`user:${prevId}`). |
| `auction:ended` | Server → Room | Winner `{id, name}` + `finalPrice` + `bidCount` on close. |
| `auction:participantCount` | Server → Room | Watcher count on join/leave. |
| `exception` | Server → Client | `{status: 'error', message}` on validation/auth/bid failures. |

Live state returned by `GET /auctions/:id` and the `joinAuction` ACK:

```json
{
  "id": "uuid",
  "title": "Vintage Camera",
  "currentBid": 120,
  "status": "ACTIVE",
  "seller": { "id": "uuid", "name": "Ada" },
  "bidCount": 4,
  "topBid": { "amount": 120, "bidder": { "id": "uuid", "name": "Bob" } },
  "serverTime": "2026-01-01T00:00:00.000Z",
  "timeRemainingMs": 42000
}
```

Bids require a verified email. Unverified `placeBid` calls are rejected with `Email not verified`. All bids validate `CreateBidDto {auctionId: UUIDv4, amount ≥ 0.01}`.

## Data Model

```
User ──< Auction (sellerId) — title, description, startingBid, currentBid,
  │        │                   status, startTime, endTime
  │        └─< Bid ── User    — amount, createdAt (winner = highest bid)
  ├─< RefreshToken            — hashed token, expiresAt
  └─< OutboxEvent             — eventType, payload, processedAt
```

Money uses Prisma `Decimal`. Auth uses short-lived access tokens (15m, with Redis JTI blacklist) plus hashed refresh tokens in an `httpOnly` cookie. Emails (verification, password reset) go through a transactional outbox + BullMQ queue with Mailpit for local dev.

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | NestJS 11 + TypeScript 5.7 |
| Realtime | Socket.IO 4 + `@nestjs/websockets` rooms + ACKs |
| Database | PostgreSQL 16 + Prisma 7 (`FOR UPDATE` locking) |
| Cache / sessions | Redis 7 (`ioredis`) — JTI registry, blacklist, verification codes |
| Queue | BullMQ 6 — `notification` queue for emails |
| Scheduling | `@nestjs/schedule` — 30s auction lifecycle, 5s outbox poller |
| Validation | `class-validator` + global `ValidationPipe` |
| Auth | `@nestjs/jwt` + `bcrypt` |
| Observability | `nestjs-pino` with request IDs |
| Infra | `docker-compose` — Postgres `:5433`, Redis `:6379`, Mailpit `:1025/:8025` |

## Quick Start

```bash
cp .env.example .env
docker compose up -d
npm install
npx prisma migrate dev
npm run start:dev
```

API: `http://localhost:3000/api/v1/auctions` · Mailpit: `http://localhost:8025`

### Try it live

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:3000', { auth: { token: 'Bearer ' + TOKEN } });

socket.emit('joinAuction', { auctionId }, console.log);
socket.on('bid:created', console.log);
socket.on('bid:outbid', (p) => console.log("you've been outbid", p));
socket.on('auction:ended', console.log);

socket.emit('placeBid', { auctionId, amount: 150 }, console.log);
```

Scripts: `npm run build` · `npm run start:dev` · `npm run lint` · `npm test`

## License

MIT — see `LICENSE`.
