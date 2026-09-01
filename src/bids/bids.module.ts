import { Module, forwardRef } from '@nestjs/common';
import { BidsGateway } from './bids.gateway';
import { BidsController } from './bids.controller';
import { BidsService } from './bids.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [AuthModule],
  providers: [BidsGateway, BidsService, PrismaService],
  controllers: [BidsController],
  exports: [BidsGateway, BidsService],
})
export class BidsModule {}
