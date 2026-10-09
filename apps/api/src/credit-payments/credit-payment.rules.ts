import { z } from 'zod';
import { DomainError } from '../shared/domain-error.filter';

// The server is the sole authority for price and credit quantity.
export const creditPacks = [
  {count:100,name:'小额补充包',priceCents:9900},
  {count:500,name:'常用包',priceCents:39900},
  {count:2000,name:'批量包',priceCents:139900},
] as const;
export const createPurchaseSchema = z.object({packCount:z.union([z.literal(100),z.literal(500),z.literal(2000)]),idempotencyKey:z.string().uuid()}).strict();
export const payInfoSchema = z.object({appId:z.string().min(1),timeStamp:z.string().regex(/^\d+$/),nonceStr:z.string().min(1),package:z.string().regex(/^prepay_id=.+$/),signType:z.enum(['RSA','MD5','HMAC-SHA256']),paySign:z.string().min(1)});
export function centsToYuan(cents:number) { return `${Math.floor(cents/100)}.${String(cents%100).padStart(2,'0')}`; }
export function yuanToCents(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw new DomainError('支付金额格式不正确',502);
  const [whole,fraction] = value.split('.'); return Number(whole)*100+Number(fraction);
}
export function validateTransaction(data:Record<string,unknown>,order:{req_seq_id:string;req_date:string;amount_cents:number;huifu_id:string},notification=false) {
  if(data.huifu_id!==order.huifu_id||data.req_seq_id!==order.req_seq_id||data.req_date!==order.req_date||yuanToCents(data.trans_amt)!==order.amount_cents||data[notification?'trans_type':'trade_type']!=='T_JSAPI') throw new DomainError('支付订单信息不匹配，无法入账',502);
  if(!['S','P','F','I'].includes(String(data.trans_stat))) throw new DomainError('未知支付状态',502);
  if(data.trans_stat==='S' && (typeof data.hf_seq_id!=='string'||!data.hf_seq_id)) throw new DomainError('缺少支付流水号',502);
}
export function shanghaiDate(now:Date,withTime=false) {
  const d=new Date(now.getTime()+8*3600_000); const pad=(n:number)=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${withTime?`${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`:''}`;
}
