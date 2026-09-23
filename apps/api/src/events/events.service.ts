import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../database/database.module';
import type { Database } from '../database/schema';
import type { RequestContext } from '../shared/request-context';
import { DomainError } from '../shared/domain-error.filter';

export const CreateEventSchema = z.object({
  title: z.string().trim().min(2).max(100),
  slug: z.string().trim().regex(/^[a-z0-9-]{3,60}$/).optional(),
  description: z.string().max(5000).default(''),
  venue: z.string().trim().min(2).max(200),
  heroColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#101828'),
  formBackgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f8f7f2'),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
}).refine((value) => value.endsAt > value.startsAt, { message: '结束时间必须晚于开始时间' });

export const CreateTicketTypeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  priceCents: z.number().int().min(0),
  capacity: z.number().int().positive().max(1000000),
  saleStartsAt: z.coerce.date(),
  saleEndsAt: z.coerce.date(),
}).refine((value) => value.saleEndsAt > value.saleStartsAt, { message: '售票结束时间必须晚于开始时间' });

const UpdateEventSchema = z.object({
  title: z.string().trim().min(2).max(100),
  description: z.string().max(5000),
  venue: z.string().trim().min(2).max(200),
  heroColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  formBackgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
}).refine((value) => value.endsAt > value.startsAt, { message: '结束时间必须晚于开始时间' });
const RegistrationStyleSchema = z.object({
  heroColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  formBackgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const RegistrationFieldSchema = z.object({
  id: z.string().trim().min(1).max(80),
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,49}$/),
  label: z.string().trim().min(1).max(30),
  type: z.enum(['text', 'mobile', 'email', 'number', 'select', 'textarea']),
  required: z.boolean(), enabled: z.boolean(), system: z.boolean().optional().default(false),
  placeholder: z.string().max(80).optional().default(''),
  options: z.array(z.string().trim().min(1).max(40)).max(30).optional().default([]),
});
export const RegistrationFormSchema = z.object({ fields: z.array(RegistrationFieldSchema).min(2).max(30) }).superRefine((value, ctx) => {
  const keys = value.fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '字段标识不能重复' });
  for (const key of ['name', 'mobile']) {
    const field = value.fields.find((item) => item.key === key);
    if (!field?.enabled || !field.required) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key === 'name' ? '姓名' : '手机号'}必须启用并设为必填` });
  }
});

@Injectable()
export class EventsService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async list(context: RequestContext) {
    return this.db.selectFrom('events')
      .leftJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .select([
        'events.id', 'events.title', 'events.slug', 'events.venue', 'events.starts_at', 'events.ends_at', 'events.status',
        (eb) => eb.fn.coalesce(eb.fn.sum<number>('ticket_types.capacity'), eb.val(0)).as('capacity'),
        (eb) => eb.fn.coalesce(eb.fn.sum<number>('ticket_types.sold_count'), eb.val(0)).as('sold_count'),
      ])
      .where('events.tenant_id', '=', context.tenantId)
      .groupBy('events.id')
      .orderBy('events.created_at', 'desc')
      .execute();
  }

  async create(context: RequestContext, input: unknown) {
    const data = CreateEventSchema.parse(input);
    try {
      return await this.db.insertInto('events').values({
        id: randomUUID(), tenant_id: context.tenantId, created_by: context.userId,
        title: data.title, slug: data.slug ?? `event-${randomUUID().replace(/-/g, '').slice(0, 16)}`, description: data.description, venue: data.venue, hero_color: data.heroColor, form_background_color: data.formBackgroundColor,
        starts_at: data.startsAt, ends_at: data.endsAt, status: 'draft',
      }).returningAll().executeTakeFirstOrThrow();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('活动短链接已被占用', HttpStatus.CONFLICT);
      throw error;
    }
  }

  async get(context: RequestContext, eventId: string) {
    const event = await this.ownedEvent(context, eventId);
    const [ticketTypes, registrationCount, paidAmount, issued, checkedIn] = await Promise.all([
      this.ticketTypes(context, eventId),
      this.db.selectFrom('registrations').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
      this.db.selectFrom('orders').select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_cents'), eb.val(0)).as('amount')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).where('status', '=', 'paid').executeTakeFirstOrThrow(),
      this.db.selectFrom('tickets').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).executeTakeFirstOrThrow(),
      this.db.selectFrom('tickets').select((eb) => eb.fn.countAll<number>().as('count')).where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).where('status', '=', 'checked_in').executeTakeFirstOrThrow(),
    ]);
    return { ...event, ticketTypes, metrics: { registrations: Number(registrationCount.count), paidAmountCents: Number(paidAmount.amount), issued: Number(issued.count), checkedIn: Number(checkedIn.count) } };
  }

  async update(context: RequestContext, eventId: string, input: unknown) {
    const current = await this.ownedEvent(context, eventId);
    if (current.status === 'cancelled' || current.status === 'ended') throw new DomainError('当前活动状态不允许编辑');
    const data = UpdateEventSchema.parse(input);
    return this.db.updateTable('events').set({ title: data.title, description: data.description, venue: data.venue, hero_color: data.heroColor, form_background_color: data.formBackgroundColor, starts_at: data.startsAt, ends_at: data.endsAt, updated_at: new Date() })
      .where('id', '=', eventId).where('tenant_id', '=', context.tenantId).returningAll().executeTakeFirstOrThrow();
  }

  async updateRegistrationStyle(context: RequestContext, eventId: string, input: unknown) {
    const current = await this.ownedEvent(context, eventId);
    if (current.status === 'cancelled' || current.status === 'ended') throw new DomainError('当前活动状态不允许修改报名页样式');
    const data = RegistrationStyleSchema.parse(input);
    return this.db.updateTable('events').set({ hero_color: data.heroColor, form_background_color: data.formBackgroundColor, updated_at: new Date() })
      .where('id', '=', eventId).where('tenant_id', '=', context.tenantId).returningAll().executeTakeFirstOrThrow();
  }

  async registrationForm(context: RequestContext, eventId: string) {
    const event = await this.ownedEvent(context, eventId);
    return { fields: event.registration_form };
  }

  async updateRegistrationForm(context: RequestContext, eventId: string, input: unknown) {
    const event = await this.ownedEvent(context, eventId);
    if (event.status === 'cancelled' || event.status === 'ended') throw new DomainError('当前活动状态不允许修改报名表');
    const data = RegistrationFormSchema.parse(input);
    const fields = data.fields.map((field, index) => ({ ...field, order: index }));
    await this.db.updateTable('events').set({ registration_form: JSON.stringify(fields), updated_at: new Date() })
      .where('id', '=', eventId).where('tenant_id', '=', context.tenantId).executeTakeFirstOrThrow();
    return { fields };
  }

  async createPreviewToken(context: RequestContext, eventId: string) {
    const event = await this.ownedEvent(context, eventId);
    const token = jwt.sign(
      { scope: 'event_preview', eventId: event.id, tenantId: context.tenantId },
      process.env.PREVIEW_JWT_SECRET ?? process.env.TENANT_JWT_SECRET ?? '',
      { subject: context.userId, expiresIn: '15m' },
    );
    return { token, slug: event.slug, expiresInSeconds: 900 };
  }

  async ticketTypes(context: RequestContext, eventId: string) {
    await this.ownedEvent(context, eventId);
    return this.db.selectFrom('ticket_types').selectAll().where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).orderBy('created_at').execute();
  }

  async registrations(context: RequestContext, eventId: string) {
    await this.ownedEvent(context, eventId);
    return this.db.selectFrom('registrations')
      .innerJoin('ticket_types', 'ticket_types.id', 'registrations.ticket_type_id')
      .leftJoin('orders', 'orders.registration_id', 'registrations.id')
      .leftJoin('tickets', 'tickets.registration_id', 'registrations.id')
      .select(['registrations.id', 'registrations.attendee_name', 'registrations.attendee_mobile', 'registrations.attendee_email', 'registrations.form_data', 'registrations.status', 'registrations.created_at', 'ticket_types.name as ticket_type_name', 'orders.order_no', 'orders.amount_cents', 'orders.status as order_status', 'orders.paid_at', 'tickets.code as ticket_code', 'tickets.status as ticket_status', 'tickets.created_at as ticket_issued_at', 'tickets.checked_in_at'])
      .where('registrations.tenant_id', '=', context.tenantId).where('registrations.event_id', '=', eventId).orderBy('registrations.created_at', 'desc').execute();
  }

  async orders(context: RequestContext, eventId: string) {
    await this.ownedEvent(context, eventId);
    return this.db.selectFrom('orders').innerJoin('registrations', 'registrations.id', 'orders.registration_id')
      .select(['orders.id', 'orders.order_no', 'orders.amount_cents', 'orders.status', 'orders.paid_at', 'orders.created_at', 'registrations.attendee_name', 'registrations.attendee_mobile'])
      .where('orders.tenant_id', '=', context.tenantId).where('orders.event_id', '=', eventId).orderBy('orders.created_at', 'desc').execute();
  }

  async issuedTickets(context: RequestContext, eventId: string) {
    await this.ownedEvent(context, eventId);
    return this.db.selectFrom('tickets').innerJoin('registrations', 'registrations.id', 'tickets.registration_id')
      .innerJoin('ticket_types', 'ticket_types.id', 'registrations.ticket_type_id')
      .select(['tickets.id', 'tickets.code', 'tickets.status', 'tickets.checked_in_at', 'tickets.created_at', 'registrations.attendee_name', 'registrations.attendee_mobile', 'ticket_types.name as ticket_type_name'])
      .where('tickets.tenant_id', '=', context.tenantId).where('tickets.event_id', '=', eventId).orderBy('tickets.created_at', 'desc').execute();
  }

  async addTicketType(context: RequestContext, eventId: string, input: unknown) {
    const data = CreateTicketTypeSchema.parse(input);
    const event = await this.ownedEvent(context, eventId);
    if (event.status !== 'draft') throw new DomainError('只有草稿活动可以新增票种');
    return this.db.insertInto('ticket_types').values({
      id: randomUUID(), tenant_id: context.tenantId, event_id: eventId, name: data.name,
      price_cents: data.priceCents, capacity: data.capacity,
      sale_starts_at: data.saleStartsAt, sale_ends_at: data.saleEndsAt,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async updateTicketType(context: RequestContext, eventId: string, ticketTypeId: string, input: unknown) {
    const data = CreateTicketTypeSchema.parse(input);
    const event = await this.ownedEvent(context, eventId);
    if (event.status === 'cancelled' || event.status === 'ended') throw new DomainError('当前活动状态不允许编辑票种');
    const ticketType = await this.db.selectFrom('ticket_types').selectAll()
      .where('id', '=', ticketTypeId).where('event_id', '=', eventId).where('tenant_id', '=', context.tenantId).executeTakeFirst();
    if (!ticketType) throw new DomainError('票种不存在', HttpStatus.NOT_FOUND);
    if (data.capacity < ticketType.sold_count) throw new DomainError(`库存不能低于已售数量 ${ticketType.sold_count}`);
    return this.db.updateTable('ticket_types').set({
      name: data.name, price_cents: data.priceCents, capacity: data.capacity,
      sale_starts_at: data.saleStartsAt, sale_ends_at: data.saleEndsAt,
    }).where('id', '=', ticketTypeId).where('event_id', '=', eventId).where('tenant_id', '=', context.tenantId)
      .returningAll().executeTakeFirstOrThrow();
  }

  async deleteTicketType(context: RequestContext, eventId: string, ticketTypeId: string) {
    const event = await this.ownedEvent(context, eventId);
    if (event.status === 'cancelled' || event.status === 'ended') throw new DomainError('当前活动状态不允许删除票种');
    return this.db.transaction().execute(async (trx) => {
      const ticketType = await trx.selectFrom('ticket_types').selectAll()
        .where('id', '=', ticketTypeId).where('event_id', '=', eventId).where('tenant_id', '=', context.tenantId)
        .forUpdate().executeTakeFirst();
      if (!ticketType) throw new DomainError('票种不存在', HttpStatus.NOT_FOUND);
      if (ticketType.sold_count > 0) throw new DomainError('已有销售记录的票种不能删除', HttpStatus.CONFLICT);
      const registration = await trx.selectFrom('registrations').select('id')
        .where('ticket_type_id', '=', ticketTypeId).where('tenant_id', '=', context.tenantId).executeTakeFirst();
      if (registration) throw new DomainError('已有报名记录的票种不能删除', HttpStatus.CONFLICT);
      await trx.deleteFrom('ticket_types').where('id', '=', ticketTypeId).where('tenant_id', '=', context.tenantId).execute();
      return { deleted: true, ticketTypeId };
    });
  }

  async publish(context: RequestContext, eventId: string) {
    const event = await this.ownedEvent(context, eventId);
    const ticket = await this.db.selectFrom('ticket_types').select('id')
      .where('tenant_id', '=', context.tenantId).where('event_id', '=', eventId).executeTakeFirst();
    if (!ticket) throw new DomainError('至少配置一个票种后才能发布');
    if (event.status === 'cancelled') throw new DomainError('已取消活动不能发布');
    return this.db.transaction().execute(async (trx) => {
      const published = await trx.updateTable('events').set({ status: 'published', updated_at: new Date() })
        .where('id', '=', eventId).where('tenant_id', '=', context.tenantId).returningAll().executeTakeFirstOrThrow();
      const point = await trx.selectFrom('checkin_points').select('id').where('event_id', '=', eventId).executeTakeFirst();
      if (!point) await trx.insertInto('checkin_points').values({ id: randomUUID(), tenant_id: context.tenantId, event_id: eventId, name: '主入口' }).execute();
      await trx.insertInto('outbox_events').values({
        id: randomUUID(), tenant_id: context.tenantId, aggregate_type: 'event', aggregate_id: eventId,
        event_type: 'event.published', payload: { eventId }, published_at: null,
      }).execute();
      return published;
    });
  }

  async unpublish(context: RequestContext, eventId: string) {
    const event = await this.ownedEvent(context, eventId);
    if (event.status !== 'published') throw new DomainError('只有已发布活动可以下线');
    return this.db.transaction().execute(async (trx) => {
      const draft = await trx.updateTable('events').set({ status: 'draft', updated_at: new Date() })
        .where('id', '=', eventId).where('tenant_id', '=', context.tenantId).where('status', '=', 'published')
        .returningAll().executeTakeFirst();
      if (!draft) throw new DomainError('活动状态已变化，请刷新后重试', HttpStatus.CONFLICT);
      await trx.insertInto('outbox_events').values({
        id: randomUUID(), tenant_id: context.tenantId, aggregate_type: 'event', aggregate_id: eventId,
        event_type: 'event.unpublished', payload: { eventId, previousStatus: 'published' }, published_at: null,
      }).execute();
      return draft;
    });
  }

  async publicBySlug(slug: string) {
    const event = await this.db.selectFrom('events').selectAll().where('slug', '=', slug).where('status', '=', 'published').executeTakeFirst();
    if (!event) throw new DomainError('活动不存在或尚未发布', HttpStatus.NOT_FOUND);
    const ticketTypes = await this.db.selectFrom('ticket_types').selectAll().where('event_id', '=', event.id).orderBy('price_cents').execute();
    return { ...event, ticketTypes };
  }

  async previewBySlug(slug: string, token: string) {
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, process.env.PREVIEW_JWT_SECRET ?? process.env.TENANT_JWT_SECRET ?? '') as jwt.JwtPayload;
    } catch {
      throw new DomainError('预览链接无效或已过期', HttpStatus.UNAUTHORIZED);
    }
    if (payload.scope !== 'event_preview') throw new DomainError('预览链接无效', HttpStatus.UNAUTHORIZED);
    const event = await this.db.selectFrom('events').selectAll().where('slug', '=', slug)
      .where('id', '=', String(payload.eventId)).where('tenant_id', '=', String(payload.tenantId)).executeTakeFirst();
    if (!event) throw new DomainError('活动不存在', HttpStatus.NOT_FOUND);
    const ticketTypes = await this.db.selectFrom('ticket_types').selectAll().where('event_id', '=', event.id).orderBy('price_cents').execute();
    return { ...event, ticketTypes, preview: true };
  }

  private async ownedEvent(context: RequestContext, eventId: string) {
    const event = await this.db.selectFrom('events').selectAll().where('id', '=', eventId).where('tenant_id', '=', context.tenantId).executeTakeFirst();
    if (!event) throw new DomainError('活动不存在', HttpStatus.NOT_FOUND);
    return event;
  }
}
