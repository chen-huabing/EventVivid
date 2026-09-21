import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomInt, randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import { DomainError } from '../shared/domain-error.filter';

const LoginSchema = z.object({ username: z.string().trim().min(1), password: z.string().min(8) });
const RegisterSchema = z.object({
  tenantName: z.string().trim().min(2).max(100),
  name: z.string().trim().min(2).max(50),
  mobile: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效的中国大陆手机号'),
  password: z.string().min(8).max(128),
});
const PasswordResetRequestSchema = z.object({ mobile: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效的中国大陆手机号') });
const PasswordResetConfirmSchema = PasswordResetRequestSchema.extend({ code: z.string().regex(/^\d{6}$/, '请输入 6 位短信验证码'), password: z.string().min(8).max(128) });
const PermissionSchema = z.enum(['events.manage', 'registrations.view', 'orders.view', 'checkin.manage', 'reports.view', 'members.manage']);
const MemberCreateSchema = z.object({ name: z.string().trim().min(2).max(50), mobile: z.string().regex(/^1[3-9]\d{9}$/, '请输入有效的中国大陆手机号'), password: z.string().min(8).max(128), role: z.enum(['tenant_admin', 'event_manager', 'checkin_staff', 'viewer']), permissions: z.array(PermissionSchema).default([]) });
const MemberUpdateSchema = z.object({ name: z.string().trim().min(2).max(50), role: z.enum(['tenant_admin', 'event_manager', 'checkin_staff', 'viewer']), permissions: z.array(PermissionSchema).default([]), status: z.enum(['active', 'disabled']), password: z.string().min(8).max(128).optional().or(z.literal('')) });
const TenantSettingsSchema = z.object({ name: z.string().trim().min(2).max(100), supportContact: z.string().trim().max(100).default(''), timezone: z.literal('Asia/Shanghai') });

@Injectable()
export class TenantAuthService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async login(input: unknown) {
    const data = LoginSchema.parse(input);
    const user = await this.db.selectFrom('users').innerJoin('tenants', 'tenants.id', 'users.tenant_id')
      .select(['users.id', 'users.name', 'users.username', 'users.password_hash', 'users.role', 'users.status', 'tenants.id as tenant_id', 'tenants.name as tenant_name', 'tenants.status as tenant_status', 'tenants.valid_until'])
      .where((eb) => eb.or([eb('users.username', '=', data.username), eb('users.mobile', '=', data.username)])).executeTakeFirst();
    if (!user || !user.password_hash || !(await bcrypt.compare(data.password, user.password_hash))) throw new DomainError('用户名或密码错误', HttpStatus.UNAUTHORIZED);
    if (user.status !== 'active' || user.tenant_status !== 'active') throw new DomainError('账号或租户已停用', HttpStatus.FORBIDDEN);
    if (user.valid_until && new Date(user.valid_until) < new Date()) throw new DomainError('租户服务已到期，请联系 EventVivid 总部续期', HttpStatus.FORBIDDEN);
    const principal = { id: user.id, tenantId: user.tenant_id, name: user.name, username: user.username ?? '', role: user.role, tenantName: user.tenant_name };
    const token = jwt.sign({ tenantId: principal.tenantId, name: principal.name, username: principal.username, role: principal.role, tenantName: principal.tenantName }, process.env.TENANT_JWT_SECRET ?? '', { subject: user.id, expiresIn: '8h' });
    await this.db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
    return { token, user: principal };
  }

  async register(input: unknown) {
    const data = RegisterSchema.parse(input);
    const tenantId = randomUUID();
    const userId = randomUUID();
    const trialEndsAt = new Date();
    trialEndsAt.setMonth(trialEndsAt.getMonth() + 6);
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx.insertInto('tenants').values({ id: tenantId, name: data.tenantName, status: 'active', valid_until: trialEndsAt }).execute();
        await trx.insertInto('users').values({
          id: userId, tenant_id: tenantId, name: data.name, username: data.mobile,
          password_hash: await bcrypt.hash(data.password, 12), mobile: data.mobile, role: 'tenant_admin', status: 'active', last_login_at: null,
        }).execute();
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('该手机号已被注册，请直接登录或找回密码', HttpStatus.CONFLICT);
      throw error;
    }
    return this.login({ username: data.mobile, password: data.password });
  }

  async requestPasswordReset(input: unknown) {
    const data = PasswordResetRequestSchema.parse(input);
    const user = await this.db.selectFrom('users').select('id').where((eb) => eb.or([eb('username', '=', data.mobile), eb('mobile', '=', data.mobile)])).executeTakeFirst();
    if (!user) return { message: '如该手机号已注册，验证码将发送至该手机。' };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('password_reset_codes').set({ consumed_at: new Date() }).where('mobile', '=', data.mobile).where('consumed_at', 'is', null).execute();
      await trx.insertInto('password_reset_codes').values({ id: randomUUID(), mobile: data.mobile, code_hash: await bcrypt.hash(code, 10), expires_at: expiresAt, consumed_at: null }).execute();
    });
    const response: { message: string; debugCode?: string } = { message: '验证码已发送，请在 10 分钟内完成验证。' };
    if (process.env.NODE_ENV !== 'production') response.debugCode = code;
    return response;
  }

  async confirmPasswordReset(input: unknown) {
    const data = PasswordResetConfirmSchema.parse(input);
    const record = await this.db.selectFrom('password_reset_codes').selectAll().where('mobile', '=', data.mobile).where('consumed_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirst();
    if (!record || new Date(record.expires_at) < new Date() || !(await bcrypt.compare(data.code, record.code_hash))) throw new DomainError('短信验证码无效或已过期', HttpStatus.BAD_REQUEST);
    const passwordHash = await bcrypt.hash(data.password, 12);
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx.updateTable('users').set({ password_hash: passwordHash, status: 'active' }).where((eb) => eb.or([eb('username', '=', data.mobile), eb('mobile', '=', data.mobile)])).executeTakeFirst();
      if (!updated.numUpdatedRows) throw new DomainError('账号不存在', HttpStatus.NOT_FOUND);
      await trx.updateTable('password_reset_codes').set({ consumed_at: new Date() }).where('id', '=', record.id).execute();
    });
    return { message: '密码已重置，请使用新密码登录。' };
  }

  members(tenantId: string) {
    return this.db.selectFrom('users').select(['id', 'name', 'username', 'mobile', 'role', 'permissions', 'status', 'last_login_at', 'created_at'])
      .where('tenant_id', '=', tenantId).orderBy('created_at').execute();
  }

  tenant(tenantId: string) {
    return this.db.selectFrom('tenants').select(['id', 'name', 'support_contact', 'timezone', 'valid_until', 'status', 'created_at']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  }

  async updateTenant(tenantId: string, actorRole: string, input: unknown) {
    this.requireMemberManagement(actorRole);
    const data = TenantSettingsSchema.parse(input);
    return this.db.updateTable('tenants').set({ name: data.name, support_contact: data.supportContact, timezone: data.timezone }).where('id', '=', tenantId).returning(['id', 'name', 'support_contact', 'timezone', 'valid_until', 'status', 'created_at']).executeTakeFirstOrThrow();
  }

  async addMember(tenantId: string, actorRole: string, input: unknown) {
    this.requireMemberManagement(actorRole);
    const data = MemberCreateSchema.parse(input);
    try {
      return await this.db.insertInto('users').values({ id: randomUUID(), tenant_id: tenantId, name: data.name, username: data.mobile, mobile: data.mobile, password_hash: await bcrypt.hash(data.password, 12), role: data.role, permissions: JSON.stringify(data.permissions), status: 'active', last_login_at: null }).returning(['id', 'name', 'mobile', 'role', 'permissions', 'status']).executeTakeFirstOrThrow();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('该手机号已被注册', HttpStatus.CONFLICT);
      throw error;
    }
  }

  async updateMember(tenantId: string, actorRole: string, actorId: string, memberId: string, input: unknown) {
    this.requireMemberManagement(actorRole);
    const data = MemberUpdateSchema.parse(input);
    const current = await this.db.selectFrom('users').select(['id', 'role', 'status']).where('id', '=', memberId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!current) throw new DomainError('成员不存在或不属于当前租户', HttpStatus.NOT_FOUND);
    if (actorId === memberId && (data.role !== 'tenant_admin' || data.status !== 'active')) throw new DomainError('不能降低或停用当前登录的租户管理员账号', HttpStatus.BAD_REQUEST);
    const removingActiveAdmin = current.role === 'tenant_admin' && current.status === 'active' && (data.role !== 'tenant_admin' || data.status !== 'active');
    if (removingActiveAdmin) {
      const admins = await this.db.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', tenantId).where('role', '=', 'tenant_admin').where('status', '=', 'active').executeTakeFirstOrThrow();
      if (Number(admins.count) <= 1) throw new DomainError('每个租户至少需要保留一名启用的租户管理员', HttpStatus.BAD_REQUEST);
    }
    const update = { name: data.name, role: data.role, permissions: JSON.stringify(data.permissions), status: data.status, ...(data.password ? { password_hash: await bcrypt.hash(data.password, 12) } : {}) };
    const member = await this.db.updateTable('users').set(update).where('id', '=', memberId).where('tenant_id', '=', tenantId).returning(['id', 'name', 'mobile', 'role', 'permissions', 'status']).executeTakeFirst();
    return member;
  }

  async deleteMember(tenantId: string, actorRole: string, actorId: string, memberId: string) {
    this.requireMemberManagement(actorRole);
    if (actorId === memberId) throw new DomainError('不能删除当前登录账号', HttpStatus.BAD_REQUEST);
    try {
      const result = await this.db.deleteFrom('users').where('id', '=', memberId).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!result.numDeletedRows) throw new DomainError('成员不存在或不属于当前租户', HttpStatus.NOT_FOUND);
      return { message: '成员已删除' };
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw new DomainError('该成员已有历史操作记录，无法删除；请改为停用账号', HttpStatus.CONFLICT);
      throw error;
    }
  }

  private requireMemberManagement(role: string) {
    if (role !== 'tenant_admin') throw new DomainError('只有租户管理员可以管理团队成员', HttpStatus.FORBIDDEN);
  }
}
