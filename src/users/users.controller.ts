import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import crypto from 'crypto';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateEmailDto } from './dto/update-email.dto';
import { ConfirmEmailChangeDto } from './dto/confirm-email-change.dto';
import { Throttle } from '@nestjs/throttler';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: AccessJWTPayload) {
    const data = await this.usersService.findCurrentUserService(user.sub);

    return {
      success: true,
      data,
    };
  }

  @Patch('profile')
  async updateProfile(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    const data = await this.usersService.updateProfileService(user.sub, dto);

    return {
      success: true,
      data,
    };
  }

  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  @Patch('email')
  @HttpCode(HttpStatus.OK)
  async requestEmailChange(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: UpdateEmailDto,
  ) {
    await this.usersService.requestEmailChangeService(user.sub, dto);

    return {
      success: true,
      message:
        'If that email is available, a verification code has been sent to it.',
    };
  }

  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @Post('email/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmEmailChange(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: ConfirmEmailChangeDto,
    @Res({ passthrough: true }) _res: Response,
  ) {
    // Every session is revoked by the confirm, including this device's
    // refresh session and live access token - the client must log in again
    // with the new email.
    const hashedCode = crypto
      .createHash('sha256')
      .update(dto.token)
      .digest('hex');

    const remainingTtl =
      (user.exp ?? Math.floor(Date.now() / 1000)) -
      Math.floor(Date.now() / 1000);

    await this.usersService.confirmEmailChangeService(
      user.sub,
      hashedCode,
      remainingTtl,
      user.jti!,
    );

    return {
      success: true,
      message:
        'Your email has been updated. For your security all sessions were logged out - please log in again with your new email.',
    };
  }
}
