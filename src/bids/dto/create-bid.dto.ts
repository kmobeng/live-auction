import { IsNotEmpty, IsNumber, IsUUID, Min } from 'class-validator';

export class CreateBidDto {
  @IsUUID('4', { message: 'auctionId must be a valid UUID' })
  @IsNotEmpty({ message: 'auctionId is required' })
  auctionId!: string;

  @IsNumber({}, { message: 'amount must be a number' })
  @Min(0.01, { message: 'amount must be greater than 0' })
  amount!: number;
}
