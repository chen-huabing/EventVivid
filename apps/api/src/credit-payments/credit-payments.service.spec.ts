import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { PostgresDialectConfig } from 'kysely';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { Database } from '../database/schema';
import { creditPaymentsSql } from '../database/credit-payments.sql';
import type { TenantPrincipal } from '../tenant-auth/tenant-auth.guard';
import type { HuifuGateway } from './huifu.gateway';
import { CreditPaymentsService } from './credit-payments.service';

// An actual in-memory PostgreSQL engine, never the configured remote database.
const pg=new PGlite();
let queue=Promise.resolve();
const pool={
 async connect(){const previous=queue;let release!:()=>void;queue=new Promise<void>(r=>{release=r;});await previous;return {
  async query(statement:string,parameters:unknown[]=[]){const result=await pg.query(statement,parameters);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length,command:statement.trim().split(/\s/)[0]?.toUpperCase()};},release,
 };},async end(){await pg.close();},
};
// Streaming cursors are not used by this adapter/test suite.
const db=new Kysely<Database>({dialect:new PostgresDialect({pool:pool as unknown as PostgresDialectConfig['pool']})});
const user:TenantPrincipal={id:'00000000-0000-4000-8000-000000000002',tenantId:'00000000-0000-4000-8000-000000000001',name:'测试管理员',username:'test',role:'tenant_admin',tenantName:'测试企业'};
const other={...user,tenantId:'00000000-0000-4000-8000-000000000003'};
const gateway={readiness:vi.fn(()=>({ready:true,missing:[]})),assertReady:vi.fn(),call:vi.fn(),huifuId:'merchant-test',appId:'wx0000000000000001',webOrigin:'https://checkout.example.com',apiOrigin:'https://checkout.example.com',checkoutSecret:'test-secret-only-not-for-deployment-123456789'};
const service=new CreditPaymentsService(db,gateway as unknown as HuifuGateway);
const info={appId:gateway.appId,timeStamp:'1234567890',nonceStr:'test-nonce',package:'prepay_id=test',signType:'RSA',paySign:'test-signature'};
async function create(count:100|500|2000=100,key=randomUUID()){return service.create(user,{packCount:count,idempotencyKey:key});}
async function processing(id:string){await db.updateTable('credit_purchase_orders').set({status:'processing',payment_started_at:new Date(),next_query_at:new Date(0)}).where('id','=',id).execute();}
async function transaction(id:string,state='S'){
 const o=await db.selectFrom('credit_purchase_orders').selectAll().where('id','=',id).executeTakeFirstOrThrow();
 return {req_date:o.req_date,req_seq_id:o.req_seq_id,huifu_id:o.huifu_id,trans_amt:(o.amount_cents/100).toFixed(2),trade_type:'T_JSAPI',trans_stat:state,hf_seq_id:`hf-${id}`,resp_code:'00000000',pay_info:JSON.stringify(info)};
}
function token(order:{checkoutUrl:string|null}){return new URL(order.checkoutUrl!).searchParams.get('token')!;}
function payer(id:string,openid='payer-one'){return jwt.sign({purpose:'credit-payer',openid,appId:gateway.appId},gateway.checkoutSecret,{algorithm:'HS256',subject:id,expiresIn:'30m',audience:'eventvivid-credit-payment',issuer:'eventvivid-api'});}

beforeAll(async()=>{
 await pg.exec(`CREATE TABLE tenants(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);
 CREATE TABLE credit_wallets(tenant_id uuid PRIMARY KEY,balance integer NOT NULL CHECK(balance>=0),reserved integer NOT NULL,updated_at timestamptz DEFAULT now());
 CREATE TABLE credit_ledger(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,change integer NOT NULL,kind text NOT NULL,reference text NOT NULL,note text NOT NULL,created_at timestamptz DEFAULT now(),UNIQUE(tenant_id,reference));
 INSERT INTO tenants VALUES('${user.tenantId}'),('${other.tenantId}');INSERT INTO users VALUES('${user.id}');
 INSERT INTO credit_wallets VALUES('${user.tenantId}',100,20,now()),('${other.tenantId}',100,0,now());`);
 await pg.exec(creditPaymentsSql);
 // Reapplying this additive migration must not alter balances or duplicate tables.
 await pg.exec(creditPaymentsSql);
},30000);
beforeEach(async()=>{
 await pg.exec('TRUNCATE credit_payment_oauth_states,credit_payment_notifications,credit_purchase_orders,credit_ledger;UPDATE credit_wallets SET balance=100;');
 vi.clearAllMocks();gateway.call.mockReset();gateway.readiness.mockReturnValue({ready:true,missing:[]});
});
afterAll(async()=>{service.onModuleDestroy();await db.destroy();});

describe('credit purchase persistence and settlement',()=>{
 it('creates one server-priced order for concurrent identical requests',async()=>{
  const key=randomUUID();const [a,b]=await Promise.all([create(500,key),create(500,key)]);expect(a.id).toBe(b.id);expect(a.amountCents).toBe(39900);expect(a.count).toBe(500);
  expect((await db.selectFrom('credit_purchase_orders').selectAll().execute()).length).toBe(1);expect(gateway.call).not.toHaveBeenCalled();
  await expect(create(100,key)).rejects.toThrow('重复请求');
 });
 it('isolates orders by tenant and prevents non-admin purchase',async()=>{
  const o=await create();await expect(service.owned(other,o.id)).rejects.toThrow('不存在');await expect(service.create({...user,role:'staff'},{packCount:100,idempotencyKey:randomUUID()})).rejects.toThrow('仅租户管理员');
 });
 it('does not add credits for accepted or unconfirmed transactions',async()=>{
  const o=await create();await processing(o.id);gateway.call.mockResolvedValue(await transaction(o.id,'P'));
  expect((await service.queryOwn(user,o.id)).status).toBe('processing');
  expect((await db.selectFrom('credit_wallets').select('balance').where('tenant_id','=',user.tenantId).executeTakeFirstOrThrow()).balance).toBe(100);
  expect(await db.selectFrom('credit_ledger').selectAll().execute()).toHaveLength(0);
 });
 it('atomically grants once with duplicate concurrent notifications and queries',async()=>{
  const o=await create(500);await processing(o.id);const data=await transaction(o.id);const content=JSON.stringify({...data,trans_type:'T_JSAPI'});
  gateway.call.mockImplementation(async action=>action==='verify'?{verified:true}:data);
  const responses=await Promise.all([service.notify({resp_data:content,sign:'test-signature'}),service.notify({resp_data:content,sign:'test-signature'})]);expect(responses[0]).toBe(`RECV_ORD_ID_${data.req_seq_id}`);
  expect(await db.selectFrom('credit_payment_notifications').selectAll().execute()).toHaveLength(1);
  // Notification acknowledgment alone never changes credits.
  expect((await db.selectFrom('credit_wallets').select('balance').where('tenant_id','=',user.tenantId).executeTakeFirstOrThrow()).balance).toBe(100);
  await Promise.all([service.queryOwn(user,o.id),service.queryOwn(user,o.id)]);await service.queryOwn(user,o.id);
  const wallet=await db.selectFrom('credit_wallets').selectAll().where('tenant_id','=',user.tenantId).executeTakeFirstOrThrow();expect(wallet.balance).toBe(600);expect(wallet.reserved).toBe(20);
  expect(await db.selectFrom('credit_ledger').selectAll().execute()).toHaveLength(1);expect((await service.owned(user,o.id)).status).toBe('paid');
 });
 it('rejects a signed but mismatched amount without ledger changes',async()=>{
  const o=await create();await processing(o.id);gateway.call.mockResolvedValue({...await transaction(o.id),trans_amt:'0.01'});
  await expect(service.queryOwn(user,o.id)).rejects.toThrow('不匹配');expect(await db.selectFrom('credit_ledger').selectAll().execute()).toHaveLength(0);expect((await service.owned(user,o.id)).status).toBe('processing');
 });
 it('rejects unverifiable notifications before persisting or acknowledging',async()=>{
  const o=await create();await processing(o.id);gateway.call.mockRejectedValue(new Error('signature failed'));await expect(service.notify({resp_data:JSON.stringify(await transaction(o.id)),sign:'tampered'})).rejects.toThrow();expect(await db.selectFrom('credit_payment_notifications').selectAll().execute()).toHaveLength(0);
 });
 it('rolls back ledger and order when balance update fails',async()=>{
  const o=await create();await processing(o.id);gateway.call.mockResolvedValue(await transaction(o.id));
  await sql`alter table credit_wallets add constraint test_balance_limit check (balance <= 100)`.execute(db);
  try{await expect(service.queryOwn(user,o.id)).rejects.toThrow();expect(await db.selectFrom('credit_ledger').selectAll().execute()).toHaveLength(0);expect((await service.owned(user,o.id)).status).toBe('processing');}
  finally{await sql`alter table credit_wallets drop constraint test_balance_limit`.execute(db);}
 });
 it('does not repeat remote pay after an ambiguous timeout',async()=>{
  const o=await create();const t=token(o);gateway.call.mockRejectedValueOnce(new Error('network timeout'));
  await expect(service.pay(t,payer(o.id))).rejects.toThrow('timeout');expect((await service.owned(user,o.id)).status).toBe('processing');
  gateway.call.mockResolvedValue(await transaction(o.id,'P'));await expect(service.pay(t,payer(o.id))).rejects.toThrow('勿重复付款');
  expect(gateway.call.mock.calls.filter(([action])=>action==='pay')).toHaveLength(1);
 });
 it('binds cached prepay info to original payer and retains authorization on query',async()=>{
  const o=await create();const t=token(o);gateway.call.mockResolvedValue(await transaction(o.id,'P'));
  expect((await service.pay(t,payer(o.id))).payInfo).toEqual(info);
  expect((await service.queryCheckout(t,payer(o.id))).authorized).toBe(true);
  await expect(service.pay(t,payer(o.id,'different-payer'))).rejects.toThrow('另一个微信账号');
  expect((await service.pay(t,payer(o.id))).payInfo).toEqual(info);expect(gateway.call.mock.calls.filter(([action])=>action==='pay')).toHaveLength(1);
 });
 it('rejects expired payment but reconciles an already-started late success',async()=>{
  const o=await create();await db.updateTable('credit_purchase_orders').set({expires_at:new Date(0)}).where('id','=',o.id).execute();await expect(service.pay(token(o),payer(o.id))).rejects.toThrow('过期');
  await processing(o.id);gateway.call.mockResolvedValue(await transaction(o.id));expect((await service.queryOwn(user,o.id)).status).toBe('paid');
 });
 it('treats failed query as final failure, but not an order-not-found response',async()=>{
  const o=await create();await processing(o.id);gateway.call.mockResolvedValue({resp_code:'23000001'});expect((await service.queryOwn(user,o.id)).status).toBe('processing');
  await processing(o.id);gateway.call.mockResolvedValue(await transaction(o.id,'F'));expect((await service.queryOwn(user,o.id)).status).toBe('failed');expect(await db.selectFrom('credit_ledger').selectAll().execute()).toHaveLength(0);
 });
 it('refuses unconfigured channels without sending SDK pay',async()=>{
  gateway.readiness.mockReturnValue({ready:false,missing:[]});const o=await create();expect(o.checkoutUrl).toBeNull();expect(o.status).toBe('pending');expect(gateway.call).not.toHaveBeenCalled();
 });
});
