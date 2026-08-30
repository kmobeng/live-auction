import { Module } from '@nestjs/common';
import { BidsGateway } from './bids.gateway';
import { BidsController } from './bids.controller';
import { BidsService } from './bids.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [BidsGateway, BidsService],
  controllers: [BidsController],
})
export class BidsModule {}
