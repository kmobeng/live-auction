import { Module, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuctionsController } from './auctions.controller';
import { AuctionsScheduler } from './auctions.scheduler';
import { AuctionsService } from './auctions.service';
import { AuthModule } from '../auth/auth.module';
import { BidsModule } from '../bids/bids.module';

@Module({
  imports: [AuthModule, forwardRef(() => BidsModule)],
  controllers: [AuctionsController],
  providers: [AuctionsService, AuctionsScheduler, PrismaService],
})
export class AuctionsModule {}
