import { Module } from '@nestjs/common';
import { EventsController, PublicEventsController } from './events.controller';
import { EventsService } from './events.service';
import { TenantAuthModule } from '../tenant-auth/tenant-auth.module';

@Module({ imports: [TenantAuthModule], controllers: [EventsController, PublicEventsController], providers: [EventsService], exports: [EventsService] })
export class EventsModule {}
