import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateAuctionDto {
  @IsOptional()
  @IsString({ message: 'Title must be a string' })
  @MaxLength(150, { message: 'Title must be at most 150 characters long' })
  title?: string;

  @IsOptional()
  @IsString({ message: 'Description must be a string' })
  @MaxLength(2000, {
    message: 'Description must be at most 2000 characters long',
  })
  description?: string | null;

  @IsOptional()
  @IsNumber({}, { message: 'Starting bid must be a number' })
  @Min(0, { message: 'Starting bid must not be less than 0' })
  startingBid?: number;

  @IsOptional()
  @IsDateString(
    {},
    { message: 'Start time must be a valid ISO 8601 date string' },
  )
  startTime?: string;

  @IsOptional()
  @IsDateString(
    {},
    { message: 'End time must be a valid ISO 8601 date string' },
  )
  endTime?: string;
}
