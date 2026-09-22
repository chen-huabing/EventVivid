import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import type { RequestContext } from '../shared/request-context';
import { DomainError } from '../shared/domain-error.filter';

const ScanSchema = z.object({ code: z.string().trim().min(6), checkinPointId: z.string().uuid() });
const PointSchema = z.object({ name: z.string().trim().min(2, '验签点名称至少需要 2 个字符').max(50) });
const PointUpdateSchema = PointSchema.partial().extend({ active: z.boolean().optional() });
const PointStaffSchema = z.object({ userIds: z.array(z.string().uuid()).max(100) });

@Injectable()
export class CheckinService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async myEvents(context: RequestContext) {
    await this.requireCheckinManager(context);
    const now = new Date();
    let eventQuery = this.db.selectFrom('events').select(['events.id', 'events.title', 'events.venue', 'events.starts_at', 'events.ends_at'])
      .where('events.tenant_id', '=', context.tenantId).where('events.status', '=', 'published')
      .where('events.starts_at', '<=', now).where('events.ends_at', '>=', now);
    if (context.role !== 'tenant_admin') eventQuery = eventQuery.innerJoin('checkin_points', 'checkin_points.event_id', 'events.id')
      .innerJoin('checkin_point_staff', 'checkin_point_staff.checkin_point_id', 'checkin_points.id')
      .where('checkin_points.active', '=', true).where('checkin_point_staff.user_id', '=', context.userId)
      .groupBy(['events.id', 'events.title', 'events.venue', 'events.starts_at', 'events.ends_at']);
    return eventQuery.orderBy('events.starts_at').execute();
  }

  async points(context: RequestContext, eventId: string) {
    await this.requireCheckinManager(context);
    await this.requireEvent(context, eventId);
    let pointQuery = this.db.selectFrom('checkin_points').selectAll()
      .where('checkin_points.tenant_id', '=', context.tenantId).where('checkin_points.event_id', '=', eventId);
    if (context.role === 'checkin_staff') pointQuery = pointQuery.innerJoin('checkin_point_staff', 'checkin_point_staff.checkin_point_id', 'checkin_points.id').where('checkin_point_staff.user_id', '=', context.userId);
    const points = await pointQuery.orderBy('checkin_points.created_at').execute();
    const assignments = points.length ? await this.db.selectFrom('checkin_point_staff').innerJoin('users', 'users.id', 'checkin_point_staff.user_id')
      .select(['checkin_point_staff.checkin_point_id', 'users.id', 'users.name', 'users.mobile'])
      .where('checkin_point_staff.checkin_point_id', 'in', points.map(point => point.id)).execute() : [];
    return points.map(point => ({ ...point, staff: assignments.filter(item => item.checkin_point_id === point.id).map(({ id, name, mobile }) => ({ id, name, mobile })) }));
  }

  async createPoint(context: RequestContext, eventId: string, input: unknown) {
    await this.requireCheckinManager(context);
    await this.requireEvent(context, eventId);
    const data = PointSchema.parse(input);
    return this.db.insertInto('checkin_points').values({ id: randomUUID(), tenant_id: context.tenantId, event_id: eventId, name: data.name }).returningAll().executeTakeFirstOrThrow();
  }

  async updatePoint(context: RequestContext, pointId: string, input: unknown) {
    await this.requireCheckinManager(context);
    const data = PointUpdateSchema.parse(input);
    if (!Object.keys(data).length) throw new DomainError('请提供需要修改的验签点信息');
    const point = await this.db.updateTable('checkin_points').set(data).where('id', '=', pointId).where('tenant_id', '=', context.tenantId).returningAll().executeTakeFirst();
    if (!point) throw new DomainError('验签点不存在或不属于当前租户', HttpStatus.NOT_FOUND);
    return point;
  }

  async staff(context: RequestContext, eventId: string) {
    await this.requireCheckinManager(context);
    await this.requireEvent(context, eventId);
    const members = await this.db.selectFrom('users').select(['id', 'name', 'mobile', 'role', 'permissions'])
      .where('tenant_id', '=', context.tenantId).where('status', '=', 'active').orderBy('created_at').execute();
    const pointIds = await this.db.selectFrom('checkin_points').select('id').where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).execute();
    const assignments = pointIds.length ? await this.db.selectFrom('checkin_point_staff').select(['checkin_point_id', 'user_id']).where('checkin_point_id', 'in', pointIds.map(point => point.id)).execute() : [];
    return members.map(member => ({ id: member.id, name: member.name, mobile: member.mobile, role: member.role, can_checkin: member.role === 'tenant_admin' || this.permissions(member.permissions).includes('checkin.manage'), point_ids: assignments.filter(item => item.user_id === member.id).map(item => item.checkin_point_id) }));
  }

  async updatePointStaff(context: RequestContext, pointId: string, input: unknown) {
    await this.requireCheckinManager(context);
    const data = PointStaffSchema.parse(input);
    const point = await this.db.selectFrom('checkin_points').selectAll().where('id', '=', pointId).where('tenant_id', '=', context.tenantId).executeTakeFirst();
    if (!point) throw new DomainError('验签点不存在或不属于当前租户', HttpStatus.NOT_FOUND);
    const ids = [...new Set(data.userIds)];
    if (ids.length) {
      const members = await this.db.selectFrom('users').select(['id', 'role', 'permissions']).where('tenant_id', '=', context.tenantId).where('status', '=', 'active').where('id', 'in', ids).execute();
      if (members.length !== ids.length || members.some(member => member.role !== 'tenant_admin' && !this.permissions(member.permissions).includes('checkin.manage'))) throw new DomainError('只能授权已启用且拥有“现场验签管理”权限的成员');
    }
    await this.db.transaction().execute(async trx => {
      await trx.deleteFrom('checkin_point_staff').where('checkin_point_id', '=', pointId).execute();
      if (ids.length) await trx.insertInto('checkin_point_staff').values(ids.map(userId => ({ checkin_point_id: pointId, user_id: userId }))).execute();
    });
    return this.points(context, point.event_id);
  }

  async verify(context: RequestContext, code: string) {
    const ticket = await this.db.selectFrom('tickets')
      .innerJoin('registrations', 'registrations.id', 'tickets.registration_id')
      .innerJoin('events', 'events.id', 'tickets.event_id')
      .select(['tickets.id', 'tickets.code', 'tickets.status', 'tickets.event_id', 'tickets.checked_in_at', 'registrations.attendee_name', 'registrations.attendee_mobile', 'events.title'])
      .where('tickets.tenant_id', '=', context.tenantId).where('tickets.code', '=', code).executeTakeFirst();
    if (!ticket) throw new DomainError('未找到票券', HttpStatus.NOT_FOUND);
    return { ...ticket, canCheckin: ticket.status === 'valid' };
  }

  async scan(context: RequestContext, input: unknown, idempotencyKey: string) {
    if (!idempotencyKey) throw new DomainError('缺少 Idempotency-Key 请求头');
    const data = ScanSchema.parse(input);
    const cached = await this.db.selectFrom('idempotency_keys').select('response')
      .where('tenant_id', '=', context.tenantId).where('scope', '=', 'checkin').where('key', '=', idempotencyKey).executeTakeFirst();
    if (cached) return cached.response;
    return this.db.transaction().execute(async (trx) => {
      const point = await trx.selectFrom('checkin_points').selectAll()
        .where('id', '=', data.checkinPointId).where('tenant_id', '=', context.tenantId).where('active', '=', true).executeTakeFirst();
      if (!point) throw new DomainError('验签点无效', HttpStatus.NOT_FOUND);
      if (context.role !== 'tenant_admin') {
        const authorized = await trx.selectFrom('checkin_point_staff').select('user_id').where('checkin_point_id', '=', point.id).where('user_id', '=', context.userId).executeTakeFirst();
        if (!authorized) throw new DomainError('当前工作人员未获此验签点授权', HttpStatus.FORBIDDEN);
      }
      const ticket = await trx.selectFrom('tickets').selectAll()
        .where('code', '=', data.code).where('tenant_id', '=', context.tenantId).forUpdate().executeTakeFirst();
      if (!ticket || ticket.event_id !== point.event_id) throw new DomainError('票券无效或不属于当前活动', HttpStatus.NOT_FOUND);
      const result = ticket.status === 'valid' ? 'success' : ticket.status === 'checked_in' ? 'duplicate' : 'invalid';
      const checkedInAt = result === 'success' ? new Date() : ticket.checked_in_at;
      if (result === 'success') {
        await trx.updateTable('tickets').set({ status: 'checked_in', checked_in_at: checkedInAt }).where('id', '=', ticket.id).execute();
      }
      await trx.insertInto('checkin_records').values({
        id: randomUUID(), tenant_id: context.tenantId, event_id: ticket.event_id, ticket_id: ticket.id,
        checkin_point_id: point.id, operator_id: context.userId, result,
      }).execute();
      const response = { result, ticketCode: ticket.code, checkedInAt, message: result === 'success' ? '验签成功' : result === 'duplicate' ? '该票已验签' : '票券状态无效' };
      await trx.insertInto('idempotency_keys').values({ tenant_id: context.tenantId, scope: 'checkin', key: idempotencyKey, response }).execute();
      return response;
    });
  }

  async stats(context: RequestContext, eventId: string) {
    await this.requireCheckinManager(context);
    const [tickets, checkedIn] = await Promise.all([
      this.db.selectFrom('tickets').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
      this.db.selectFrom('tickets').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).where('status', '=', 'checked_in').executeTakeFirstOrThrow(),
    ]);
    return { issued: Number(tickets.count), checkedIn: Number(checkedIn.count) };
  }

  private permissions(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }
    return [];
  }

  private async requireCheckinManager(context: RequestContext) {
    if (context.role === 'tenant_admin') return;
    const user = await this.db.selectFrom('users').select('permissions').where('id', '=', context.userId).where('tenant_id', '=', context.tenantId).executeTakeFirst();
    if (!user || !this.permissions(user.permissions).includes('checkin.manage')) throw new DomainError('没有现场验签管理权限', HttpStatus.FORBIDDEN);
  }

  private async requireEvent(context: RequestContext, eventId: string) {
    const event = await this.db.selectFrom('events').select('id').where('id', '=', eventId).where('tenant_id', '=', context.tenantId).executeTakeFirst();
    if (!event) throw new DomainError('活动不存在或不属于当前租户', HttpStatus.NOT_FOUND);
  }
}
