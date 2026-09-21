import { Module } from '@nestjs/common';
import { TenantAuthController } from './tenant-auth.controller';
import { TenantAuthGuard } from './tenant-auth.guard';
import { TenantAuthService } from './tenant-auth.service';

@Module({
  controllers: [TenantAuthController],
  providers: [TenantAuthService, TenantAuthGuard],
  exports: [TenantAuthGuard],
})
export class TenantAuthModule {}
