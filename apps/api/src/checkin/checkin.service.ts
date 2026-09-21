import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import type { RequestContext } from '../shared/request-context';
import { DomainError } from '../shared/domain-error.filter';

const ScanSchema = z.object({ code: z.string().trim().min(6), checkinPointId: z.string().uuid() });

@Injectable()
export class CheckinService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async points(context: RequestContext, eventId: string) {
    return this.db.selectFrom('checkin_points').selectAll()
      .where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).where('active', '=', true).execute();
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
    const [tickets, checkedIn] = await Promise.all([
      this.db.selectFrom('tickets').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
      this.db.selectFrom('tickets').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).where('status', '=', 'checked_in').executeTakeFirstOrThrow(),
    ]);
    return { issued: Number(tickets.count), checkedIn: Number(checkedIn.count) };
  }
}
