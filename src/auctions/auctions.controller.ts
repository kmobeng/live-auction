import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { AuctionsService } from './auctions.service';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { PaginationQueryDto, QueryAuctionsDto } from './dto/query-auctions.dto';

@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: CreateAuctionDto,
  ) {
    const data = await this.auctionsService.createAuctionService(user.sub, dto);

    return {
      success: true,
      data,
    };
  }

  @Get()
  async list(@Query() query: QueryAuctionsDto) {
    const data = await this.auctionsService.listAuctionsService(query);

    return {
      success: true,
      data,
    };
  }

  // Declared before ':id' so Nest resolves the static segment first
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  async mine(
    @CurrentUser() user: AccessJWTPayload,
    @Query() query: QueryAuctionsDto,
  ) {
    const data = await this.auctionsService.listMyAuctionsService(
      user.sub,
      query,
    );

    return {
      success: true,
      data,
    };
  }

  // Declared before ':id' so Nest resolves ':id/bids' correctly
  @Get(':id/bids')
  async bids(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    const data = await this.auctionsService.getAuctionBidsService(id, query);

    return {
      success: true,
      data,
    };
  }

  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.auctionsService.getAuctionByIdService(id);

    return {
      success: true,
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAuctionDto,
  ) {
    const data = await this.auctionsService.updateAuctionService(
      user.sub,
      user.role,
      id,
      dto,
    );

    return {
      success: true,
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.auctionsService.deleteAuctionService(user.sub, user.role, id);

    return {
      success: true,
      message: 'Auction deleted successfully',
    };
  }
}
