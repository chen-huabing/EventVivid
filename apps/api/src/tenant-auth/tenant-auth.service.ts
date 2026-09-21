import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import { DomainError } from '../shared/domain-error.filter';

const LoginSchema = z.object({ username: z.string().trim().min(1), password: z.string().min(8) });

@Injectable()
export class TenantAuthService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async login(input: unknown) {
    const data = LoginSchema.parse(input);
    const user = await this.db.selectFrom('users').innerJoin('tenants', 'tenants.id', 'users.tenant_id')
      .select(['users.id', 'users.name', 'users.username', 'users.password_hash', 'users.role', 'users.status', 'tenants.id as tenant_id', 'tenants.name as tenant_name', 'tenants.status as tenant_status', 'tenants.valid_until'])
      .where('users.username', '=', data.username).executeTakeFirst();
    if (!user || !user.password_hash || !(await bcrypt.compare(data.password, user.password_hash))) throw new DomainError('用户名或密码错误', HttpStatus.UNAUTHORIZED);
    if (user.status !== 'active' || user.tenant_status !== 'active') throw new DomainError('账号或租户已停用', HttpStatus.FORBIDDEN);
    if (user.valid_until && new Date(user.valid_until) < new Date()) throw new DomainError('租户服务已到期，请联系 EventVivid 总部续期', HttpStatus.FORBIDDEN);
    const principal = { id: user.id, tenantId: user.tenant_id, name: user.name, username: user.username ?? '', role: user.role, tenantName: user.tenant_name };
    const token = jwt.sign({ tenantId: principal.tenantId, name: principal.name, username: principal.username, role: principal.role, tenantName: principal.tenantName }, process.env.TENANT_JWT_SECRET ?? '', { subject: user.id, expiresIn: '8h' });
    await this.db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
    return { token, user: principal };
  }
}
