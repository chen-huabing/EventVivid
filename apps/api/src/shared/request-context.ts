import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface RequestContext {
  tenantId: string;
  userId: string;
  role: string;
}

export const CurrentContext = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext => {
  const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; tenantUser?: { id: string; tenantId: string; role: string } }>();
  if (request.tenantUser) return { tenantId: request.tenantUser.tenantId, userId: request.tenantUser.id, role: request.tenantUser.role };
  const headers = request.headers;
  return {
    tenantId: headers['x-tenant-id'] ?? '00000000-0000-4000-8000-000000000001',
    userId: headers['x-user-id'] ?? '00000000-0000-4000-8000-000000000002',
    role: headers['x-role'] ?? 'tenant_admin',
  };
});
