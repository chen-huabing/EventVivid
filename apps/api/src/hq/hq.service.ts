import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import { DomainError } from '../shared/domain-error.filter';
import type { HqPrincipal } from './hq-auth.guard';

const LoginSchema = z.object({ username: z.string().trim().min(1), password: z.string().min(8) });
const TenantSchema = z.object({ name: z.string().trim().min(2).max(100) });
const TenantStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });
const TenantUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  validUntil: z.coerce.date().nullable(),
});

@Injectable()
export class HqService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async login(input: unknown, ipAddress: string | null) {
    const data = LoginSchema.parse(input);
    const user = await this.db.selectFrom('platform_users').selectAll().where('username', '=', data.username).executeTakeFirst();
    if (!user || user.status !== 'active' || !(await bcrypt.compare(data.password, user.password_hash))) {
      throw new DomainError('用户名或密码错误', HttpStatus.UNAUTHORIZED);
    }
    const principal: HqPrincipal = { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
    const token = jwt.sign({ username: principal.username, displayName: principal.displayName, role: principal.role }, process.env.JWT_SECRET ?? '', { subject: user.id, expiresIn: '8h' });
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('platform_users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
      await trx.insertInto('platform_audit_logs').values({ id: randomUUID(), platform_user_id: user.id, action: 'hq.login', target_type: 'platform_user', target_id: user.id, detail: {}, ip_address: ipAddress }).execute();
    });
    return { token, user: principal };
  }

  async dashboard() {
    const [tenants, events, orders, paid, checkedIn] = await Promise.all([
      this.db.selectFrom('tenants').select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
      this.db.selectFrom('events').select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
      this.db.selectFrom('orders').select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
      this.db.selectFrom('orders').select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_cents'), eb.val(0)).as('amount')).where('status', '=', 'paid').executeTakeFirstOrThrow(),
      this.db.selectFrom('tickets').select((eb) => eb.fn.countAll<number>().as('count')).where('status', '=', 'checked_in').executeTakeFirstOrThrow(),
    ]);
    return { tenants: Number(tenants.count), events: Number(events.count), orders: Number(orders.count), paidAmountCents: Number(paid.amount), checkedIn: Number(checkedIn.count) };
  }

  listTenants() {
    return this.db.selectFrom('tenants').leftJoin('events', 'events.tenant_id', 'tenants.id')
      .select(['tenants.id', 'tenants.name', 'tenants.status', 'tenants.valid_until', 'tenants.created_at', (eb) => eb.fn.count<number>('events.id').as('event_count')])
      .groupBy('tenants.id').orderBy('tenants.created_at', 'desc').execute();
  }

  async createTenant(actor: HqPrincipal, input: unknown, ipAddress: string | null) {
    const data = TenantSchema.parse(input); const id = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const tenant = await trx.insertInto('tenants').values({ id, name: data.name, status: 'active', valid_until: null }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('platform_audit_logs').values({ id: randomUUID(), platform_user_id: actor.id, action: 'tenant.create', target_type: 'tenant', target_id: id, detail: { name: data.name }, ip_address: ipAddress }).execute();
      return tenant;
    });
  }

  async updateTenantStatus(actor: HqPrincipal, tenantId: string, input: unknown, ipAddress: string | null) {
    const data = TenantStatusSchema.parse(input);
    return this.db.transaction().execute(async (trx) => {
      const tenant = await trx.updateTable('tenants').set({ status: data.status }).where('id', '=', tenantId).returningAll().executeTakeFirst();
      if (!tenant) throw new DomainError('租户不存在', HttpStatus.NOT_FOUND);
      await trx.insertInto('platform_audit_logs').values({ id: randomUUID(), platform_user_id: actor.id, action: 'tenant.status.update', target_type: 'tenant', target_id: tenantId, detail: { status: data.status }, ip_address: ipAddress }).execute();
      return tenant;
    });
  }

  async updateTenant(actor: HqPrincipal, tenantId: string, input: unknown, ipAddress: string | null) {
    const data = TenantUpdateSchema.parse(input);
    return this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('tenants').select(['name', 'valid_until']).where('id', '=', tenantId).executeTakeFirst();
      if (!before) throw new DomainError('租户不存在', HttpStatus.NOT_FOUND);
      const tenant = await trx.updateTable('tenants').set({ name: data.name, valid_until: data.validUntil })
        .where('id', '=', tenantId).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('platform_audit_logs').values({
        id: randomUUID(), platform_user_id: actor.id, action: 'tenant.profile.update', target_type: 'tenant', target_id: tenantId,
        detail: { before: { name: before.name, validUntil: before.valid_until }, after: { name: data.name, validUntil: data.validUntil } }, ip_address: ipAddress,
      }).execute();
      return tenant;
    });
  }

  plans() { return this.db.selectFrom('subscription_plans').selectAll().orderBy('price_cents').execute(); }

  auditLogs() {
    return this.db.selectFrom('platform_audit_logs').innerJoin('platform_users', 'platform_users.id', 'platform_audit_logs.platform_user_id')
      .select(['platform_audit_logs.id', 'platform_audit_logs.action', 'platform_audit_logs.target_type', 'platform_audit_logs.target_id', 'platform_audit_logs.detail', 'platform_audit_logs.ip_address', 'platform_audit_logs.created_at', 'platform_users.display_name'])
      .orderBy('platform_audit_logs.created_at', 'desc').limit(100).execute();
  }
}
