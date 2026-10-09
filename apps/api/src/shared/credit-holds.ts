import { Kysely } from 'kysely';
import type { Database } from '../database/schema';

// 所有消费与清理操作先锁租户账户，避免超卖和订单／账户交叉死锁。
export async function expireCreditHolds(db: Kysely<Database>, tenantId: string) {
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('credit_wallets').select('tenant_id').where('tenant_id', '=', tenantId).forUpdate().executeTakeFirst();
    const expired = await trx.selectFrom('credit_holds').select('order_id').where('tenant_id', '=', tenantId)
      .where('status', '=', 'reserved').where('expires_at', '<=', new Date()).execute();
    for (const hold of expired) {
      const order = await trx.selectFrom('orders').select(['registration_id', 'status', 'amount_cents']).where('id', '=', hold.order_id).forUpdate().executeTakeFirst();
      if (!order || !['pending', 'closed'].includes(order.status)) continue;
      await trx.updateTable('credit_holds').set({ status: 'released' }).where('order_id', '=', hold.order_id).execute();
      await trx.updateTable('credit_wallets').set((eb) => ({ reserved: eb('reserved', '-', 1), updated_at: new Date() })).where('tenant_id', '=', tenantId).execute();
      if (order.status === 'pending') await trx.updateTable('orders').set({ status: 'closed' }).where('id', '=', hold.order_id).execute();
      const registration = await trx.updateTable('registrations').set({ status: 'cancelled' }).where('id', '=', order.registration_id).returning('ticket_type_id').executeTakeFirstOrThrow();
      await trx.updateTable('ticket_types').set((eb) => ({ sold_count: eb('sold_count', '-', 1) })).where('id', '=', registration.ticket_type_id).execute();
    }
  });
}
