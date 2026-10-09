import { describe, expect, it } from 'vitest';
import { createPublicKey } from 'node:crypto';
import { centsToYuan,createPurchaseSchema,creditPacks,payInfoSchema,shanghaiDate,validateTransaction,yuanToCents } from './credit-payment.rules';
import { huifuPublicKey,providerPublicKey } from './public-keys';
import { HuifuGateway } from './huifu.gateway';
const order={req_seq_id:'order-1',req_date:'20260930',amount_cents:9900,huifu_id:'merchant-1'};
const paid={req_seq_id:'order-1',req_date:'20260930',trans_amt:'99.00',huifu_id:'merchant-1',trade_type:'T_JSAPI',trans_stat:'S',hf_seq_id:'huifu-1'};
describe('credit payment boundary rules',()=>{
 it('validates both supplied RSA public keys',()=>{for(const raw of [huifuPublicKey,providerPublicKey]){const key=createPublicKey({key:Buffer.from(raw,'base64'),format:'der',type:'spki'});expect(key.asymmetricKeyType).toBe('rsa');expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);}});
 it('only sells approved packs, rejecting client prices',()=>{expect(creditPacks.map(p=>p.count)).toEqual([100,500,2000]);expect(()=>createPurchaseSchema.parse({packCount:1,idempotencyKey:'x'})).toThrow();expect(()=>createPurchaseSchema.parse({packCount:100,idempotencyKey:'00000000-0000-4000-8000-000000000001',amountCents:1})).toThrow();});
 it('does not use floating point for currency',()=>{expect(centsToYuan(9900)).toBe('99.00');expect(centsToYuan(139900)).toBe('1399.00');expect(yuanToCents('1399.00')).toBe(139900);for(const value of ['9.999','NaN','-1.00',99,'99','9e2'])expect(()=>yuanToCents(value)).toThrow();});
 it('accepts a matching successful transaction',()=>expect(()=>validateTransaction(paid,order)).not.toThrow());
 it.each(['huifu_id','req_seq_id','req_date','trans_amt','trade_type','hf_seq_id'])('rejects a mismatched %s',field=>expect(()=>validateTransaction({...paid,[field]:field==='trans_amt'?'0.01':''},order)).toThrow());
 it('uses trans_type for notifications, never guesses a missing type',()=>{expect(()=>validateTransaction({...paid,trade_type:undefined,trans_type:'T_JSAPI'},order,true)).not.toThrow();expect(()=>validateTransaction(paid,order,true)).toThrow();});
 it('keeps accepted/processing distinct from paid',()=>{expect(()=>validateTransaction({...paid,trans_stat:'P',hf_seq_id:undefined},order)).not.toThrow();expect(()=>validateTransaction({...paid,trans_stat:'UNKNOWN'},order)).toThrow();});
 it('formats request dates in China timezone across midnight',()=>{const now=new Date('2026-09-29T16:30:00Z');expect(shanghaiDate(now)).toBe('20260930');expect(shanghaiDate(now,true)).toBe('20260930003000');});
 it('only sends recognised WeChat bridge fields',()=>{const fields={appId:'wx-test',timeStamp:'123',nonceStr:'nonce',package:'prepay_id=test',signType:'RSA',paySign:'signed'};expect(payInfoSchema.parse({...fields,payerHash:'secret',openid:'secret'})).toEqual(fields);expect(()=>payInfoSchema.parse({...fields,package:'arbitrary'})).toThrow();});
 it('never enables payment based solely on public keys',()=>{const g=new HuifuGateway();expect(g.readiness().ready).toBe(false);expect(()=>g.assertReady()).toThrow();});
});
