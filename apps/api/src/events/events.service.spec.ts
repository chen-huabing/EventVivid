import { describe, expect, it } from 'vitest';
import { CreateEventSchema, CreateTicketTypeSchema, RegistrationFormSchema } from './events.service';

describe('EventVivid event rules', () => {
  it('accepts a valid event and coerces ISO timestamps', () => {
    const event = CreateEventSchema.parse({
      title: 'EventVivid 发布会', slug: 'eventvivid-launch', description: '', venue: '上海',
      startsAt: '2026-10-10T09:00:00+08:00', endsAt: '2026-10-10T18:00:00+08:00',
    });
    expect(event.startsAt).toBeInstanceOf(Date);
  });

  it('rejects an event that ends before it starts', () => {
    expect(() => CreateEventSchema.parse({
      title: '无效活动', slug: 'invalid-event', description: '', venue: '上海',
      startsAt: '2026-10-10T18:00:00+08:00', endsAt: '2026-10-10T09:00:00+08:00',
    })).toThrow('结束时间必须晚于开始时间');
  });

  it('rejects negative ticket prices and zero capacity', () => {
    expect(() => CreateTicketTypeSchema.parse({
      name: '标准票', priceCents: -1, capacity: 0,
      saleStartsAt: '2026-09-01T00:00:00+08:00', saleEndsAt: '2026-10-01T00:00:00+08:00',
    })).toThrow();
  });

  it('accepts a registration form with core and custom fields', () => {
    const form = RegistrationFormSchema.parse({ fields: [
      { id: 'name', key: 'name', label: '姓名', type: 'text', required: true, enabled: true, system: true },
      { id: 'mobile', key: 'mobile', label: '手机号', type: 'mobile', required: true, enabled: true, system: true },
      { id: 'company', key: 'company', label: '公司', type: 'text', required: false, enabled: true },
    ] });
    expect(form.fields).toHaveLength(3);
  });

  it('requires enabled mandatory name and mobile fields', () => {
    expect(() => RegistrationFormSchema.parse({ fields: [
      { id: 'name', key: 'name', label: '姓名', type: 'text', required: false, enabled: true },
      { id: 'mobile', key: 'mobile', label: '手机号', type: 'mobile', required: true, enabled: false },
    ] })).toThrow('姓名必须启用并设为必填');
  });
});
