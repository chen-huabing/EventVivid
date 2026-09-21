import { Module } from '@nestjs/common';
import { HqAuthController, HqController } from './hq.controller';
import { HqService } from './hq.service';
import { HqAuthGuard } from './hq-auth.guard';

@Module({ controllers: [HqAuthController, HqController], providers: [HqService, HqAuthGuard] })
export class HqModule {}
