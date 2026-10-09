import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Kysely, Selectable } from 'kysely';
import { DATABASE } from '../database/database.module';
import type { CreditPurchaseOrderTable, Database } from '../database/schema';
import { DomainError } from '../shared/domain-error.filter';
import type { TenantPrincipal } from '../tenant-auth/tenant-auth.guard';
import { HuifuGateway } from './huifu.gateway';
import { centsToYuan, createPurchaseSchema, creditPacks, payInfoSchema, shanghaiDate, validateTransaction } from './credit-payment.rules';

type Order = Selectable<CreditPurchaseOrderTable>;
const hash = (value:string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class CreditPaymentsService implements OnModuleInit,OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  private readonly logger = new Logger(CreditPaymentsService.name);
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>,private readonly gateway:HuifuGateway) {}
  onModuleInit() {
    // A missing configuration never makes an outbound payment request.
    if(this.gateway.readiness(false).ready){this.timer=setInterval(()=>void this.reconcile(),30000);this.timer.unref();}
  }
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  catalog(){return {packs:creditPacks,payment:this.gateway.readiness()};}
  private admin(user:TenantPrincipal){if(user.role!=='tenant_admin')throw new DomainError('仅租户管理员可购买电子票额度',403);}
  private token(id:string,purpose='credit-checkout',extra:Record<string,string>={}) {
    if(this.gateway.checkoutSecret.length<32)throw new DomainError('支付链接尚未配置，请联系客服',503);
    return jwt.sign({purpose,...extra},this.gateway.checkoutSecret,{algorithm:'HS256',subject:id,expiresIn:purpose==='credit-payer'?'30m':'24h',audience:'eventvivid-credit-payment',issuer:'eventvivid-api'});
  }
  private claims(token:string,purpose:string) {
    try {const claims=jwt.verify(token,this.gateway.checkoutSecret,{algorithms:['HS256'],audience:'eventvivid-credit-payment',issuer:'eventvivid-api'}) as jwt.JwtPayload;if(claims.purpose!==purpose||typeof claims.sub!=='string')throw new Error();return claims;}
    catch{throw new DomainError('支付链接或微信授权已失效，请重新打开订单',401);}
  }
  private publicOrder(order:Order) {
    const expired = order.status==='pending' && new Date(order.expires_at).getTime()<=Date.now();
    return {id:order.id,name:order.pack_name,count:order.pack_count,amountCents:order.amount_cents,status:expired?'expired':order.status,expiresAt:order.expires_at,paidAt:order.paid_at,payment:this.gateway.readiness()};
  }
  private async getOrder(id:string) {z.string().uuid('订单编号不正确').parse(id);const o=await this.db.selectFrom('credit_purchase_orders').selectAll().where('id','=',id).executeTakeFirst();if(!o)throw new DomainError('购买订单不存在',404);return o;}
  async create(user:TenantPrincipal,body:unknown) {
    this.admin(user);const input=createPurchaseSchema.parse(body);const pack=creditPacks.find(p=>p.count===input.packCount)!;
    // Orders can be reviewed with payments disabled; no credits or real payments are created here.
    const id=randomUUID();const now=new Date();
    await this.db.insertInto('credit_purchase_orders').values({id,tenant_id:user.tenantId,created_by:user.id,idempotency_key:input.idempotencyKey,pack_count:pack.count,pack_name:pack.name,amount_cents:pack.priceCents,status:'pending',req_date:shanghaiDate(now),req_seq_id:id.replaceAll('-',''),huifu_id:this.gateway.huifuId,app_id:this.gateway.appId,hf_seq_id:null,pay_info:null,payment_started_at:null,last_queried_at:null,paid_at:null,expires_at:new Date(now.getTime()+30*60000)}).onConflict(c=>c.columns(['tenant_id','idempotency_key']).doNothing()).execute();
    const order=await this.db.selectFrom('credit_purchase_orders').selectAll().where('tenant_id','=',user.tenantId).where('idempotency_key','=',input.idempotencyKey).executeTakeFirstOrThrow();
    if(order.pack_count!==input.packCount)throw new DomainError('重复请求与原额度包不一致',409);
    return this.owned(user,order.id);
  }
  async list(user:TenantPrincipal) {return (await this.db.selectFrom('credit_purchase_orders').selectAll().where('tenant_id','=',user.tenantId).orderBy('created_at','desc').limit(50).execute()).map(o=>this.publicOrder(o));}
  async owned(user:TenantPrincipal,id:string) {
    z.string().uuid('订单编号不正确').parse(id);
    const order=await this.db.selectFrom('credit_purchase_orders').selectAll().where('id','=',id).where('tenant_id','=',user.tenantId).executeTakeFirst();
    if(!order)throw new DomainError('购买订单不存在',404);
    let checkoutUrl:string|null=null;
    if(this.gateway.readiness().ready) checkoutUrl=`${this.gateway.webOrigin}/credit-checkout?token=${encodeURIComponent(this.token(order.id))}`;
    return {...this.publicOrder(order),checkoutUrl};
  }
  async checkout(token:string,payerToken?:string) {
    const order=await this.getOrder(this.claims(token,'credit-checkout').sub!);
    let authorized=false;
    if(payerToken)try{const payer=this.claims(payerToken,'credit-payer');authorized=payer.sub===order.id&&payer.appId===order.app_id;}catch{}
    return {...this.publicOrder(order),authorized};
  }
  async oauthStart(token:string) {
    this.gateway.assertReady();const order=await this.getOrder(this.claims(token,'credit-checkout').sub!);this.assertPayable(order);
    const state=randomBytes(24).toString('hex');
    await this.db.deleteFrom('credit_payment_oauth_states').where('expires_at','<',new Date()).execute();
    await this.db.insertInto('credit_payment_oauth_states').values({state_hash:hash(state),order_id:order.id,expires_at:new Date(Date.now()+5*60000)}).execute();
    const params=new URLSearchParams({appid:this.gateway.appId,redirect_uri:`${this.gateway.apiOrigin}/api/v1/credit-checkout/oauth/callback`,response_type:'code',scope:'snsapi_base',state});
    return `https://open.weixin.qq.com/connect/oauth2/authorize?${params}#wechat_redirect`;
  }
  async oauthCallback(code:string,state:string) {
    this.gateway.assertReady();if(!code||code.length>256||!/^[a-f\d]{48}$/.test(state))throw new DomainError('微信授权参数不正确');
    const stored=await this.db.deleteFrom('credit_payment_oauth_states').where('state_hash','=',hash(state)).where('expires_at','>',new Date()).returning('order_id').executeTakeFirst();
    if(!stored)throw new DomainError('微信授权已过期或已使用');
    const order=await this.getOrder(stored.order_id);this.assertPayable(order);
    const params=new URLSearchParams({appid:this.gateway.appId,secret:process.env.HUIFU_WECHAT_APP_SECRET!,code,grant_type:'authorization_code'});
    let result: {openid?:string;errcode?:number};
    try {const response=await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${params}`,{signal:AbortSignal.timeout(8000),redirect:'error'});if(!response.ok)throw new Error();result=await response.json() as typeof result;}
    catch{throw new DomainError('微信授权暂时不可用，请重新授权',502);}
    if(!result.openid||result.errcode)throw new DomainError('微信授权失败，请重新授权');
    return {cookie:this.token(order.id,'credit-payer',{openid:result.openid,appId:order.app_id}),url:`${this.gateway.webOrigin}/credit-checkout?token=${encodeURIComponent(this.token(order.id))}`};
  }
  private assertPayable(order:Order) {
    if(order.status!=='pending'&&order.status!=='processing')throw new DomainError('该订单不能继续付款');
    if(new Date(order.expires_at).getTime()<=Date.now())throw new DomainError('订单已过期，请重新购买');
    if(order.app_id!==this.gateway.appId||order.huifu_id!==this.gateway.huifuId)throw new DomainError('支付配置已变更，请重新创建订单');
  }
  async pay(token:string,payerToken:string) {
    this.gateway.assertReady();const id=this.claims(token,'credit-checkout').sub!;const payer=this.claims(payerToken,'credit-payer');
    const order=await this.db.transaction().execute(async trx=>{
      const o=await trx.selectFrom('credit_purchase_orders').selectAll().where('id','=',id).forUpdate().executeTakeFirstOrThrow();this.assertPayable(o);
      if(payer.sub!==o.id||payer.appId!==o.app_id||typeof payer.openid!=='string')throw new DomainError('请先完成本订单的微信授权',401);
      if(o.payment_started_at)return {...o,alreadyStarted:true};
      const startedAt=new Date();const reqDate=shanghaiDate(startedAt);
      await trx.updateTable('credit_purchase_orders').set({status:'processing',payment_started_at:startedAt,req_date:reqDate}).where('id','=',id).execute();
      return {...o,req_date:reqDate,alreadyStarted:false};
    });
    if(order.alreadyStarted){
      // Never create another transaction after an ambiguous timeout.
      await this.queryOrder(order.id);
      const current=await this.getOrder(order.id);
      if(current.status==='paid')return {paid:true};
      if(current.pay_info&&current.status==='processing'){
        if((current.pay_info as {payerHash?:string}).payerHash!==hash(payer.openid as string))throw new DomainError('此订单已由另一个微信账号发起支付，请使用原账号付款',409);
        return {payInfo:payInfoSchema.parse(current.pay_info)};
      }
      throw new DomainError('支付正在确认，请稍后查询订单，请勿重复付款',409);
    }
    const data=await this.gateway.call('pay',{reqDate:order.req_date,reqSeqId:order.req_seq_id,amount:centsToYuan(order.amount_cents),description:`EventVivid ${order.pack_name} ${order.pack_count}张电子票额度`,openid:payer.openid,expires:shanghaiDate(new Date(order.expires_at),true)});
    validateTransaction(data,order);
    // A signed accepted response still is NOT proof of payment.
    if(data.trans_stat==='S'){await this.queryOrder(order.id);return {paid:(await this.getOrder(order.id)).status==='paid'};}
    if(data.trans_stat==='F'){await this.queryOrder(order.id);throw new DomainError('微信支付未成功，请查询订单状态');}
    if(!['00000000','00000100'].includes(String(data.resp_code)))throw new DomainError('支付平台未受理，请稍后查询订单',502);
    let raw:unknown;try{raw=typeof data.pay_info==='string'?JSON.parse(data.pay_info):data.pay_info;}catch{throw new DomainError('未取得微信支付参数，请查询订单',502);}
    const payInfo=payInfoSchema.parse(raw);if(payInfo.appId!==order.app_id)throw new DomainError('微信支付 APPID 不匹配',502);
    // Bind payer to the first payment attempt: do not expose another browser's prepay parameters.
    await this.db.updateTable('credit_purchase_orders').set({pay_info:{...payInfo,payerHash:hash(payer.openid)},hf_seq_id:typeof data.hf_seq_id==='string'?data.hf_seq_id:null}).where('id','=',order.id).where('status','=','processing').execute();
    return {payInfo};
  }
  async queryOwn(user:TenantPrincipal,id:string){const o=await this.owned(user,id);await this.queryOrder(o.id);return this.owned(user,id);}
  async queryCheckout(token:string,payerToken?:string){const id=this.claims(token,'credit-checkout').sub!;await this.queryOrder(id);return this.checkout(token,payerToken);}
  private async queryOrder(id:string) {
    this.gateway.assertReady(false);
    const order=await this.db.transaction().execute(async trx=>{
      const o=await trx.selectFrom('credit_purchase_orders').selectAll().where('id','=',id).forUpdate().executeTakeFirstOrThrow();
      if(o.status!=='processing'||new Date(o.next_query_at).getTime()>Date.now())return null;
      if(o.huifu_id!==this.gateway.huifuId||o.app_id!==this.gateway.appId)throw new DomainError('订单支付配置已变更，请联系客服核对',409);
      await trx.updateTable('credit_purchase_orders').set({next_query_at:new Date(Date.now()+15000),last_queried_at:new Date()}).where('id','=',id).execute();return o;
    });
    if(!order)return;
    const data=await this.gateway.call('query',{reqDate:order.req_date,reqSeqId:order.req_seq_id});
    if(data.resp_code!=='00000000')return; // Not found/transport errors are not final failures.
    validateTransaction(data,order);
    if(data.trans_stat==='S')await this.grant(order,data.hf_seq_id as string);
    if(data.trans_stat==='F')await this.db.updateTable('credit_purchase_orders').set({status:'failed',pay_info:null}).where('id','=',id).where('status','=','processing').execute();
  }
  private async grant(order:Order,hfSeqId:string) {
    await this.db.transaction().execute(async trx=>{
      const current=await trx.selectFrom('credit_purchase_orders').selectAll().where('id','=',order.id).forUpdate().executeTakeFirstOrThrow();
      if(current.status==='paid')return;
      if(current.hf_seq_id&&current.hf_seq_id!==hfSeqId)throw new DomainError('支付流水号不匹配',502);
      // Same lock order as issuance: order, then wallet. Unique ledger reference is a second guard.
      const wallet=await trx.selectFrom('credit_wallets').selectAll().where('tenant_id','=',current.tenant_id).forUpdate().executeTakeFirstOrThrow();
      const ledger=await trx.insertInto('credit_ledger').values({id:randomUUID(),tenant_id:current.tenant_id,change:current.pack_count,kind:'purchase',reference:`credit-purchase:${current.id}`,note:`${current.pack_name} ${current.pack_count}张；订单${current.req_seq_id}`}).onConflict(c=>c.columns(['tenant_id','reference']).doNothing()).returning('id').executeTakeFirst();
      if(ledger)await trx.updateTable('credit_wallets').set({balance:wallet.balance+current.pack_count,updated_at:new Date()}).where('tenant_id','=',current.tenant_id).execute();
      await trx.updateTable('credit_purchase_orders').set({status:'paid',paid_at:new Date(),hf_seq_id:hfSeqId,pay_info:null}).where('id','=',current.id).execute();
    });
  }
  async notify(body:unknown) {
    const envelope=body as {resp_data?:unknown;sign?:unknown};
    if(!envelope||typeof envelope.resp_data!=='string'||typeof envelope.sign!=='string'||envelope.resp_data.length>64000||envelope.sign.length>1024)throw new DomainError('无效支付通知');
    // Verify the exact original resp_data string; do not sort or reserialize it.
    await this.gateway.call('verify',{content:envelope.resp_data,signature:envelope.sign});
    let data:Record<string,unknown>;try{data=JSON.parse(envelope.resp_data) as Record<string,unknown>;}catch{throw new DomainError('无效支付通知');}
    const order=await this.db.selectFrom('credit_purchase_orders').selectAll().where('req_seq_id','=',String(data.req_seq_id)).executeTakeFirst();
    if(!order)throw new DomainError('通知订单不存在',404);validateTransaction(data,order,true);
    if(!order.payment_started_at)throw new DomainError('订单尚未发起支付');
    // Persist before acknowledging. The worker independently queries Huifu before granting.
    await this.db.transaction().execute(async trx=>{
      await trx.insertInto('credit_payment_notifications').values({id:hash(envelope.resp_data as string),order_id:order.id}).onConflict(c=>c.column('id').doNothing()).execute();
      await trx.updateTable('credit_purchase_orders').set({next_query_at:new Date()}).where('id','=',order.id).where('status','=','processing').execute();
    });
    return `RECV_ORD_ID_${order.req_seq_id}`;
  }
  private async reconcile() {
    if(this.reconciling)return;this.reconciling=true;
    try{
      const orders=await this.db.selectFrom('credit_purchase_orders').select('id').where('status','=','processing').where('next_query_at','<=',new Date()).orderBy('next_query_at').limit(10).execute();
      for(const o of orders)try{await this.queryOrder(o.id);}catch{this.logger.warn(`Credit payment reconciliation pending: ${o.id}`);}
    }catch{this.logger.warn('Credit payment reconciliation unavailable; check migration/configuration');}finally{this.reconciling=false;}
  }
}
