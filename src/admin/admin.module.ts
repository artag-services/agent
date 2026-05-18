import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminGuard } from './admin.guard';
import { BackfillController } from './backfill.controller';

@Module({
  imports: [ConfigModule],
  controllers: [BackfillController],
  providers: [AdminGuard],
})
export class AdminModule {}
