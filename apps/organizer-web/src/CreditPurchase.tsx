import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from './api';

type Pack={count:number;name:string;priceCents:number};
type Payment={ready:boolean;missing:string[]};
type Order={id:string;name:string;count:number;amountCents:number;status:string;expiresAt:string;payment:Payment;checkoutUrl?:string|null;authorized?:boolean};
type Catalog={packs:Pack[];payment:Payment};
const money=(cents:number)=>`¥${(cents/100).toFixed(2)}`;
const stateLabels:Record<string,string>={pending:'待支付',processing:'正在确认支付',paid:'支付成功，额度已到账',failed:'支付失败',expired:'订单已过期'};
function requestKey(){const b=new Uint8Array(16);crypto.getRandomValues(b);b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const s=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
function NotReady({payment}:{payment:Payment}){return !payment.ready?<div className="credit-order-note">支付通道尚未配置完成，暂时不能付款。{payment.missing.join('；')}。</div>:null;}
function Title({title,subtitle}:{title:string;subtitle:string}){return <header className="page-header"><div><h1>{title}</h1><p>{subtitle}</p></div><Link to="/credits" className="link-button">返回额度与账单</Link></header>;}
export function CreditPacks(){
 const[catalog,setCatalog]=useState<Catalog>();const[error,setError]=useState('');
 useEffect(()=>{void api<Catalog>('/credit-purchases/catalog').then(setCatalog).catch(e=>setError((e as Error).message));},[]);
 return <><Title title="补充额度" subtitle="购买后计入统一电子票额度余额"/>{error&&<div className="alert">{error}</div>}{catalog?<><div className="credit-pack-grid">{catalog.packs.map(pack=><article className="card credit-pack-card" key={pack.count}><span className="kicker">{pack.name}</span><h2>{pack.count.toLocaleString()} <small>张电子票</small></h2><strong>{money(pack.priceCents)}</strong><p>额度不设使用期限。支付成功后自动到账。</p><Link className="primary link-button" to={`/credits/order/${pack.count}`}>购买</Link></article>)}</div><NotReady payment={catalog.payment}/></>:!error&&<div className="loading">正在加载额度包…</div>}</>;
}
export function CreditPurchaseHistory(){
 const[orders,setOrders]=useState<Order[]>([]);const[error,setError]=useState('');
 useEffect(()=>{void api<Order[]>('/credit-purchases').then(setOrders).catch(e=>setError((e as Error).message));},[]);
 return <section className="card"><div className="card-head"><h2>额度购买订单</h2><span>最近 50 笔</span></div>{error?<div className="alert">{error}</div>:orders.length?<div className="credit-history"><table><thead><tr><th>额度包</th><th>金额</th><th>状态</th><th/></tr></thead><tbody>{orders.map(o=><tr key={o.id}><td>{o.name} · {o.count.toLocaleString()} 张</td><td>{money(o.amountCents)}</td><td>{stateLabels[o.status]||o.status}</td><td><Link to={`/credits/payment/${o.id}`}>{o.status==='paid'?'查看订单':'查看 / 支付'}</Link></td></tr>)}</tbody></table></div>:<p className="muted">暂无购买订单</p>}</section>;
}
export function CreditOrder({user}:{user:{tenantName:string}}){
 const{packCount}=useParams();const navigate=useNavigate();const[pack,setPack]=useState<Pack>();const[error,setError]=useState('');const[busy,setBusy]=useState(false);const key=useRef(requestKey());
 useEffect(()=>{void api<Catalog>('/credit-purchases/catalog').then(c=>{const p=c.packs.find(v=>String(v.count)===packCount);if(!p)throw new Error('额度包不存在');setPack(p);}).catch(e=>setError((e as Error).message));},[packCount]);
 async function buy(){if(!pack||busy)return;setBusy(true);setError('');try{const order=await api<Order>('/credit-purchases',{method:'POST',body:JSON.stringify({packCount:pack.count,idempotencyKey:key.current})});navigate(`/credits/payment/${order.id}`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <><Title title="订单确认" subtitle="核对额度包与应付金额"/>{error&&<div className="alert">{error}</div>}{pack&&<section className="card credit-order-card"><p className="kicker">CREDIT PACKAGE</p><h2>{pack.name}</h2><dl><div><dt>购买企业</dt><dd>{user.tenantName}</dd></div><div><dt>电子票额度</dt><dd>{pack.count.toLocaleString()} 张</dd></div><div className="credit-order-total"><dt>应付金额</dt><dd>{money(pack.priceCents)}</dd></div></dl><p className="credit-order-note">点击支付后生成订单，在微信中扫码付款。只有支付平台确认成功后才会增加额度。</p><button className="primary" disabled={busy} onClick={()=>void buy()}>{busy?'创建订单中…':'支付'}</button></section>}</>;
}
export function CreditPayment(){
 const{orderId}=useParams();const[order,setOrder]=useState<Order>();const[qr,setQr]=useState('');const[error,setError]=useState('');const[busy,setBusy]=useState(false);
 useEffect(()=>{let alive=true;void api<Order>(`/credit-purchases/${orderId}`).then(o=>{if(alive)setOrder(o);}).catch(e=>{if(alive)setError((e as Error).message);});return()=>{alive=false;};},[orderId]);
 useEffect(()=>{let alive=true;setQr('');if(order?.checkoutUrl)void QRCode.toDataURL(order.checkoutUrl,{width:280,margin:2,errorCorrectionLevel:'M'}).then(v=>{if(alive)setQr(v);}).catch(()=>{if(alive)setError('支付二维码生成失败');});return()=>{alive=false;};},[order?.checkoutUrl]);
 async function query(){if(busy||!order?.payment.ready)return;setBusy(true);try{setOrder(await api<Order>(`/credit-purchases/${orderId}/query`,{method:'POST'}));setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 // Status queries never create a payment; the phone initiates it with the payer's authorization.
 useEffect(()=>{if(order?.status!=='pending'&&order?.status!=='processing')return;if(!order.payment.ready)return;const timer=setInterval(()=>void query(),10000);return()=>clearInterval(timer);},[order?.status,order?.payment.ready,orderId,busy]);
 return <><Title title="微信扫码支付" subtitle="汇付斗拱 · 微信 JSAPI"/>{error&&<div className="alert">{error}</div>}{order&&<section className="card credit-payment-card"><h2>{order.name} · {order.count.toLocaleString()} 张</h2><strong className="credit-pay-amount">{money(order.amountCents)}</strong><p>{stateLabels[order.status]||order.status}</p><p className="credit-order-id">订单号：{order.id.replaceAll('-','')}</p><NotReady payment={order.payment}/>{order.status==='paid'?<Link className="primary link-button" to="/credits">查看额度</Link>:['pending','processing'].includes(order.status)&&order.payment.ready?<>{qr&&<img className="credit-pay-qr" src={qr} alt="微信扫码支付额度包"/>}<p>请使用微信扫码，在手机上核对金额并付款。</p><button disabled={busy} onClick={()=>void query()}>{busy?'正在确认…':'我已支付，查询结果'}</button></>:<Link to="/credits/packs">重新选择额度包</Link>}</section>}</>;
}

// This public page grants access only to one signed credit order, never tenant data.
async function checkoutApi<T>(token:string,path='',method='GET'):Promise<T>{
 const response=await fetch(`/api/v1/credit-checkout${path}`,{method,credentials:'same-origin',headers:{'x-checkout-token':token}});
 const data=await response.json();if(!response.ok)throw new Error(data.message||'支付请求失败');return data as T;
}
type PayInfo={appId:string;timeStamp:string;nonceStr:string;package:string;signType:string;paySign:string};
type WeixinWindow=Window&{WeixinJSBridge?:{invoke:(method:string,params:PayInfo,callback:(result:{err_msg:string})=>void)=>void}};
function invokeWechat(params:PayInfo):Promise<string>{return new Promise((resolve,reject)=>{
 let timeout:ReturnType<typeof setTimeout>;
 function ready(){clearTimeout(timeout);document.removeEventListener('WeixinJSBridgeReady',ready);const bridge=(window as WeixinWindow).WeixinJSBridge;if(!bridge){reject(new Error('请使用微信打开支付页面'));return;}bridge.invoke('getBrandWCPayRequest',params,result=>resolve(result.err_msg));}
 if((window as WeixinWindow).WeixinJSBridge){ready();return;}
 document.addEventListener('WeixinJSBridgeReady',ready,{once:true});timeout=setTimeout(()=>{document.removeEventListener('WeixinJSBridgeReady',ready);reject(new Error('无法唤起微信支付，请在微信中重新打开'));},8000);
});}
export function CreditCheckout(){
 const token=new URLSearchParams(window.location.search).get('token')||'';const[order,setOrder]=useState<Order>();const[error,setError]=useState('');const[busy,setBusy]=useState(false);const wechat=/MicroMessenger/i.test(navigator.userAgent);
 useEffect(()=>{document.title='电子票额度包支付 · EventVivid';let alive=true;void checkoutApi<Order>(token).then(o=>{if(alive)setOrder(o);}).catch(e=>{if(alive)setError((e as Error).message);});return()=>{alive=false;};},[token]);
 async function query(){setBusy(true);try{setOrder(await checkoutApi<Order>(token,'/query','POST'));setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function pay(){if(busy)return;setBusy(true);setError('');try{
   if(!wechat)throw new Error('请使用微信扫码打开此页面付款');
   if(!order?.authorized){const result=await checkoutApi<{url:string}>(token,'/oauth','POST');window.location.assign(result.url);return;}
   const result=await checkoutApi<{payInfo?:PayInfo;paid?:boolean}>(token,'/pay','POST');
   if(result.payInfo){const status=await invokeWechat(result.payInfo);if(status.endsWith(':cancel'))setError('已取消付款，可以继续支付');else if(!status.endsWith(':ok'))setError('付款未完成，请查询订单状态');}
   const current=await checkoutApi<Order>(token,'/query','POST');setOrder(current);
   if(current.status==='processing')setError('支付结果正在确认，请稍后查询，勿重复付款。');
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <main className="credit-mobile-checkout"><section className="card"><p className="kicker">EVENTVIVID · 电子票额度</p><h1>{order?.status==='paid'?'支付成功':'订单付款'}</h1>{order&&<><h2>{order.name}</h2><p>{order.count.toLocaleString()} 张电子票额度</p><strong className="credit-pay-amount">{money(order.amountCents)}</strong><p>{stateLabels[order.status]||order.status}</p><NotReady payment={order.payment}/></>}{error&&<div className="alert">{error}</div>}{order?.payment.ready&&['pending','processing'].includes(order.status)&&<><button className="primary" disabled={busy||!wechat} onClick={()=>void pay()}>{busy?'处理中…':order.authorized?'微信支付':'微信授权并支付'}</button><button disabled={busy} onClick={()=>void query()}>查询支付结果</button>{!wechat&&<p>请使用微信扫码打开此页面。</p>}</>}{order?.status==='paid'&&<p>额度已计入购买企业账户，请返回 PC 活动平台查看。</p>}<p className="muted">请核对商品与金额。支付结果以服务端确认结果为准。</p></section></main>;
}
