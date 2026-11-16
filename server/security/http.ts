import {clientCors,allowedClientOrigins} from './client-cors.ts';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDb } from '../persistence/db.ts';
import { requestIdentity,requestTrace } from './context.ts';
import { isSandboxRole } from '../operations/identity.ts';
import { SANDBOX_ROLE_LABELS } from '../../shared/operations-contract.ts';
import {authMode,authenticateNative,withNativeDelegation} from './native-auth.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function reject(res: ServerResponse, status: number, message: string): void {
  if(status===429)res.setHeader('Retry-After','60');
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify({error:status===429?'rate_limited':status===403?'forbidden':status===401?'authentication_required':'identity_unavailable', message,requestId:res.getHeader('X-Request-ID')}));
}
function allowance(bucket: string, limit: number, duration: number): boolean {
  const db = getDb();
  const now = Date.now();
  db.prepare('DELETE FROM request_quota WHERE expiresAt < ?').run(now);
  const row = db.prepare(`INSERT INTO request_quota(bucket,count,expiresAt) VALUES (?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count`).get(bucket, now+duration) as {count:number};
  return row.count <= limit;
}
const limit = (name: string, fallback: number) => Math.max(1, Number(process.env[name]) || fallback);

/** Sandbox identity is a random server-issued browser session, never a public shared role ID. */
export async function withHttpIdentity(req: IncomingMessage, res: ServerResponse, next: () => Promise<void>): Promise<void> {
  if(clientCors(req,res))return;
  const requestId=typeof req.headers['x-request-id']==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(req.headers['x-request-id'])?req.headers['x-request-id']:randomBytes(12).toString('hex');res.setHeader('X-Request-ID',requestId);
  return requestTrace.run(requestId,()=>authenticateRequest(req,res,next));
}
async function authenticateRequest(req:IncomingMessage,res:ServerResponse,next:()=>Promise<void>):Promise<void>{
  if (!req.url?.startsWith('/api/') || req.url.startsWith('/api/health') || req.url.startsWith('/api/agent/health')) return next();
  const origin = req.headers.origin;
  const allowed = [...allowedClientOrigins(), ...(process.env.LABOPS_ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean)];
  if(origin){let host='';try{host=new URL(origin).host;}catch{return reject(res,403,'请求来源无效');}if((host!==req.headers.host||!origin.startsWith((process.env.LABOPS_SECURE_COOKIE==='1'?'https:':'http:')+'//'))&&!allowed.includes(origin))return reject(res,403,'请求来源不受信任');}
  const mode=authMode();
  if(!['demo','native'].includes(mode))return reject(res,503,'认证模式无效，请配置native（主系统统一登录）或明确的隔离demo');
  if(req.url.startsWith('/api/auth/'))return next();
  // 视觉边缘上报（POST /api/vision/report）是机器到机器通道：自带 HMAC-SHA256
  // 签名 + 时间窗 + nonce 防重放（server/vision/monitor.ts），不持登录 Cookie，
  // 必须在身份分支之前放行——放行后仍要过签名校验，并非无鉴权端点。
  if(req.url.startsWith('/api/vision/report'))return next();
  // 主系统调度器的服务调用（/api/service/agent-run）：同样是机器到机器，
  // 自带 HMAC 签名 + 时间窗 + nonce 防重放，不持登录 Cookie；放行后仍必须验签。
  if(req.url.startsWith('/api/service/'))return next();
  if(mode==='native'||req.url.startsWith('/api/shared-chat/')){
    try{const delegated=await authenticateNative(req);await withNativeDelegation(delegated,async()=>{
      const actor=requestIdentity.getStore()!;
      const endpoint=(req.url||'').split('?')[0]!.replace('/api/shared-chat/','/api/');
      if(actor.role==='student'&&!/^\/api\/conversations(?:\/|$)/.test(endpoint)&&!/^\/api\/runs\/[A-Za-z0-9_-]+\/cancel$/.test(endpoint)&&!['/api/state','/api/health'].includes(endpoint)&&!endpoint.startsWith('/api/knowledge/'))return reject(res,403,'学生共享通道只开放只读聊天及本人历史，不开放完整工作台、任务或自动化接口');
      if(req.method==='POST'&&/\/messages(?:\?|$)|\/agent\/chat(?:\?|$)/.test(req.url||'')){
        if(!allowance(`minute:${actor.id}`,limit('LABOPS_RUNS_PER_MINUTE',12),60000)||!allowance(`day:${actor.id}`,limit('LABOPS_RUNS_PER_DAY',100),86400000)||!allowance('global-day',limit('LABOPS_GLOBAL_RUNS_PER_DAY',1000),86400000))return reject(res,429,'已达到模型调用限额，请稍后再试');
      }
      await next();
    });}catch(e){if(!res.headersSent)reject(res,(e as {status?:number}).status||502,(e as Error).message);}return;
  }
  const db = getDb();
  const now = Date.now();
  db.prepare('DELETE FROM demo_sessions WHERE expiresAt < ?').run(now);
  let token = /(?:^|;\s*)labops_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  let row = token ? db.prepare('SELECT subject FROM demo_sessions WHERE tokenHash=? AND expiresAt>?').get(hash(token), now) as {subject:string}|undefined : undefined;
  if (!row) {
    if (!allowance(`new:${req.socket.remoteAddress}`, limit('LABOPS_NEW_SESSIONS_PER_HOUR',60),3600000)) return reject(res,429,'演示会话创建过于频繁，请稍后再试');
    token = randomBytes(32).toString('hex');
    row = {subject:randomBytes(16).toString('hex')};
    db.prepare('INSERT INTO demo_sessions VALUES (?,?,?)').run(hash(token),row.subject,now+7*86400000);
    const secure = process.env.LABOPS_SECURE_COOKIE === '1' ? '; Secure' : '';
    res.setHeader('Set-Cookie',`labops_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`);
  }
  const roleHeader = req.headers['x-labops-sandbox-role'];
  const role = isSandboxRole(roleHeader) ? roleHeader : 'admin';
  const actor = {id:`demo-${row.subject}-${role}`,role,label:SANDBOX_ROLE_LABELS[role]};
  if (req.method === 'POST' && (req.url.split('?')[0] === '/api/agent/chat' || /\/messages(?:\?|$)/.test(req.url))) {
    const ok = allowance(`minute:${actor.id}`,limit('LABOPS_RUNS_PER_MINUTE',12),60000)
      && allowance(`day:${actor.id}`,limit('LABOPS_RUNS_PER_DAY',100),86400000)
      && allowance('global-day',limit('LABOPS_GLOBAL_RUNS_PER_DAY',1000),86400000);
    if (!ok) return reject(res,429,'已达到演示模型调用限额，请稍后再试');
  }
  await requestIdentity.run(actor,next);
}
