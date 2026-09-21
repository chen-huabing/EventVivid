import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { Kysely } from 'kysely';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import { DomainError } from '../shared/domain-error.filter';

export interface TenantPrincipal {
  id: string;
  tenantId: string;
  name: string;
  username: string;
  role: string;
  tenantName: string;
}

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; tenantUser?: TenantPrincipal }>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new DomainError('活动平台登录已失效', HttpStatus.UNAUTHORIZED);
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(authorization.slice(7), process.env.TENANT_JWT_SECRET ?? '') as jwt.JwtPayload;
    } catch {
      throw new DomainError('活动平台登录已失效', HttpStatus.UNAUTHORIZED);
    }
    const user = await this.db.selectFrom('users').innerJoin('tenants', 'tenants.id', 'users.tenant_id')
      .select(['users.id', 'users.name', 'users.username', 'users.role', 'users.status', 'tenants.id as tenant_id', 'tenants.name as tenant_name', 'tenants.status as tenant_status', 'tenants.valid_until'])
      .where('users.id', '=', String(payload.sub)).executeTakeFirst();
    if (!user || user.status !== 'active' || user.tenant_status !== 'active') throw new DomainError('账号或租户已停用', HttpStatus.FORBIDDEN);
    if (user.valid_until && new Date(user.valid_until) < new Date()) throw new DomainError('租户服务已到期，请联系 EventVivid 总部续期', HttpStatus.FORBIDDEN);
    request.tenantUser = { id: user.id, tenantId: user.tenant_id, name: user.name, username: user.username ?? '', role: user.role, tenantName: user.tenant_name };
    return true;
  }
}
