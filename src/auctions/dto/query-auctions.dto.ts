import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuctionStatus } from '../../../generated/prisma/client';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Page must be an integer' })
  @Min(1, { message: 'Page must not be less than 1' })
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Limit must be an integer' })
  @Min(1, { message: 'Limit must not be less than 1' })
  @Max(50, { message: 'Limit must not be greater than 50' })
  limit: number = 10;
}

export class QueryAuctionsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(AuctionStatus, {
    message: 'Status must be one of: UPCOMING, ACTIVE, ENDED',
  })
  status?: AuctionStatus;
}
