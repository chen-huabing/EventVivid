import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { TenantPrincipal } from './tenant-auth.guard';

export const CurrentTenantUser = createParamDecorator((_: unknown, context: ExecutionContext): TenantPrincipal => {
  return context.switchToHttp().getRequest<{ tenantUser: TenantPrincipal }>().tenantUser;
});
