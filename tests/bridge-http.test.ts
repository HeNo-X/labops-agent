// Legacy regression fixture explicitly uses the isolated demo workspaces.
process.env.LABOPS_AUTH_MODE='demo';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// @ts-expect-error Fixture CLI is ordinary JavaScript, also runnable without a transpiler.
import {createReviewFixture} from '../scripts/create-review-fixture.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labops-bridge-'));
const fixture=createReviewFixture(path.join(temp,'native')) as {date:string;accounts:Array<{account:string;password:string;identity:string}>};
process.env.LABOPS_DB_PATH=path.join(temp,'agent.sqlite');process.env.AGNES_API_KEY='';
async function freePort(){const s=http.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
const port=await freePort();process.env.LABOPS_BUSINESS_URL=`http://127.0.0.1:${port}`;
const native=spawn(process.execPath,[fileURLToPath(new URL('../../Pages/serve.js',import.meta.url))],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:path.join(temp,'native'),REGISTER_OPEN:'0',ENABLE_SEED_ACCOUNTS:'0',ENABLE_BASE_SEED:'0'},stdio:['ignore','ignore','pipe']});
let startupError='';native.stderr.on('data',chunk=>{startupError+=chunk.toString();});
for(let i=0;i<60;i++){if(native.exitCode!==null)throw new Error('原系统启动失败：'+startupError);try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
const {withHttpIdentity}=await import('../server/security/http.ts');
const {handleRequest}=await import('../server/index.ts');
const {getDb}=await import('../server/persistence/db.ts');
const agent=http.createServer((req,res)=>{withHttpIdentity(req,res,()=>handleRequest(req,res)).catch(e=>{res.writeHead(500);res.end(String(e));});});
await new Promise<void>(r=>agent.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(agent.address() as {port:number}).port}`;
async function client(identity:string){
  const r=await fetch(base+'/api/business/status');const cookie=r.headers.get('set-cookie')!.split(';')[0]!;
  const account=fixture.accounts.find(a=>a.identity===identity)!;
  let scopeKey='';
  const req=async(url:string,body?:unknown)=>{const res=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(url.startsWith('/api/business/proxy/')?{scopeKey,...(body as Record<string,unknown>)}:body)})});const data=res.headers.get('content-type')?.includes('text/event-stream')?{events:(await res.text()).split('\n\n').flatMap(s=>{const l=s.split('\n').find(l=>l.startsWith('data: '));return l?[JSON.parse(l.slice(6))]:[];})}:await res.json();if((url==='/api/business/status'||url==='/api/business/connect')&&data.scopeKey)scopeKey=data.scopeKey;return {status:res.status,data:data as any};};
  const login=await req('/api/business/connect',account);assert.equal(login.status,200);scopeKey=login.data.scopeKey;
  return req;
}
test('真实本地双服务HTTP：登录桥接、指定日期调课、重试回查、Agent实时重新查询',async()=>{
  const admin=await client('admin');
  const preview=await admin('/api/business/proxy/schedule/preview',{date:fixture.date,timetableId:'fixture-lesson',toLabId:'fixture-e312',toPeriodKey:'pm1',reason:'隔离测试：投影故障'});
  assert.equal(preview.status,200);const plan=preview.data.plan;
  const first=await admin('/api/business/proxy/plans/commit',{planId:plan.id,version:1});assert.equal(first.status,200);
  const replay=await admin('/api/business/proxy/plans/commit',{planId:plan.id,version:1});assert.equal(replay.data.receipt.operationId,first.data.receipt.operationId);
  const ctx=await admin('/api/business/proxy/context');assert.equal(ctx.data.adjustments.filter((x:any)=>x.id===first.data.receipt.operationId).length,1);
  const live=await admin('/api/state');assert.equal(live.data.sourceType,'live');
  const lookup=await admin('/api/business/proxy/schedule/preview',{date:fixture.date,timetableId:'fixture-lesson'});assert.equal(lookup.data.source.labId,'fixture-e312');
  const owner=await admin('/api/business/proxy/operations/'+first.data.receipt.operationId);assert.equal(owner.status,200);
  const student=await client('student');assert.equal((await student('/api/business/proxy/plans/commit',{planId:plan.id,version:1})).status,404);
});
test('V03 代理写请求缺少/伪造授权范围拒绝，旧卡重新连接后不能借新会话提交',async()=>{
 const request=await client('admin'),status=await request('/api/business/status'),input={date:fixture.date,timetableId:'fixture-lesson'};
 assert.equal((await request('/api/business/proxy/schedule/preview',{...input,scopeKey:undefined})).data.code,'scope_required');assert.equal((await request('/api/business/proxy/schedule/preview',{...input,scopeKey:'forged'})).data.code,'scope_changed');
 await request('/api/business/disconnect',{});await request('/api/business/connect',fixture.accounts.find(a=>a.identity==='admin'));assert.equal((await request('/api/business/proxy/schedule/preview',{...input,scopeKey:status.data.scopeKey})).status,409);
});
test('X08/09 旧原管理页面全量保存不清掉原系统任务、事件、候选和已确认调课',async()=>{
 const request=await client('admin'),before=await request('/api/business/proxy/tasks');assert.ok(before.data.tasks.length);
 const i=await request('/api/business/proxy/incidents/draft',{roomId:'fixture-e310',date:fixture.date,periodKeys:['pm1'],description:'旧页面保全隔离事件'});assert.equal(i.status,200);
 const login=await (await fetch(process.env.LABOPS_BUSINESS_URL+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture.accounts.find(a=>a.identity==='admin'))})).json() as {token:string};const headers={'Content-Type':'application/json',Authorization:'Bearer '+login.token};
 const state=await (await fetch(process.env.LABOPS_BUSINESS_URL+'/api/state',{headers})).json() as {rev:number;state:unknown};const saved=await fetch(process.env.LABOPS_BUSINESS_URL+'/api/state',{method:'POST',headers,body:JSON.stringify({rev:state.rev,state:state.state})});assert.equal(saved.status,200);
 const after=await request('/api/business/proxy/tasks');assert.equal(after.data.tasks.length,before.data.tasks.length+1);assert.ok(after.data.tasks.some((t:any)=>t.id===i.data.task.id));assert.equal((await request('/api/business/proxy/incidents/'+i.data.incident.id)).status,200);const ctx=await request('/api/business/proxy/context');assert.ok(ctx.data.adjustments.length);
});
test('真实本地双服务HTTP：志愿者交接与定向通知/已读可在管理员回查',async()=>{
  const admin=await client('admin'),vol=await client('volunteer'),student=await client('student');
  const p=await vol('/api/business/proxy/handover/preview',{shiftId:'fixture-shift',checklist:['power','lights','doors','keys','todo'].map(key=>({key,state:key==='power'?'abnormal':'unchecked'})),note:'隔离测试异常',createIssue:true});assert.equal(p.status,200);
  assert.equal((await vol('/api/business/proxy/plans/commit',{planId:p.data.plan.id,version:1})).status,200);
  const context=await admin('/api/business/proxy/context');assert.equal(context.data.handovers.length,1);assert.equal(context.data.issues.length,1);
  const n=await admin('/api/business/proxy/notifications',{requestId:'fixture-ntf',title:'隔离测试通知',content:'仅用于本地验证',audience:{kind:'role',role:'volunteer'}});assert.equal(n.status,200);
  assert.equal((await student('/api/business/proxy/context')).data.notifications.length,0);
  assert.equal((await vol('/api/business/proxy/notifications/read',{id:n.data.notification.id})).status,200);
  const readback=await admin('/api/business/proxy/context');assert.ok(readback.data.notifications[0].reads['review-volunteer']);
});
test('原系统静态通道不能读取业务服务与数据库源码',async()=>{
  for(const url of ['/server/operations.js','/lib/db.js','/serve.js','/data/state.json'])assert.equal((await fetch(`http://127.0.0.1:${port}`+url)).status,403);
});
after(async()=>{native.kill('SIGTERM');agent.closeAllConnections();await new Promise<void>(r=>agent.close(()=>r()));getDb().close();await new Promise(r=>setTimeout(r,100));fs.rmSync(temp,{recursive:true,force:true});});

test('R06 断开吊销原会话，换管理员→学生不沿用事实/方案，凭证以密文存储',async()=>{
 const request=await client('admin');
 const c=await request('/api/conversations',{mode:'task',title:'scope-test'});const conversationId=c.data.id;
 const account=fixture.accounts.find(a=>a.identity==='student')!;
 // The stream endpoint is exercised through the real HTTP client; parse its text separately.
 const ds=await request('/api/state');assert.equal(ds.data.sourceType,'live');
 const live=await request(`/api/conversations/${conversationId}/messages`,{message:`查询E312在${fixture.date}的课表`,clientRequestId:crypto.randomUUID()});assert.ok(live.data.events.some((e:any)=>e.type==='run_completed'));
 assert.equal((await request('/api/conversations/'+conversationId)).data.messages.at(-1).meta.sourceType,'live');
 const rows=getDb().prepare('SELECT token,profile FROM business_connections').all() as Array<{token:string;profile:string}>;assert.ok(rows.every(r=>r.token.startsWith('enc:v1:')));
 const current=await request('/api/business/status');assert.equal(current.data.profile.identity,'admin');const oldScope=current.data.scopeKey;
 const disconnected=await request('/api/business/disconnect',{});assert.equal(disconnected.data.revoked,true);
 assert.equal((await request('/api/business/status')).data.connected,false);
 const historic=await request(`/api/conversations/${conversationId}/messages`,{message:'把刚才课表改成两列表格',clientRequestId:crypto.randomUUID()});assert.ok(historic.data.events.some((e:any)=>e.type==='run_failed'));assert.ok(historic.data.events.every((e:any)=>e.type!=='run_completed'));
 const switched=await request('/api/business/connect',account);assert.equal(switched.data.profile.identity,'student');assert.notEqual(switched.data.scopeKey,oldScope);
 const context=await request('/api/business/proxy/context');assert.equal(context.data.actor.identity,'student');assert.equal(context.data.classes.length,0);assert.equal(context.data.assignees.length,0);
 const draft=await request('/api/business/proxy/schedule/preview',{date:fixture.date,timetableId:'fixture-lesson'});assert.equal(draft.status,403);
 const history=await request('/api/conversations/'+conversationId);assert.equal(history.status,200);assert.equal(history.data.messages[1].meta.toolCalls.length,0);assert.ok(history.data.messages[1].text.includes('授权范围'));
});
test('同工作区另一请求断开连接，中途流停止且不保存为新范围事实',async()=>{
 const first=await fetch(base+'/api/business/status'),cookie=first.headers.get('set-cookie')!.split(';')[0]!;
 const call=(url:string,body?:unknown)=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await call('/api/business/connect',fixture.accounts.find(a=>a.identity==='admin'))).status,200);
 const conv=await (await call('/api/conversations',{mode:'task',title:'mid-stream-scope'})).json() as {id:string};
 const response=await call(`/api/conversations/${conv.id}/messages`,{message:`查询E312在${fixture.date}的课表`,clientRequestId:crypto.randomUUID()});
 const reader=response.body!.getReader(),decoder=new TextDecoder();let body='';
 while(!body.includes('event: run_started')){const c=await reader.read();assert.equal(c.done,false);body+=decoder.decode(c.value,{stream:true});}
 assert.equal((await call('/api/business/disconnect',{})).status,200);
 const status=await (await call('/api/business/status')).json() as {scopeKey:string};
 for(;;){const c=await reader.read();if(c.done)break;body+=decoder.decode(c.value,{stream:true});}
 const events=body.split('\n\n').flatMap(s=>{const l=s.split('\n').find(l=>l.startsWith('data: '));return l?[JSON.parse(l.slice(6))]:[];});
 assert.equal(events.filter(e=>e.type==='run_completed').length,0);assert.equal(events.filter(e=>e.type==='run_failed'&&e.payload.code==='scope_changed').length,1);assert.equal(events.at(-1).payload.status,'failed');
 const count=getDb().prepare('SELECT COUNT(*) AS n FROM verified_fact_sets WHERE sessionId=? AND scopeKey=?').get(conv.id,status.scopeKey) as {n:number};assert.equal(count.n,0);
});
test('连接状态实时验证停用与角色变化，失败清理原授权范围和活动上下文',async()=>{
 const request=await client('admin');const before=await request('/api/business/status');const file=path.join(temp,'native','credentials.json');const creds=JSON.parse(fs.readFileSync(file,'utf8'));
 try{creds['review-admin'].identity='student';fs.writeFileSync(file,JSON.stringify(creds));const changed=await request('/api/business/status');assert.equal(changed.data.profile.identity,'student');assert.notEqual(changed.data.scopeKey,before.data.scopeKey);
 creds['review-admin'].status='disabled';fs.writeFileSync(file,JSON.stringify(creds));const invalid=await request('/api/business/status');assert.equal(invalid.data.connected,false);assert.equal(invalid.data.state,'expired');assert.equal((await request('/api/business/proxy/context')).status,401);
 }finally{creds['review-admin'].status='active';creds['review-admin'].identity='admin';fs.writeFileSync(file,JSON.stringify(creds));}
});
