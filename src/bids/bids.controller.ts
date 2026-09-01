import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { IsEmailVerifiedGuard } from '../common/guards/is-email-verified.guard';
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { BidsService } from './bids.service';
import { CreateBidDto } from './dto/create-bid.dto';

@Controller('bids')
export class BidsController {
  constructor(private readonly bidsService: BidsService) {}

  @UseGuards(JwtAuthGuard, IsEmailVerifiedGuard)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createBid(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: CreateBidDto,
  ) {
    const data = await this.bidsService.createBidService(user.sub, dto);
    return {
      success: true,
      data,
    };
  }
}
