import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import { RegistrationFormSchema } from '../events/events.service';
import { DomainError } from '../shared/domain-error.filter';
import { expireCreditHolds } from '../shared/credit-holds';

const RegisterSchema = z.object({
  ticketTypeId: z.string().uuid(), attendeeName: z.string().trim().min(2, '姓名至少需要输入 2 个字符').max(60, '姓名不能超过 60 个字符'),
  attendeeMobile: z.string().trim().regex(/^1\d{10}$/), attendeeEmail: z.string().email().optional().or(z.literal('')),
  formData: z.record(z.string().max(1000)).default({}),
});
const TicketLookupSchema = z.string().trim().regex(/^1\d{10}$/, '请输入报名使用的 11 位手机号');

@Injectable()
export class RegistrationService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async register(slug: string, input: unknown, idempotencyKey: string) {
    if (!idempotencyKey) throw new DomainError('缺少 Idempotency-Key 请求头');
    const data = RegisterSchema.parse(input);
    const event = await this.db.selectFrom('events').selectAll().where('slug', '=', slug).where('status', '=', 'published').executeTakeFirst();
    if (!event) throw new DomainError('活动不存在或不可报名', HttpStatus.NOT_FOUND);
    const parsedForm = RegistrationFormSchema.safeParse({ fields: event.registration_form });
    if (!parsedForm.success) throw new DomainError('活动报名表配置无效，请联系主办方');
    const answers: Record<string, string> = { ...data.formData, name: data.attendeeName, mobile: data.attendeeMobile, email: data.attendeeEmail || '' };
    for (const field of parsedForm.data.fields.filter((item) => item.enabled)) {
      const value = String(answers[field.key] ?? '').trim();
      if (field.required && !value) throw new DomainError(`${field.label}为必填项`);
      if (field.type === 'select' && value && !field.options.includes(value)) throw new DomainError(`${field.label}选项无效`);
    }
    const cached = await this.db.selectFrom('idempotency_keys').select('response')
      .where('tenant_id', '=', event.tenant_id).where('scope', '=', 'registration').where('key', '=', idempotencyKey).executeTakeFirst();
    if (cached) return cached.response;

    await expireCreditHolds(this.db, event.tenant_id);
    return this.db.transaction().execute(async (trx) => {
      const wallet = await trx.updateTable('credit_wallets').set((eb) => ({ reserved: eb('reserved', '+', 1), updated_at: new Date() }))
        .where('tenant_id', '=', event.tenant_id).whereRef('balance', '>', 'reserved').returning('tenant_id').executeTakeFirst();
      if (!wallet) throw new DomainError('电子票额度不足，暂时无法报名，请联系主办方', HttpStatus.CONFLICT);
      const ticketType = await trx.updateTable('ticket_types').set((eb) => ({ sold_count: eb('sold_count', '+', 1) }))
        .where('id', '=', data.ticketTypeId).where('event_id', '=', event.id).where('tenant_id', '=', event.tenant_id)
        .whereRef('sold_count', '<', 'capacity').returningAll().executeTakeFirst();
      if (!ticketType) throw new DomainError('票券已售罄或票种无效', HttpStatus.CONFLICT);
      const registrationId = randomUUID();
      const orderId = randomUUID();
      const orderNo = `EV${Date.now()}${randomBytes(3).toString('hex').toUpperCase()}`;
      await trx.insertInto('registrations').values({
        id: registrationId, tenant_id: event.tenant_id, event_id: event.id, ticket_type_id: ticketType.id,
        attendee_name: data.attendeeName, attendee_mobile: data.attendeeMobile,
        attendee_email: data.attendeeEmail || null, form_data: answers, status: 'pending_payment',
      }).execute();
      const order = await trx.insertInto('orders').values({
        id: orderId, tenant_id: event.tenant_id, event_id: event.id, registration_id: registrationId,
        order_no: orderNo, amount_cents: ticketType.price_cents, status: 'pending', paid_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('credit_holds').values({ order_id: orderId, tenant_id: event.tenant_id, status: 'reserved', expires_at: new Date(Date.now() + 15 * 60_000) }).execute();
      const response = { registrationId, orderId, orderNo, amountCents: order.amount_cents, status: order.status };
      await trx.insertInto('idempotency_keys').values({ tenant_id: event.tenant_id, scope: 'registration', key: idempotencyKey, response }).execute();
      return response;
    });
  }

  async confirmPayment(orderId: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new DomainError('缺少 Idempotency-Key 请求头');
    const orderTenant = await this.db.selectFrom('orders').select('tenant_id').where('id', '=', orderId).executeTakeFirst();
    if (!orderTenant) throw new DomainError('订单不存在', HttpStatus.NOT_FOUND);
    await expireCreditHolds(this.db, orderTenant.tenant_id);
    return this.db.transaction().execute(async (trx) => {
      const orderRef = await trx.selectFrom('orders').select('tenant_id').where('id', '=', orderId).executeTakeFirst();
      if (!orderRef) throw new DomainError('订单不存在', HttpStatus.NOT_FOUND);
      await trx.selectFrom('credit_wallets').select('tenant_id').where('tenant_id', '=', orderRef.tenant_id).forUpdate().executeTakeFirst();
      const order = await trx.selectFrom('orders').selectAll().where('id', '=', orderId).forUpdate().executeTakeFirst();
      if (!order) throw new DomainError('订单不存在', HttpStatus.NOT_FOUND);
      const existing = await trx.selectFrom('tickets').selectAll().where('registration_id', '=', order.registration_id).executeTakeFirst();
      if (order.status === 'paid' && existing) return { order, ticket: existing };
      if (order.status !== 'pending') throw new DomainError('订单状态不允许支付');
      if (order.amount_cents > 0 && process.env.NODE_ENV === 'production') throw new DomainError('付费票尚未接入真实支付回调，暂不能确认支付', HttpStatus.SERVICE_UNAVAILABLE);
      let hold = await trx.selectFrom('credit_holds').selectAll().where('order_id', '=', order.id).executeTakeFirst();
      // 兼容升级前创建、尚未确认支付的订单。
      if (!hold) {
        const reserved = await trx.updateTable('credit_wallets').set((eb) => ({ reserved: eb('reserved', '+', 1), updated_at: new Date() }))
          .where('tenant_id', '=', order.tenant_id).whereRef('balance', '>', 'reserved').returning('tenant_id').executeTakeFirst();
        if (!reserved) throw new DomainError('电子票额度不足，请联系主办方', HttpStatus.CONFLICT);
        hold = await trx.insertInto('credit_holds').values({ order_id: order.id, tenant_id: order.tenant_id, status: 'reserved', expires_at: new Date(Date.now() + 15 * 60_000) }).returningAll().executeTakeFirstOrThrow();
      }
      if (hold.status !== 'reserved') throw new DomainError('订单额度预留状态无效', HttpStatus.CONFLICT);
      await trx.updateTable('credit_wallets').set((eb) => ({ balance: eb('balance', '-', 1), reserved: eb('reserved', '-', 1), updated_at: new Date() }))
        .where('tenant_id', '=', order.tenant_id).where('reserved', '>', 0).returning('tenant_id').executeTakeFirstOrThrow();
      await trx.updateTable('credit_holds').set({ status: 'consumed' }).where('order_id', '=', order.id).execute();
      await trx.insertInto('credit_ledger').values({ id: randomUUID(), tenant_id: order.tenant_id, change: -1, kind: 'issue', reference: `issue:${order.id}`, note: '电子票出票' }).execute();
      const now = new Date();
      const paidOrder = await trx.updateTable('orders').set({ status: 'paid', paid_at: now }).where('id', '=', orderId).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable('registrations').set({ status: 'confirmed' }).where('id', '=', order.registration_id).execute();
      const ticket = await trx.insertInto('tickets').values({
        id: randomUUID(), tenant_id: order.tenant_id, event_id: order.event_id, registration_id: order.registration_id,
        code: `EVT-${randomBytes(8).toString('hex').toUpperCase()}`, status: 'valid', checked_in_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('outbox_events').values({
        id: randomUUID(), tenant_id: order.tenant_id, aggregate_type: 'order', aggregate_id: order.id,
        event_type: 'order.paid', payload: { orderId: order.id, ticketId: ticket.id, idempotencyKey }, published_at: null,
      }).execute();
      return { order: paidOrder, ticket };
    });
  }

  async ticket(code: string) {
    const result = await this.db.selectFrom('tickets')
      .innerJoin('registrations', 'registrations.id', 'tickets.registration_id')
      .innerJoin('events', 'events.id', 'tickets.event_id')
      .innerJoin('ticket_types', 'ticket_types.id', 'registrations.ticket_type_id')
      .select(['tickets.code', 'tickets.status', 'tickets.checked_in_at', 'registrations.attendee_name', 'ticket_types.name as ticket_type_name', 'events.title', 'events.slug', 'events.venue', 'events.starts_at'])
      .where('tickets.code', '=', code).executeTakeFirst();
    if (!result) throw new DomainError('票券不存在', HttpStatus.NOT_FOUND);
    return result;
  }

  async ticketsByMobile(slug: string, mobile: string) {
    const attendeeMobile = TicketLookupSchema.parse(mobile);
    const event = await this.db.selectFrom('events').select(['id', 'title', 'slug']).where('slug', '=', slug).executeTakeFirst();
    if (!event) throw new DomainError('活动不存在', HttpStatus.NOT_FOUND);
    return this.db.selectFrom('tickets').innerJoin('registrations', 'registrations.id', 'tickets.registration_id')
      .innerJoin('ticket_types', 'ticket_types.id', 'registrations.ticket_type_id')
      .select(['tickets.code', 'tickets.status', 'tickets.checked_in_at', 'registrations.attendee_name', 'ticket_types.name as ticket_type_name', 'tickets.created_at'])
      .where('tickets.event_id', '=', event.id).where('registrations.attendee_mobile', '=', attendeeMobile).orderBy('tickets.created_at', 'desc').execute();
  }
}
