import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../persistence/db.ts';
import { currentActor } from '../security/context.ts';
import { forgetOwnerSessions } from '../agent/session.ts';
import { readJsonBody } from '../api/agent-chat.ts';
import { buildFromSnapshotLike, loadDataset, type Dataset } from '../data/store.ts';
import { PROJECT_ROOT } from '../config.ts';

type Profile={username?:string;account?:string;identity?:string;className?:string;mustChangePassword?:boolean};
type Connection = {token:string;profile:string};
const ownerId=()=>currentActor()?.id??'';
function tables(){getDb().exec(`CREATE TABLE IF NOT EXISTS business_connections(ownerId TEXT PRIMARY KEY, token TEXT NOT NULL, profile TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS business_generations(ownerId TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'disconnected');`);}
function credentialKey():Buffer{
  if(process.env.LABOPS_CREDENTIAL_KEY){const key=Buffer.from(process.env.LABOPS_CREDENTIAL_KEY,'base64');if(key.length!==32)throw new Error('LABOPS_CREDENTIAL_KEY 应为32字节密钥的base64');return key;}
  const file=process.env.LABOPS_CREDENTIAL_KEY_FILE|| (process.env.LABOPS_DB_PATH?process.env.LABOPS_DB_PATH+'.key':path.join(PROJECT_ROOT,'server','credentials','business.key'));
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  try{fs.writeFileSync(file,crypto.randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const key=fs.readFileSync(file);if(key.length!==32)throw new Error('业务凭证密钥文件无效');return key;
}
function encrypt(token:string):string{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',credentialKey(),iv);const data=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return 'enc:v1:'+Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
function decrypt(token:string):string{if(!token.startsWith('enc:v1:'))return token;const data=Buffer.from(token.slice(7),'base64'),dec=crypto.createDecipheriv('aes-256-gcm',credentialKey(),data.subarray(0,12));dec.setAuthTag(data.subarray(12,28));return Buffer.concat([dec.update(data.subarray(28)),dec.final()]).toString('utf8');}
function connection(owner=ownerId()):Connection|null{
  tables();const c=getDb().prepare('SELECT token,profile FROM business_connections WHERE ownerId=?').get(owner) as Connection|undefined;
  if(c&&!c.token.startsWith('enc:v1:'))getDb().prepare('UPDATE business_connections SET token=? WHERE ownerId=?').run(encrypt(c.token),owner);
  return c?{...c,token:decrypt(c.token)}:null;
}
export function businessScope(owner=ownerId()):{scopeKey:string;generation:number;principal:Profile|null}{
  const c=connection(owner);const principal=c?JSON.parse(c.profile) as Profile:null;
  const row=getDb().prepare('SELECT generation FROM business_generations WHERE ownerId=?').get(owner) as {generation:number}|undefined;
  const generation=row?.generation||0;
  return {principal,generation,scopeKey:crypto.createHash('sha256').update(JSON.stringify([process.env.LABOPS_BUSINESS_URL||'',principal?.username||principal?.account||'demo',principal?.identity||'',principal?.className||'',generation])).digest('hex')};
}
export function isBusinessConnected():boolean{return Boolean(connection());}
export function effectiveRole(fallback='student'):string{return businessScope().principal?.identity||fallback;}
function resetAuthority(owner:string,state:string){
  tables();getDb().prepare(`INSERT INTO business_generations VALUES (?,1,?) ON CONFLICT(ownerId) DO UPDATE SET generation=generation+1,state=excluded.state`).run(owner,state);
  getDb().prepare('UPDATE conversations SET contextLab=NULL,contextDate=NULL,contextTask=NULL WHERE ownerId=?').run(owner);
  forgetOwnerSessions(owner);
  getDb().exec('CREATE TABLE IF NOT EXISTS business_tasks(ownerId TEXT NOT NULL,sessionId TEXT NOT NULL,scopeKey TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ownerId,sessionId))');
  getDb().prepare('DELETE FROM business_tasks WHERE ownerId=?').run(owner);
  taskContextTable();getDb().prepare('DELETE FROM business_task_contexts WHERE ownerId=?').run(owner);
}
function baseUrl():string{
  const value=process.env.LABOPS_BUSINESS_URL;if(!value)throw new Error('尚未配置原系统连接地址，请设置 LABOPS_BUSINESS_URL 后重启');
  const u=new URL(value);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','lab'].includes(u.hostname)))throw new Error('原系统地址必须使用 HTTPS（本地与 Docker lab 服务例外）');
  if(u.username||u.password||u.search||u.hash)throw new Error('原系统连接地址无效');return u.origin;
}
async function remote(p:string,method:string,token?:string,body?:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const timeout=AbortSignal.timeout(10000);
  const res=await fetch(baseUrl()+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
  const result=await res.json() as Record<string,unknown>;
  if(!res.ok)throw Object.assign(new Error(String(result['message']||result['error']||'原系统请求失败')),{status:res.status,code:result['error']});return result;
}
function checkPrincipal(raw:Record<string,unknown>,c:Connection){
  const a=raw['actor']||raw['principal'];if(!a)return;
  const old=JSON.parse(c.profile) as Profile,next=a as Profile;
  if(JSON.stringify([old.username||old.account,old.identity,old.className||''])!==JSON.stringify([next.username||next.account,next.identity,next.className||''])){
    resetAuthority(ownerId(),'connected');getDb().prepare('UPDATE business_connections SET profile=? WHERE ownerId=?').run(JSON.stringify(next),ownerId());
  }
}
export async function businessRequest(p:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const c=connection();if(!c)throw Object.assign(new Error('请先连接原系统账号'),{status:401});
  try{const r=await remote('/api/integration'+p,method,c.token,body,signal);if(connection()?.token!==c.token)throw Object.assign(new Error('业务连接已变化，请重新查询'),{status:409,code:'scope_changed'});checkPrincipal(r,c);return r;}
  catch(e){if([401,403].includes((e as {status?:number}).status||0)&& (p==='/context'||p==='/snapshot')){getDb().prepare('DELETE FROM business_connections WHERE ownerId=?').run(ownerId());resetAuthority(ownerId(),'expired');}throw e;}
}
export async function loadAuthorizedDataset(signal?:AbortSignal):Promise<Dataset>{
  if(!connection()){tables();const r=getDb().prepare('SELECT state FROM business_generations WHERE ownerId=?').get(ownerId()) as {state:string}|undefined;if(r?.state==='expired')throw new Error('原系统授权已失效，请重新连接账号或明确断开后使用演示数据');return loadDataset();}const raw=await businessRequest('/snapshot','GET',undefined,signal);return buildFromSnapshotLike(raw,'live','',[]);
}
function taskContextTable(){getDb().exec('CREATE TABLE IF NOT EXISTS business_tasks(ownerId TEXT NOT NULL,sessionId TEXT NOT NULL,scopeKey TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ownerId,sessionId))');getDb().exec('CREATE TABLE IF NOT EXISTS business_task_contexts(ownerId TEXT NOT NULL,sessionId TEXT NOT NULL,scopeKey TEXT NOT NULL,taskId TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ownerId,sessionId,scopeKey,taskId))');}
export function rememberBusinessTask(session:string|null|undefined,payload:unknown){if(!session)return;tables();taskContextTable();const p=payload as {taskId?:string;plan?:{taskId?:string;id:string};view?:string};const taskId=p.taskId||p.plan?.taskId||p.plan?.id;if(taskId)getDb().prepare('INSERT INTO business_task_contexts VALUES (?,?,?,?,?) ON CONFLICT(ownerId,sessionId,scopeKey,taskId) DO UPDATE SET payload=excluded.payload').run(ownerId(),session,businessScope().scopeKey,taskId,JSON.stringify(payload));getDb().prepare('INSERT INTO business_tasks VALUES (?,?,?,?) ON CONFLICT(ownerId,sessionId) DO UPDATE SET scopeKey=excluded.scopeKey,payload=excluded.payload').run(ownerId(),session,businessScope().scopeKey,JSON.stringify(payload));}
export function listBusinessTasks(session:string|null|undefined):Record<string,unknown>[]{if(!session)return [];tables();taskContextTable();return (getDb().prepare('SELECT payload FROM business_task_contexts WHERE ownerId=? AND sessionId=? AND scopeKey=? ORDER BY rowid').all(ownerId(),session,businessScope().scopeKey) as Array<{payload:string}>).map(r=>JSON.parse(r.payload));}
export function readBusinessTask(session:string|null|undefined):Record<string,unknown>|null{if(!session)return null;tables();getDb().exec('CREATE TABLE IF NOT EXISTS business_tasks(ownerId TEXT NOT NULL,sessionId TEXT NOT NULL,scopeKey TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(ownerId,sessionId))');const r=getDb().prepare('SELECT payload FROM business_tasks WHERE ownerId=? AND sessionId=? AND scopeKey=?').get(ownerId(),session,businessScope().scopeKey) as {payload:string}|undefined;return r?JSON.parse(r.payload):null;}
export async function handleBusinessApi(req:IncomingMessage,res:ServerResponse,p:string):Promise<void>{
  const send=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    const method=req.method||'GET';
    if(p==='/api/business/status'&&method==='GET'){
      const c=connection();let profile=c?JSON.parse(c.profile):null;let state='disconnected';
      if(c){try{const r=await businessRequest('/context');profile=r['actor'];state='connected';}catch(e){state=isBusinessConnected()?'unavailable':'expired';return send(200,{configured:Boolean(process.env.LABOPS_BUSINESS_URL),connected:false,state,profile:null,message:(e as Error).message});}}
      return send(200,{configured:Boolean(process.env.LABOPS_BUSINESS_URL),connected:Boolean(c),state,profile,scopeKey:businessScope().scopeKey,actions:['指定日期调课','检查补全与最终交接','工单流转','定向通知','真实日报']});
    }
    if(p==='/api/business/disconnect'&&method==='POST'){
      const c=connection();let revoked=true;if(c){try{await remote('/api/auth/logout','POST',c.token,{});}catch{revoked=false;}}
      getDb().prepare('DELETE FROM business_connections WHERE ownerId=?').run(ownerId());resetAuthority(ownerId(),'disconnected');
      return send(200,{ok:true,connected:false,revoked,message:revoked?'委托会话已吊销':'本地委托凭证已删除；原系统吊销未确认，请在原系统退出会话'});
    }
    if(p==='/api/business/connect'&&method==='POST'){
      const input=await readJsonBody(req);if(!input.ok)return send(input.status,{message:input.message});const b=input.value as Record<string,unknown>;
      if(typeof b['account']!=='string'||typeof b['password']!=='string')return send(400,{message:'请输入原系统账号和密码'});
      const result=await remote('/api/auth/login','POST',undefined,{account:b['account'],password:b['password']});const token=result['token'];if(typeof token!=='string')throw new Error('原系统未返回有效会话');
      const profile=result['profile'] as Profile;if(profile?.mustChangePassword){await remote('/api/auth/logout','POST',token,{});return send(403,{message:'请先在原系统修改临时密码'});}
      const old=connection();if(old){try{await remote('/api/auth/logout','POST',old.token,{});}catch{/* old credentials are discarded locally */}}
      resetAuthority(ownerId(),'connected');getDb().prepare('INSERT INTO business_connections VALUES (?,?,?) ON CONFLICT(ownerId) DO UPDATE SET token=excluded.token,profile=excluded.profile').run(ownerId(),encrypt(token),JSON.stringify(profile));
      return send(200,{connected:true,profile,scopeKey:businessScope().scopeKey});
    }
    const endpoint=p.slice('/api/business/proxy'.length);
    const allowedGet=endpoint==='/context'||endpoint==='/resource-health'||endpoint==='/tasks'||endpoint==='/incidents'||/^\/incidents\/incident-[a-f0-9-]+$/.test(endpoint)||/^\/tasks\/task-[a-f0-9-]+$/.test(endpoint)||/^\/report\/\d{4}-\d{2}-\d{2}$/.test(endpoint)||/^\/(operations\/business-plan-|plans\/plan-)[a-f0-9-]+$/.test(endpoint);
    const allowedPost=endpoint==='/incidents/draft'||/^\/incidents\/incident-[a-f0-9-]+\/(analyze|preview|restore|takeover)$/.test(endpoint)||['/schedule/preview','/handover/preview','/workflow/preview','/plans/commit','/plans/reject','/shifts','/resources','/calendar','/notifications','/notifications/read'].includes(endpoint);
    if(!p.startsWith('/api/business/proxy/')||method==='GET'&&!allowedGet||method==='POST'&&!allowedPost||!['GET','POST'].includes(method))return send(404,{message:'业务入口不存在'});
    let body:unknown;
    if(method==='POST'){const input=await readJsonBody(req);if(!input.ok)return send(input.status,{message:input.message});body=input.value;}
    // Every browser decision is bound to the currently validated delegated principal.
    if(endpoint!=='/context')await businessRequest('/context');
    const record=body as Record<string,unknown>|undefined;
    if(method==='POST'&&(typeof record?.['scopeKey']!=='string'||!record['scopeKey']))return send(409,{message:'业务操作缺少当前授权范围，请重新查询',code:'scope_required'});
    if(record?.['scopeKey']&&record['scopeKey']!==businessScope().scopeKey)return send(409,{message:'业务账号或授权范围已变化，请重新查询和确认',code:'scope_changed'});
    if(record?.['conversationId']&&!(getDb().prepare('SELECT id FROM conversations WHERE id=? AND ownerId=?').get(record['conversationId'] as string,ownerId())))return send(403,{message:'会话不属于当前工作区',code:'conversation_forbidden'});
    const out=await businessRequest(endpoint,method,body);
    if(record?.['conversationId']&&out['task']){
      const task=out['task'] as {id:string;kind:string},plan=out['plan'] as {id:string}|undefined;
      rememberBusinessTask(record['conversationId'] as string,{task,taskId:task.id,plan,planId:plan?.id||null,view:task.kind==='schedule.move'?'schedule':task.kind.startsWith('incident.')?'incidents':task.kind.startsWith('duty.')?'duty':task.kind.startsWith('issue.')?'issues':'notifications',date:record['date'],sourceLesson:out['source'],candidates:out['candidates']||[],candidateSetId:out['candidateSetId'],scopeKey:businessScope().scopeKey,sourceRevision:out['revision']});
    }
    return send(200,out);
  }catch(e){send((e as {status?:number}).status||502,{message:e instanceof Error?e.message:'原系统不可用',code:(e as {code?:string}).code||'business_unavailable',hint:'保留方案，恢复后重试或回查同一编号。'});}
}
