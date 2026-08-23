import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAuctionDto {
  @IsNotEmpty({ message: 'Title is required' })
  @IsString({ message: 'Title must be a string' })
  @MaxLength(150, { message: 'Title must be at most 150 characters long' })
  title!: string;

  @IsOptional()
  @IsString({ message: 'Description must be a string' })
  @MaxLength(2000, {
    message: 'Description must be at most 2000 characters long',
  })
  description?: string;

  @IsNumber({}, { message: 'Starting bid must be a number' })
  @Min(0, { message: 'Starting bid must not be less than 0' })
  startingBid!: number;

  @IsDateString(
    {},
    { message: 'Start time must be a valid ISO 8601 date string' },
  )
  startTime!: string;

  @IsDateString(
    {},
    { message: 'End time must be a valid ISO 8601 date string' },
  )
  endTime!: string;
}
