import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class UpdateEmailDto {
  @IsNotEmpty({ message: 'New email is required' })
  @IsString({ message: 'New email must be a string' })
  @IsEmail({}, { message: 'New email must be a valid email address' })
  newEmail!: string;

  @IsNotEmpty({ message: 'Current password is required' })
  @IsString({ message: 'Current password must be a string' })
  currentPassword!: string;
}
