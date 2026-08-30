import { Controller, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/auth.guard';

@Controller('bids')
export class BidsController {
  @UseGuards(JwtAuthGuard)
  createBid() {
    // Logic to create a bid
  }
}
