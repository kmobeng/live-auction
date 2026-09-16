import { Module } from '@nestjs/common';
import { BidsGateway } from './bids.gateway';
import { BidsService } from './bids.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [AuthModule],
  providers: [BidsGateway, BidsService, PrismaService],
  exports: [BidsGateway, BidsService],
})
export class BidsModule {}
