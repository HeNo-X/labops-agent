import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDb } from '../persistence/db.ts';
import { requestIdentity } from './context.ts';
import { isSandboxRole } from '../operations/identity.ts';
import { SANDBOX_ROLE_LABELS } from '../../shared/operations-contract.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify({error: status === 429 ? 'rate_limited' : 'identity_unavailable', message}));
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

/** Demo identity is a random server-issued browser session, never a public shared role ID. */
export async function withHttpIdentity(req: IncomingMessage, res: ServerResponse, next: () => Promise<void>): Promise<void> {
  if (!req.url?.startsWith('/api/') || req.url.startsWith('/api/health') || req.url.startsWith('/api/agent/health')) return next();
  if (process.env.LABOPS_AUTH_MODE && process.env.LABOPS_AUTH_MODE !== 'demo') {
    return reject(res, 503, '当前构建仅允许隔离演示身份；生产身份适配尚未启用。');
  }
  const origin = req.headers.origin;
  const allowed = (process.env.LABOPS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  if(origin){let host='';try{host=new URL(origin).host;}catch{return reject(res,403,'请求来源无效');}if(host!==req.headers.host&&!allowed.includes(origin))return reject(res,403,'请求来源不受信任');}
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
