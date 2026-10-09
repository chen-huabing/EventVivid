import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DomainError } from '../shared/domain-error.filter';
import { huifuPublicKey, providerPublicKey } from './public-keys';

function key(value: string) { return value.includes('-----BEGIN') ? value.replaceAll('\\n', '\n') : `-----BEGIN PUBLIC KEY-----\n${value}\n-----END PUBLIC KEY-----`; }
function httpsOrigin(value: string) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !['localhost','127.0.0.1','::1'].includes(u.hostname) && u.pathname === '/' && !u.search && !u.hash; } catch { return false; }
}

@Injectable()
export class HuifuGateway {
  readonly binary = resolve(process.env.HUIFU_SDK_BINARY || resolve(__dirname, '../../../../tools/huifu-sdk/dist', process.platform === 'win32' ? 'huifu-sdk.exe' : 'huifu-sdk'));
  readonly publicKey = process.env.HUIFU_RSA_PUBLIC_KEY || huifuPublicKey;
  readonly providerKey = process.env.HUIFU_PROVIDER_PUBLIC_KEY || providerPublicKey;
  readonly huifuId = process.env.HUIFU_ID || '6666000245068152';
  readonly appId = process.env.HUIFU_WECHAT_APP_ID || '';
  readonly webOrigin = (process.env.HUIFU_CHECKOUT_ORIGIN || '').replace(/\/$/, '');
  readonly apiOrigin = (process.env.HUIFU_API_ORIGIN || '').replace(/\/$/, '');
  readonly notifyUrl = process.env.HUIFU_NOTIFY_URL || `${this.apiOrigin}/api/v1/credit-checkout/notify`;
  readonly checkoutSecret = process.env.HUIFU_CHECKOUT_SECRET || '';

  private privateKey() {
    const filename = process.env.HUIFU_PRIVATE_KEY_FILE;
    return filename ? readFileSync(resolve(filename), 'utf8') : (process.env.HUIFU_RSA_PRIVATE_KEY || '').replaceAll('\\n', '\n');
  }
  readiness(requireEnabled = true) {
    const missing: string[] = [];
    if (requireEnabled && process.env.HUIFU_PAYMENTS_ENABLED !== 'true') missing.push('支付通道尚未启用');
    if (!existsSync(this.binary)) missing.push('Go SDK 模块尚未编译');
    try {const pub=createPublicKey(key(this.publicKey));if(pub.asymmetricKeyType!=='rsa'||(pub.asymmetricKeyDetails?.modulusLength||0)<2048)throw new Error();}catch{missing.push('汇付 RSA 验签公钥无效');}
    try {
      const raw = this.privateKey();
      const privateKey = createPrivateKey(raw.includes('-----BEGIN') ? raw : {key:Buffer.from(raw,'base64'),format:'der',type:'pkcs8'});
      if(privateKey.asymmetricKeyType!=='rsa'||(privateKey.asymmetricKeyDetails?.modulusLength||0)<2048)throw new Error();
      const actual = createPublicKey(privateKey).export({format:'der',type:'spki'});
      const expected = createPublicKey(key(this.providerKey)).export({format:'der',type:'spki'});
      if (!actual.equals(expected)) missing.push('服务商私钥与公钥不匹配');
    } catch { missing.push('未配置有效的服务商 RSA 私钥'); }
    if (!/^wx[a-z\d]{16}$/i.test(this.appId)) missing.push('未配置微信公众号 APPID');
    if (!process.env.HUIFU_WECHAT_APP_SECRET) missing.push('未配置微信公众号 AppSecret');
    if (!httpsOrigin(this.webOrigin) || !httpsOrigin(this.apiOrigin)) missing.push('未配置公网 HTTPS 支付页和 API 域名');
    if (this.webOrigin !== this.apiOrigin) missing.push('支付页与 API 必须通过同一个 HTTPS 域名提供服务');
    if (this.notifyUrl !== `${this.apiOrigin}/api/v1/credit-checkout/notify`) missing.push('支付通知地址不匹配');
    if (this.checkoutSecret.length < 32 || /replace|example/i.test(this.checkoutSecret)) missing.push('未配置独立的支付链接签名密钥');
    if (!['sandbox','production'].includes(process.env.HUIFU_ENV || '')) missing.push('未选择斗拱测试或生产环境');
    if ((process.env.HUIFU_TRADE_TYPE || 'T_JSAPI') !== 'T_JSAPI') missing.push('当前仅支持微信 JSAPI');
    return { ready: missing.length === 0, missing };
  }
  assertReady(requireEnabled = true) { const status = this.readiness(requireEnabled); if (!status.ready) throw new DomainError(`支付尚未配置完成：${status.missing.join('；')}`,503); }

  async call(action: 'pay' | 'query' | 'verify' | 'preflight', input: Record<string,string> = {}): Promise<Record<string,unknown>> {
    if (action !== 'verify') this.assertReady(action !== 'query');
    if (!existsSync(this.binary)) throw new DomainError('支付验签模块不可用',503);
    // Do not inherit application/database secrets into the SDK process.
    const env: NodeJS.ProcessEnv = {
      PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, TEMP:process.env.TEMP,
      HUIFU_RSA_PUBLIC_KEY:this.publicKey, HUIFU_PROVIDER_PUBLIC_KEY:this.providerKey,
      HUIFU_SYS_ID:process.env.HUIFU_SYS_ID || '6666000244121044', HUIFU_ID:this.huifuId,
      HUIFU_PRODUCT_ID:process.env.HUIFU_PRODUCT_ID || 'XLSISV', HUIFU_ENV:process.env.HUIFU_ENV,
      HUIFU_WECHAT_APP_ID:this.appId, HUIFU_NOTIFY_URL:this.notifyUrl,
      ...(action !== 'verify' ? {HUIFU_RSA_PRIVATE_KEY:this.privateKey()} : {}),
    };
    return new Promise((accept,reject) => {
      const child = spawn(this.binary, [], {env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      child.stdout.setEncoding('utf8');
      let output = ''; let finished = false;
      const fail = () => { if (!finished) { finished = true; child.kill(); reject(new DomainError('支付平台暂时无法确认，请稍后查询订单状态，勿重复付款',502)); } };
      const timeout = setTimeout(fail,16000);
      child.on('error',fail); child.stdin.on('error',fail);
      child.stdout.on('data',(chunk:string)=>{output += chunk; if (Buffer.byteLength(output,'utf8') > 128*1024) fail();});
      // Drain stderr without logging SDK messages or key material.
      child.stderr.on('data',()=>{});
      child.on('close',code=>{clearTimeout(timeout); if (finished) return; finished=true; try {const result=JSON.parse(output) as {data:Record<string,unknown>;error?:string}; if(code!==0||result.error||!result.data)throw new Error();accept(result.data);} catch {reject(new DomainError(action==='verify'?'支付通知验签失败':'支付平台暂时无法确认，请稍后查询订单状态，勿重复付款',action==='verify'?400:502));}});
      child.stdin.end(JSON.stringify({action,...input}));
    });
  }
}
