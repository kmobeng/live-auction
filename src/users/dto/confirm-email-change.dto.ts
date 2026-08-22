import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ConfirmEmailChangeDto {
  @IsNotEmpty({ message: 'Verification code is required' })
  @IsString({ message: 'Verification code must be a string' })
  @Length(6, 6, { message: 'Verification code must be exactly 6 digits' })
  token!: string;
}
