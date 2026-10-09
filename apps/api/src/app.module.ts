import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { RegistrationModule } from './registration/registration.module';
import { CheckinModule } from './checkin/checkin.module';
import { HealthController } from './health.controller';
import { HqModule } from './hq/hq.module';
import { TenantAuthModule } from './tenant-auth/tenant-auth.module';
import { CreditPaymentsModule } from './credit-payments/credit-payments.module';

@Module({
  imports: [DatabaseModule, TenantAuthModule, EventsModule, RegistrationModule, CheckinModule, HqModule, CreditPaymentsModule],
  controllers: [HealthController],
})
export class AppModule {}
