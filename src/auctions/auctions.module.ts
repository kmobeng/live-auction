import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuctionsController } from './auctions.controller';
import { AuctionsScheduler } from './auctions.scheduler';
import { AuctionsService } from './auctions.service';

@Module({
  controllers: [AuctionsController],
  providers: [AuctionsService, AuctionsScheduler, PrismaService],
})
export class AuctionsModule {}
