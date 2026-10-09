import { Module } from '@nestjs/common';
import { TenantAuthModule } from '../tenant-auth/tenant-auth.module';
import { HuifuGateway } from './huifu.gateway';
import { CreditPaymentsService } from './credit-payments.service';
import { CreditCheckoutController, CreditPurchasesController } from './credit-payments.controller';
@Module({imports:[TenantAuthModule],providers:[HuifuGateway,CreditPaymentsService],controllers:[CreditCheckoutController,CreditPurchasesController]})
export class CreditPaymentsModule{}
