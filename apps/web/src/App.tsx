import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { api, idempotencyKey } from './api';

type EventItem = { id: string; title: string; slug: string; venue: string; starts_at: string; status: string; capacity: number; sold_count: number };
type RegistrationField={id:string;key:string;label:string;type:'text'|'mobile'|'email'|'number'|'select'|'textarea';required:boolean;enabled:boolean;placeholder?:string;options?:string[]};
type PublicEvent = EventItem & { description: string; preview?:boolean; registration_form:RegistrationField[]; ticketTypes: Array<{ id: string; name: string; price_cents: number; capacity: number; sold_count: number }> };

function Shell({ children }: { children: ReactNode }) {
  return <div className="app-shell">
    <aside>
      <Link to="/" className="brand"><span className="brand-mark">EV</span><span>EventVivid<small>活动运营 SaaS</small></span></Link>
      <nav>
        <a href="http://localhost:5174">总部后台</a><NavLink to="/organizer">活动管理</NavLink>
        <NavLink to="/e/demo-event">参会人报名</NavLink><NavLink to="/checkin">现场验签</NavLink>
      </nav>
      <div className="tenant"><span className="status-dot" />EventVivid 示例企业<small>开发环境</small></div>
    </aside>
    <main>{children}</main>
  </div>;
}

function Home() {
  return <Shell><header><p className="eyebrow">EVENT OPERATIONS, REIMAGINED</p><h1>每一场相聚，<br/><em>都鲜活发生。</em></h1><p className="lede">从发布、报名和收款，到出票与现场验签，EventVivid 让活动团队在一套系统里完成全流程运营。</p></header>
    <section className="portal-grid">
      {[
        {to:'/hq',title:'总部后台',desc:'管理租户、套餐、渠道和平台健康度',no:'01'}, {to:'/organizer',title:'活动管理平台',desc:'创建活动、配置票种、查看报名与交易',no:'02'},
        {to:'/e/demo-event',title:'参会人报名页',desc:'移动优先的报名、支付与电子票体验',no:'03'}, {to:'/checkin',title:'工作人员验签',desc:'快速核验、重复拦截与现场统计',no:'04'},
      ].map(({to,title,desc,no}) => <Link className="portal-card" to={to} key={to}><b>{no}</b><h2>{title}</h2><p>{desc}</p><span>进入 →</span></Link>)}
    </section>
  </Shell>;
}

function HqRedirect() { useEffect(() => { window.location.replace('http://localhost:5174'); }, []); return <Empty text="正在进入独立的总部运营中心…"/>; }

function Organizer() {
  const [events, setEvents] = useState<EventItem[]>([]); const [message, setMessage] = useState('');
  const load = () => api<EventItem[]>('/events').then(setEvents).catch((e: Error) => setMessage(e.message));
  useEffect(() => { void load(); }, []);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const formElement = e.currentTarget; const form = new FormData(formElement); setMessage('');
    try {
      const event = await api<EventItem>('/events', { method: 'POST', body: JSON.stringify({ title: form.get('title'), slug: form.get('slug'), venue: form.get('venue'), description: form.get('description'), startsAt: form.get('startsAt'), endsAt: form.get('endsAt') }) });
      await api(`/events/${event.id}/ticket-types`, { method: 'POST', body: JSON.stringify({ name: '标准票', priceCents: Number(form.get('price')) * 100, capacity: Number(form.get('capacity')), saleStartsAt: new Date().toISOString(), saleEndsAt: form.get('startsAt') }) });
      setMessage('活动与标准票已创建，可在列表中发布。'); formElement.reset(); load();
    } catch (error) { setMessage((error as Error).message); }
  }
  async function publish(id: string) { try { await api(`/events/${id}/publish`, { method: 'POST' }); setMessage('活动已发布。'); load(); } catch (e) { setMessage((e as Error).message); } }
  return <Shell><PageTitle kicker="ORGANIZER WORKSPACE" title="活动管理平台" subtitle="创建活动、配置票种并发布报名页面" />
    {message && <div className="notice">{message}</div>}
    <div className="two-col"><section className="panel"><div className="panel-title"><div><span>快速创建</span><h2>新活动</h2></div></div><form onSubmit={create} className="form-grid">
      <label>活动名称<input name="title" required placeholder="2026 产品创新大会"/></label><label>短链接<input name="slug" required pattern="[a-z0-9-]{3,60}" placeholder="product-day-2026"/></label>
      <label className="span-2">活动地点<input name="venue" required placeholder="上海 · 西岸艺术中心"/></label><label>开始时间<input name="startsAt" type="datetime-local" required/></label><label>结束时间<input name="endsAt" type="datetime-local" required/></label>
      <label>标准票价格（元）<input name="price" type="number" min="0" defaultValue="0" required/></label><label>库存<input name="capacity" type="number" min="1" defaultValue="100" required/></label>
      <label className="span-2">活动简介<textarea name="description" rows={3} placeholder="用一句话描述活动亮点"/></label><button className="primary span-2">创建活动与票种</button>
    </form></section>
    <section className="panel"><div className="panel-title"><div><span>活动资产</span><h2>最近活动</h2></div><b>{events.length}</b></div><div className="event-list">{events.length === 0 ? <Empty text="还没有活动，先创建第一场吧。"/> : events.map(event => <article key={event.id}><div><span className={`pill ${event.status === 'published' ? 'success' : ''}`}>{event.status}</span><h3>{event.title}</h3><p>{event.venue} · {new Date(event.starts_at).toLocaleString()}</p><small>售出 {event.sold_count}/{event.capacity}</small></div><div className="actions">{event.status === 'draft' && <button onClick={() => publish(event.id)}>发布</button>}<Link to={`/e/${event.slug}`}>报名页</Link></div></article>)}</div></section></div>
  </Shell>;
}

function Attendee() {
  const { slug = '' } = useParams();const[searchParams]=useSearchParams();const previewToken=searchParams.get('preview')??''; const [event, setEvent] = useState<PublicEvent>(); const [error, setError] = useState(''); const [result, setResult] = useState<{ orderId: string; orderNo: string; amountCents: number; ticket?: { code: string } }>();
  useEffect(() => { const path=previewToken?`/public/events/${slug}/preview?token=${encodeURIComponent(previewToken)}`:`/public/events/${slug}`;api<PublicEvent>(path).then(setEvent).catch((e: Error) => setError(e.message)); }, [slug,previewToken]);
  async function submit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); if (!event||event.preview) return; const form = new FormData(e.currentTarget); const fields=(event.registration_form??[]).filter(field=>field.enabled);const formData=Object.fromEntries(fields.map(field=>[field.key,String(form.get(`field_${field.key}`)??'')]));setError(''); try { const order = await api<{orderId:string;orderNo:string;amountCents:number}>(`/public/events/${slug}/registrations`, { method:'POST', headers:{'idempotency-key':idempotencyKey()}, body:JSON.stringify({ticketTypeId:form.get('ticketTypeId'),attendeeName:formData.name,attendeeMobile:formData.mobile,attendeeEmail:formData.email??'',formData}) }); const paid = await api<{ticket:{code:string}}>(`/orders/${order.orderId}/payments/confirm`, {method:'POST',headers:{'idempotency-key':idempotencyKey()}}); setResult({...order,ticket:paid.ticket}); } catch (e) { setError((e as Error).message); } }
  if (error && !event) return <MobileFrame><Empty text={error}/></MobileFrame>;
  if (!event) return <MobileFrame><Empty text="正在加载活动…"/></MobileFrame>;
  if (result?.ticket) return <MobileFrame><div className="ticket-success"><span>✓</span><p>报名成功</p><h1>{event.title}</h1><div className="ticket-code"><small>电子票码</small><b>{result.ticket.code}</b></div><p>请妥善保存，入场时向工作人员出示。</p><Link to={`/ticket/${result.ticket.code}`} className="primary button-link">查看电子票</Link></div></MobileFrame>;
  return <MobileFrame>{event.preview&&<div className="preview-banner"><b>预览模式</b><span>此页面仅用于检查展示效果，不会提交报名。</span></div>}<div className="event-hero"><p className="eyebrow">EVENTVIVID PRESENTS</p><h1>{event.title}</h1><p>{event.description}</p><div><b>{new Date(event.starts_at).toLocaleString()}</b><span>{event.venue}</span></div></div><form className="registration-card" onSubmit={submit}><h2>立即报名</h2><label>选择票种<select name="ticketTypeId">{event.ticketTypes.map(t => <option value={t.id} key={t.id}>{t.name} · {t.price_cents === 0 ? '免费' : `¥${t.price_cents/100}`} · 剩余 {t.capacity-t.sold_count}</option>)}</select></label>{(event.registration_form??[]).filter(field=>field.enabled).map(field=><label key={field.id}>{field.label}{!field.required&&<small>（选填）</small>}{field.type==='textarea'?<textarea name={`field_${field.key}`} required={field.required} rows={3} placeholder={field.placeholder}/>:field.type==='select'?<select name={`field_${field.key}`} required={field.required}><option value="">{field.placeholder||'请选择'}</option>{field.options?.map(option=><option value={option} key={option}>{option}</option>)}</select>:<input name={`field_${field.key}`} required={field.required} type={field.type==='email'?'email':field.type==='number'?'number':field.type==='mobile'?'tel':'text'} pattern={field.type==='mobile'?'1\\d{10}':undefined} placeholder={field.placeholder}/>}</label>)}{error && <div className="notice error">{error}</div>}<button className="primary" disabled={event.preview}>{event.preview?'预览模式不可提交':'确认报名'}</button><small>{event.preview?'关闭预览后返回活动平台继续配置。':'提交即表示同意活动报名服务协议和隐私政策。'}</small></form></MobileFrame>;
}

function TicketPage() { const { code='' } = useParams(); const [ticket,setTicket]=useState<Record<string,string>>(); const [error,setError]=useState(''); useEffect(()=>{api<Record<string,string>>(`/public/tickets/${code}`).then(setTicket).catch((e:Error)=>setError(e.message));},[code]); return <MobileFrame>{ticket ? <div className="digital-ticket"><p className="eyebrow">ADMISSION TICKET</p><h1>{ticket.title}</h1><div className="fake-qr">{ticket.code?.slice(-8)}</div><b>{ticket.code}</b><dl><div><dt>参会人</dt><dd>{ticket.attendee_name}</dd></div><div><dt>地点</dt><dd>{ticket.venue}</dd></div><div><dt>状态</dt><dd>{ticket.status}</dd></div></dl></div> : <Empty text={error||'正在获取电子票…'}/>}</MobileFrame>; }

function Checkin() {
  const [code,setCode]=useState(''); const [eventId,setEventId]=useState(''); const [pointId,setPointId]=useState(''); const [result,setResult]=useState<{message:string;result:string}>(); const [message,setMessage]=useState('');
  async function loadPoints() { try { const points=await api<Array<{id:string;name:string}>>(`/checkins/points/${eventId}`); if(points[0]){setPointId(points[0].id);setMessage(`已选择验签点：${points[0].name}`);} else setMessage('该活动尚无验签点，请先发布活动。'); } catch(e){setMessage((e as Error).message);} }
  async function scan(e:FormEvent){e.preventDefault();try{setResult(await api('/checkins/scan',{method:'POST',headers:{'idempotency-key':idempotencyKey()},body:JSON.stringify({code,checkinPointId:pointId})}));}catch(e){setResult({result:'invalid',message:(e as Error).message});}}
  return <Shell><PageTitle kicker="VENUE OPERATIONS" title="现场验签" subtitle="输入或扫描电子票码，实时拦截无效票与重复票"/><div className="checkin-layout"><section className="scanner"><div className="scan-corners"><span>将二维码置于框内</span><i/></div><form onSubmit={scan}><input value={code} onChange={e=>setCode(e.target.value)} placeholder="输入电子票码" required/><button className="primary" disabled={!pointId}>核验票券</button></form></section><section className="panel checkin-side"><h2>验签工作台</h2><label>活动 ID<input value={eventId} onChange={e=>setEventId(e.target.value)} placeholder="从活动管理列表复制"/></label><button onClick={loadPoints}>加载验签点</button>{message&&<p className="muted">{message}</p>}{result&&<div className={`result ${result.result}`}><b>{result.result==='success'?'✓':'!'}</b><h3>{result.message}</h3><p>{code}</p></div>}<div className="tips"><b>操作提示</b><p>连续验签支持幂等保护；重复票会显示警告，且不会改变首次入场记录。</p></div></section></div></Shell>;
}

function PageTitle({kicker,title,subtitle}:{kicker:string;title:string;subtitle:string}){return <div className="page-title"><div><p className="eyebrow">{kicker}</p><h1>{title}</h1><p>{subtitle}</p></div><div className="avatar">管</div></div>}
function Metric({value,label,trend}:{value:string;label:string;trend:string}){return <article className="metric"><span>{label}</span><strong>{value}</strong><small>{trend}</small></article>}
function Empty({text}:{text:string}){return <div className="empty"><span>EV</span><p>{text}</p></div>}
function MobileFrame({children}:{children:ReactNode}){return <div className="mobile-bg"><Link to="/" className="mobile-brand">EventVivid</Link><div className="mobile-frame">{children}</div></div>}

export function App(){return <Routes><Route path="/" element={<Home/>}/><Route path="/hq" element={<HqRedirect/>}/><Route path="/organizer" element={<Organizer/>}/><Route path="/e/:slug" element={<Attendee/>}/><Route path="/ticket/:code" element={<TicketPage/>}/><Route path="/checkin" element={<Checkin/>}/></Routes>}
