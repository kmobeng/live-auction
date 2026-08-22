import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma.service';
import { TokenUtils } from '../auth/utils/auth.util';
import { OutboxModule } from '../outbox/outbox.module';

// RedisService and TokenStoreService come from the @Global RedisModule
@Module({
  imports: [OutboxModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    PrismaService,
    ConfigService,
    JwtService,
    TokenUtils,
  ],
})
export class UsersModule {}
