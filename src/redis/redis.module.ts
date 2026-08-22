import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';
import { TokenStoreService } from './token-store.service';
import { ConfigService } from '@nestjs/config';

@Global()
@Module({
  providers: [RedisService, TokenStoreService, ConfigService],
  exports: [RedisService, TokenStoreService],
})
export class RedisModule {}
