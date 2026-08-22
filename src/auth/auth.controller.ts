import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
  UseGuards,
  Param,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { AuthService } from './auth.service';
import { TokenUtils } from './utils/auth.util';
import type { Response } from 'express';
import { LoginDto } from './dto/login.dto';
import crypto from 'crypto';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import bcrypt from 'bcrypt';
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { Cookies } from '../common/decorators/cookie.decorator';
import { Throttle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenUtils: TokenUtils,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @Post('register')
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.authService.registerService(registerDto);

    const { refreshToken, ...userWithoutRefreshToken } = user;

    this.tokenUtils.sendRefreshToken(res, refreshToken);
    const token = this.tokenUtils.generateAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      provider: user.provider!,
      isEmailVerified: user.isEmailVerified,
      needToChangePassword: user.needToChangePassword,
    });

    return {
      success: true,
      token,
      data: userWithoutRefreshToken,
    };
  }

  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { email, password } = body;

    const user = await this.authService.loginService(email, password);

    const { refreshToken, ...userWithoutRefreshToken } = user;

    this.tokenUtils.sendRefreshToken(res, refreshToken);

    const token = this.tokenUtils.generateAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      provider: user.provider!,
      isEmailVerified: user.isEmailVerified,
      needToChangePassword: user.needToChangePassword,
    });

    return {
      success: true,
      token,
      data: userWithoutRefreshToken,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Cookies('refreshToken') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!token) {
      throw new BadRequestException('Refresh token is missing');
    }

    const payload = this.tokenUtils.verifyRefreshToken(token);

    const hashToken = crypto.createHash('sha256').update(token).digest('hex');

    const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
      await this.authService.refreshTokenService(hashToken, payload.sub);

    this.tokenUtils.sendRefreshToken(res, newRefreshToken);

    return {
      success: true,
      token: newAccessToken,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AccessJWTPayload,
    @Res({ passthrough: true }) res: Response,
    @Cookies('refreshToken') token: string,
  ) {
    if (!token) {
      throw new BadRequestException('Refresh token is missing');
    }

    const remainingTTl = user.exp! - Math.floor(Date.now() / 1000);

    await this.authService.logoutService(
      user.sub,
      token,
      remainingTTl,
      user.jti!,
    );

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    });

    return {
      success: true,
      message: 'Logged out successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(@CurrentUser() user: AccessJWTPayload) {
    const remainingTTl = user.exp! - Math.floor(Date.now() / 1000);

    await this.authService.logoutAllService(user.sub, remainingTTl, user.jti!);

    return {
      success: true,
      message: 'Logged out from all devices successfully',
    };
  }

  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    await this.authService.forgotPasswordService(body.email);

    return {
      success: true,
      message:
        'If an email with this account exist, a reset url has been sent to the email address.',
    };
  }

  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  @Post('reset-password/:token')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() body: ResetPasswordDto,
    @Param('token') token: string,
  ) {
    const hashToken = crypto.createHash('sha256').update(token).digest('hex');

    const { password } = body;
    const hashedPassword = await bcrypt.hash(password, 12);

    await this.authService.resetPasswordService(hashToken, hashedPassword);

    return {
      success: true,
      message:
        'Password has been reset successfully. You can now log in with your new password.',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('request-email-verification')
  @HttpCode(HttpStatus.OK)
  async requestEmailVerification(@CurrentUser() user: AccessJWTPayload) {
    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    await this.authService.requestEmailVerificationService(
      user.email,
      user.sub,
    );

    return {
      success: true,
      message:
        'If an email with this account exist, a verification token has been sent to the email address.',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify-email/:token')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Param('token') token: string,
    @CurrentUser() user: AccessJWTPayload,
  ) {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    await this.authService.verifyEmailTokenService(
      hashedToken,
      user.sub,
      user.jti!,
      user.exp! - Math.floor(Date.now() / 1000),
    );

    const newToken = this.tokenUtils.generateAccessToken({
      sub: user.sub,
      email: user.email,
      role: user.role,
      provider: user.provider,
      isEmailVerified: true,
      needToChangePassword: user.needToChangePassword,
    });

    return {
      success: true,
      token: newToken,
      message: 'Email verified successfully.',
    };
  }
}
