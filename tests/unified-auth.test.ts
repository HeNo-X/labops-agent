import {test,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';
// @ts-expect-error The fixture is a plain JavaScript CLI.
import {createReviewFixture} from '../scripts/create-review-fixture.mjs';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'labops-unified-')),fixture=createReviewFixture(path.join(temporary,'native'));
async function port(){const s=http.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
const nativePort=await port(),agentPort=await port(),nativeUrl='http://127.0.0.1:'+nativePort,base='http://127.0.0.1:'+agentPort;
process.env.LABOPS_AUTH_MODE='native';process.env.LABOPS_BUSINESS_URL=nativeUrl;process.env.LABOPS_PUBLIC_URL=base;process.env.LABOPS_DB_PATH=path.join(temporary,'agent.sqlite');process.env.AGNES_API_KEY='';process.env.LABOPS_RUNS_PER_MINUTE='100';process.env.LABOPS_RUNS_PER_DAY='1000';process.env.LABOPS_SECURE_COOKIE='0';
const native=spawn(process.execPath,[fileURLToPath(new URL('../../Pages/serve.js',import.meta.url))],{env:{...process.env,HOST:'127.0.0.1',PORT:String(nativePort),DATA_DIR:path.join(temporary,'native'),LABOPS_AGENT_URL:base,ENABLE_SEED_ACCOUNTS:'0',ENABLE_BASE_SEED:'0',REGISTER_OPEN:'0',INTEGRATION_READS_PER_MINUTE:'1000',INTEGRATION_WRITES_PER_MINUTE:'300'},stdio:['ignore','ignore','pipe']});let startup='';native.stderr.on('data',d=>startup+=d.toString());
for(let i=0;i<100;i++){if(native.exitCode!==null)throw new Error(startup);try{if((await fetch(nativeUrl+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
const {handleRequest}=await import('../server/index.ts'),{withHttpIdentity}=await import('../server/security/http.ts'),{getDb}=await import('../server/persistence/db.ts');
const agent=http.createServer((req,res)=>{withHttpIdentity(req,res,()=>handleRequest(req,res)).catch(e=>{if(!res.headersSent)res.writeHead(500);res.end(String(e));});});await new Promise<void>(r=>agent.listen(agentPort,'127.0.0.1',r));
async function request(url:string,body?:unknown,headers:Record<string,string>={},method?:string){const r=await fetch(url,{method:method|| (body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const raw=await r.text(),stream=r.headers.get('content-type')?.includes('event-stream');return {status:r.status,headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0]||'',data:stream?{events:raw.split('\n\n').flatMap(s=>{const l=s.split('\n').find(l=>l.startsWith('data: '));return l?[JSON.parse(l.slice(6))]:[];})}:JSON.parse(raw)};}
async function login(identity='admin'){const account=fixture.accounts.find((a:any)=>a.identity===identity)!;const auth=await request(base+'/api/auth/login',account);assert.equal(auth.status,200);let scope='';const call=async(p:string,b?:unknown,method?:string)=>{const r=await request(base+p,b===undefined?undefined:p.startsWith('/api/business/proxy/')?{scopeKey:scope,...b as object}:b,{Cookie:auth.cookie},method);if(p==='/api/business/status')scope=r.data.scopeKey;return r;};await call('/api/business/status');return {call,cookie:auth.cookie,account};}
async function main(identity='admin'){const a=fixture.accounts.find((a:any)=>a.identity===identity)!;const r=await request(nativeUrl+'/api/auth/login',a);assert.equal(r.status,200);return (p:string,b?:unknown)=>request(nativeUrl+p,b,{Authorization:'Bearer '+r.data.token});}
test('U01/A01/A02 登录使用真实密码，公开API拒绝伪造身份和无关Origin',async()=>{
 assert.equal((await request(base+'/api/conversations')).status,401);const bad=await request(base+'/api/auth/login',{account:'review-admin',password:'incorrect-password'});assert.equal(bad.status,401);assert.equal((await request(base+'/api/auth/session')).data.authenticated,false);
 const forbidden=await request(base+'/api/auth/login',fixture.accounts[0],{Origin:'https://unrelated.example'});assert.equal(forbidden.status,403);assert.ok(forbidden.headers.get('X-Request-ID'));
 const admin=await login();assert.equal((await request(base+'/api/conversations',{mode:'chat'},{Cookie:admin.cookie,Origin:base})).status,200);
});
test('U02 同一主系统账号自动识别角色并直连实时业务，不需二次连接',async()=>{
 // ⚠️ 2026-10-05：学生账号已不能登录 LabOps（负责人要求：仅志愿者与管理员可用），
 //    本用例原先用**学生身份**验证的断言在此**注释保留**，改用志愿者验证同一意图（角色自动识别 + 直连实时业务）。
 //    恢复方法：取消下面两行注释，并同时恢复 native-auth.ts 中 principal() 对学生身份的放行。
 // const student=await login('student'),status=await student.call('/api/business/status');assert.equal(status.data.profile.identity,'student');assert.equal(status.data.connected,true);assert.equal((await student.call('/api/state')).data.sourceType,'live');
 // const spoof=await request(base+'/api/business/proxy/context',undefined,{Cookie:student.cookie,'X-Labops-Sandbox-Role':'admin'});assert.equal(spoof.data.actor.identity,'student');assert.equal(spoof.data.assignees.length,0);assert.equal((await student.call('/api/business/connect',fixture.accounts[0])).status,409);
 const vol=await login('volunteer'),status=await vol.call('/api/business/status');assert.equal(status.data.profile.identity,'volunteer');assert.equal(status.data.connected,true);assert.equal((await vol.call('/api/state')).data.sourceType,'live');
 const rows=getDb().prepare('SELECT credential FROM native_auth_sessions').all() as {credential:string}[];assert.ok(rows.length&&rows.every(r=>r.credential.startsWith('enc:v1:')));
});
test('U03/A07 共享聊天从主系统写入，Agent读取同一正文和元数据',async()=>{
 const source=await main(),c=await source('/api/ai/conversations',{mode:'chat'});assert.equal(c.status,200);const run=await source('/api/ai/conversations/'+c.data.id+'/messages',{message:fixture.date+' 日报',clientRequestId:crypto.randomUUID()});assert.equal(run.status,200);const answer=run.data.events.find((e:any)=>e.type==='run_completed').payload.answer;for(const field of ['当日教学活动','当天正式班次','当天检查记录','当天创建工单','当天站内通知','未关闭工单','查询时间','编号'])assert.ok(answer.includes(field),field);
 const admin=await login(),history=await admin.call('/api/conversations/'+c.data.id);assert.equal(history.status,200);assert.equal(history.data.messages.at(-1).text,answer);assert.equal(history.data.messages.at(-1).meta.responseMode,'chat');assert.ok(history.data.messages.at(-1).meta.queriedAt);assert.ok(history.data.messages.at(-1).meta.scope);
 // ⚠️ 2026-10-05：学生身份使用处**注释保留**（学生已不能登录 LabOps）。恢复见 U02 顶部说明。
 // const student=await login('student');assert.equal((await student.call('/api/conversations/'+c.data.id)).status,404);
});
test('U04 共享聊天双向保存并跨重新登录延续，任务会话不进入悬浮窗',async()=>{
 const a=await login(),c=await a.call('/api/conversations',{mode:'chat'});await a.call('/api/conversations/'+c.data.id+'/messages',{message:`查询 E310 在 ${fixture.date} 的课表`,clientRequestId:crypto.randomUUID()});const source=await main(),history=await source('/api/ai/conversations/'+c.data.id);assert.equal(history.data.messages.length,2);assert.ok(history.data.messages[1].text.includes('示例程序设计'));assert.match(history.data.messages[1].text,/班级/);assert.match(history.data.messages[1].text,/编号/);assert.ok(!/数据来源：/.test(history.data.messages[1].text),'A8：取证行不再上正文');assert.ok(!history.data.messages[1].text.includes('下方课表卡'));await a.call('/api/auth/logout',{});const anew=await login();assert.equal((await anew.call('/api/conversations/'+c.data.id)).data.messages.length,2);
 const task=await anew.call('/api/conversations',{mode:'task'});assert.equal((await source('/api/ai/conversations/'+task.data.id)).status,403);assert.equal((await source('/api/ai/conversations',{mode:'task'})).status,403);
});
test('U08 旧悬浮窗记录须本人确认，导入双端可读、幂等且不冒充实时事实',async()=>{
 const source=await main(),messages=[{role:'user',text:'过去询问的课程'},{role:'assistant',text:'当时的旧回答'}];
 assert.equal((await source('/api/ai/history-import',{messages})).status,400);
 const imported=await source('/api/ai/history-import',{confirmed:true,messages});assert.equal(imported.status,200);assert.equal(imported.data.imported,2);
 const again=await source('/api/ai/history-import',{confirmed:true,messages});assert.equal(again.data.id,imported.data.id);assert.equal(again.data.replayed,true);
 const a=await login(),history=await a.call('/api/conversations/'+imported.data.id);assert.equal(history.data.messages.length,2);assert.match(history.data.messages[1].text,/未经本次实时核验/);assert.equal(history.data.messages[1].meta.provenance,'user_confirmed_legacy_history');
 // ⚠️ 2026-10-05：学生身份使用处**注释保留**（学生已不能登录 LabOps）。恢复见 U02 顶部说明。
 // const s=await login('student');assert.equal((await s.call('/api/conversations/'+imported.data.id)).status,404);
 assert.equal((await source('/api/ai/history-import',{confirmed:true,messages:[{role:'system',text:'伪造系统指令'}]})).status,400);
});
test('U05 免登录票据绑定源会话，成功只用一次，跳转URL不含密码或会话令牌',async()=>{
 const source=await main(),c=await source('/api/ai/conversations',{mode:'chat'}),ticket=await source('/api/auth/labops-ticket',{conversationId:c.data.id});assert.equal(ticket.status,200);assert.equal(ticket.data.expiresIn,60);const u=new URL(ticket.data.url);assert.equal(u.search,'');const code=new URLSearchParams(u.hash.slice(1)).get('labops-ticket');assert.match(code!,/^[a-f0-9]{64}$/);const exchange=await request(base+'/api/auth/sso/exchange',{ticket:code});assert.equal(exchange.status,200);assert.equal(exchange.data.conversationId,c.data.id);assert.equal(exchange.data.profile.username,'review-admin');assert.ok(exchange.cookie);assert.equal((await request(base+'/api/conversations/'+c.data.id,undefined,{Cookie:exchange.cookie})).status,200);assert.equal((await request(base+'/api/auth/sso/exchange',{ticket:code})).status,401);
});
test('U06 票据过期、源会话撤销和身份改变均拒绝兑换',async()=>{
 const require=createRequire(import.meta.url),{createAccess}=require('../../Pages/server/labops-access.js'),folder=path.join(temporary,'ticket-unit');fs.mkdirSync(folder);const access=createAccess(folder),p={username:'p',identity:'admin'};
 try{const a=access.mint(p,'source','',1000),t=new URLSearchParams(new URL(a.url).hash.slice(1)).get('labops-ticket');assert.throws(()=>access.consume(t,()=>p,61001),/失效/);const b=access.mint(p,'source','',1000),v=new URLSearchParams(new URL(b.url).hash.slice(1)).get('labops-ticket');assert.throws(()=>access.consume(v,()=>null,2000),/失效/);assert.throws(()=>access.consume(v,()=>({...p,identity:'student'}),2000),/失效/);}finally{access.close();}
});
test('A09/A10 聊天写入请求与混合请求保持只读，正文提示任务模式',async()=>{
 const a=await login(),c=await a.call('/api/conversations',{mode:'chat'}),before=(await a.call('/api/business/proxy/context')).data;
 for(const q of ['创建每天日报规则','把 E310 调课到 E312',`查询 ${fixture.date} 的课表并调课到 E312`]){const out=await a.call('/api/conversations/'+c.data.id+'/messages',{message:q,clientRequestId:crypto.randomUUID()});const done=out.data.events.find((e:any)=>e.type==='run_completed');assert.ok(done,JSON.stringify(out.data));assert.match(done.payload.answer,/任务模式/);assert.ok(out.data.events.every((e:any)=>!e.payload?.result?.plan));}
 const after=(await a.call('/api/business/proxy/context')).data;assert.equal(after.plans.length,before.plans.length);assert.deepEqual(after.adjustments,before.adjustments);
 const forbidden=await a.call('/api/business/proxy/scheduled-jobs/preview',{conversationId:c.data.id,spec:{kind:'daily_report',trigger:{type:'daily',time:'20:30'}}});assert.equal(forbidden.status,403);assert.equal(forbidden.data.code,'mode_forbidden');
});
test('A11 历史业务计划切换为聊天后，即使省略会话字段也不能提交',async()=>{
 const a=await login(),c=await a.call('/api/conversations',{mode:'task'});const preview=await a.call('/api/business/proxy/workflow/preview',{conversationId:c.data.id,kind:'issue.create',roomId:'fixture-e310',description:'回放边界验证'});assert.equal(preview.status,200);await a.call('/api/conversations/'+c.data.id,{mode:'chat'},'PATCH');const commit=await a.call('/api/business/proxy/plans/commit',{planId:preview.data.plan.id,version:1});assert.equal(commit.status,403);assert.equal(commit.data.code,'mode_forbidden');
 const other=await a.call('/api/conversations',{mode:'task'});assert.equal((await a.call('/api/business/proxy/plans/commit',{planId:preview.data.plan.id,version:1,conversationId:other.data.id})).status,403);
});
test('A12/27 自然语言只准备定时草案，历史规则不能借其他任务会话越过聊天限制',async()=>{
 const a=await login(),c=await a.call('/api/conversations',{mode:'task'}),before=(await a.call('/api/business/proxy/scheduled-jobs')).data.jobs.length;
 const out=await a.call('/api/conversations/'+c.data.id+'/messages',{message:'设置每天20:30的日报定时规则',clientRequestId:crypto.randomUUID()});const done=out.data.events.find((e:any)=>e.type==='run_completed');assert.ok(done);assert.equal((await a.call('/api/business/proxy/scheduled-jobs')).data.jobs.length,before);
 // A8（2026-10-31 用户要求）：模式可切换——但调度方案的安全属性不依赖锁定：
 // prepare 时方案绑定在 task 会话上，会话翻成 chat 后方案照样不可提交（下方 flip 验证）
 const flipped=await a.call('/api/conversations/'+c.data.id,{mode:'chat'},'PATCH');assert.equal(flipped.status,200);assert.equal((await a.call('/api/conversations/'+c.data.id)).data.mode,'chat');
 await a.call('/api/conversations/'+c.data.id,{mode:'task'},'PATCH');
 // 方案所属会话仍是 task —— 但用一个"还没开始对话"的会话准备方案后把它改成 chat，该方案必须不可提交
 const flip=await a.call('/api/conversations',{mode:'task'});
 const preview=await a.call('/api/business/proxy/scheduled-jobs/preview',{conversationId:flip.data.id,spec:{kind:'daily_report',trigger:{type:'daily',time:'20:30'}}});assert.equal(preview.status,200);assert.equal(preview.data.plan.futureOccurrences.length,3);
 assert.equal((await a.call('/api/conversations/'+flip.data.id,{mode:'chat'},'PATCH')).status,200);
 assert.equal((await a.call('/api/business/proxy/scheduled-jobs/confirm',{planId:preview.data.plan.id})).status,403);
 const other=await a.call('/api/conversations',{mode:'task'});assert.equal((await a.call('/api/business/proxy/scheduled-jobs/confirm',{planId:preview.data.plan.id,conversationId:other.data.id})).status,403);assert.equal((await a.call('/api/business/proxy/scheduled-jobs')).data.jobs.length,before);
});
test('U09 旧demo会话绑定的原系统任务，真实账号重新准备后可安全接续',async()=>{
 const source=await main(),old=await source('/api/integration/workflow/preview',{conversationId:'old-demo-conversation',kind:'issue.create',roomId:'fixture-e310',description:'旧任务接续隔离测试'});assert.equal(old.status,200);
 const a=await login();assert.equal((await a.call('/api/business/proxy/plans/commit',{planId:old.data.plan.id,version:1})).status,403);
 const c=await a.call('/api/conversations',{mode:'task'}),fresh=await a.call('/api/business/proxy/workflow/preview',{taskId:old.data.task.id,conversationId:c.data.id,kind:'issue.create',roomId:'fixture-e310',description:'旧任务接续隔离测试'});assert.equal(fresh.status,200);assert.equal(fresh.data.task.id,old.data.task.id);assert.equal(fresh.data.task.conversationId,c.data.id);assert.ok(fresh.data.task.history.some((h:any)=>h.action==='conversation_rebound'));
 const replay=await a.call('/api/business/proxy/plans/commit',{planId:old.data.plan.id,version:1});assert.equal(replay.status,409);assert.equal((await a.call('/api/business/proxy/plans/commit',{planId:fresh.data.plan.id,version:1})).status,200);
});
test('Y05 会话密钥损坏可追踪且仍能退出，不返回内部解密错误',async()=>{
 const a=await login(),sid=a.cookie.split('=')[1]!,digest=crypto.createHash('sha256').update(sid).digest('hex'),db=getDb();db.prepare('UPDATE native_auth_sessions SET credential=? WHERE tokenHash=?').run('enc:v1:corrupt',digest);
 const read=await a.call('/api/conversations');assert.equal(read.status,401);assert.match(read.data.message,/无法解密/);assert.ok(read.headers.get('X-Request-ID'));
 const logout=await a.call('/api/auth/logout',{});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie')!,/Max-Age=0/);assert.equal(db.prepare('SELECT tokenHash FROM native_auth_sessions WHERE tokenHash=?').get(digest),undefined);
});
test('A06 上游停机不会改用演示快照，错误保持可追踪',async()=>{
 const a=await login(),old=process.env.LABOPS_BUSINESS_URL;try{process.env.LABOPS_BUSINESS_URL='http://127.0.0.1:1';const r=await a.call('/api/state');assert.equal(r.status,502);assert.ok(r.headers.get('X-Request-ID'));assert.ok(!r.data.sourceType);}finally{process.env.LABOPS_BUSINESS_URL=old;}
});
test('Y06 user通知仅本人可见并可标记已读，其他志愿者不可见',async()=>{
 // ⚠️ 2026-10-05：原用例名含"其他学生"，学生身份部分**注释保留**（学生已不能登录 LabOps）。
 //    原：const a=await login(),vol=await login('volunteer'),student=await login('student');
 //    原（行内）：…assert.ok(!(await student.call('/api/business/proxy/context')).data.notifications.some(…));
 const a=await login(),vol=await login('volunteer');const n=await a.call('/api/business/proxy/notifications',{requestId:crypto.randomUUID(),title:'个人通知验证',content:'仅本人可见',audience:{kind:'user',userId:'review-volunteer'}});assert.equal(n.status,200);assert.ok((await vol.call('/api/business/proxy/context')).data.notifications.some((x:any)=>x.id===n.data.notification.id));assert.equal((await vol.call('/api/business/proxy/notifications/read',{id:n.data.notification.id})).status,200);
});
test('Y15 业务附件绑定权限、内容签名和版本资料检索接口有效',async()=>{
 const a=await login();/* ⚠️ 2026-10-05 学生身份注释保留（学生已不能登录 LabOps）：,s=await login('student'); */const bytes=Buffer.from('设备铭牌人工记录\n'.repeat(2000));const upload=await a.call('/api/business/proxy/evidence/attachments',{targetKind:'room',targetId:'fixture-e310',fileName:'nameplate.txt',mimeType:'text/plain',dataBase64:bytes.toString('base64')});assert.equal(upload.status,200);assert.equal(upload.data.attachment.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));const attachment=await a.call('/api/business/proxy/evidence/attachments/'+upload.data.attachment.id);assert.equal(attachment.data.dataBase64,bytes.toString('base64'));/* ⚠️ 2026-10-05 学生断言注释保留：assert.equal((await s.call('/api/business/proxy/evidence/attachments/'+upload.data.attachment.id)).status,404); */const list=await a.call('/api/business/proxy/evidence/attachments?targetKind=room&targetId=fixture-e310');assert.equal(list.data.attachments.length,1);
 const manual=await a.call('/api/business/proxy/evidence/manuals',{title:'隔离示例资料',device:'fixture-projector',version:'1',sourceUrl:'https://example.com/manufacturer-test',visibility:'staff',reviewed:true,paragraphs:[{id:'2.1',text:'虚构测试段落，不作为真实维修规范。'}]});assert.equal(manual.status,200);/* ⚠️ 2026-10-05 学生断言注释保留：assert.equal((await s.call('/api/business/proxy/evidence/manuals')).data.manuals.length,0); */const staff=await login('volunteer');const read=await staff.call('/api/business/proxy/evidence/manuals?q='+encodeURIComponent('测试段落'));assert.equal(read.data.manuals.length,1);assert.equal(read.data.manuals[0].paragraphs[0].id,'2.1');assert.equal(read.data.manuals[0].version,'1');
});
test('Y13 工单截止策略先预览后确认，只修改 dueAt 与审计',async()=>{
 const a=await login();const draft=await a.call('/api/business/proxy/workflow/preview',{kind:'issue.create',roomId:'fixture-e310',description:'截止策略隔离测试'}),made=await a.call('/api/business/proxy/plans/commit',{planId:draft.data.plan.id,version:1});assert.equal(made.status,200);const c=(await a.call('/api/business/proxy/context')).data,i=c.issues.find((x:any)=>x.description==='截止策略隔离测试');const preview=await a.call('/api/business/proxy/workflow/preview',{kind:'issue.deadline',issueId:i.id,expectedRevision:i.revision,dueAt:new Date(Date.now()+3600000).toISOString(),note:'人工明确截止'});assert.equal(preview.status,200);assert.equal((await a.call('/api/business/proxy/plans/commit',{planId:preview.data.plan.id,version:1})).status,200);const updated=(await a.call('/api/business/proxy/context')).data.issues.find((x:any)=>x.id===i.id);assert.ok(updated.dueAt);assert.equal(updated.status,'open');assert.equal(updated.history.at(-1).action,'deadline');
});
test('Y14 双端诊断区分进程、连接、真实授权与配套版本',async()=>{const a=await login();const r=await a.call('/api/business/proxy/diagnostics');assert.equal(r.status,200);
 // 版本号随发布节奏变化（1.0.5.0→1.0.5.1）——断言改读版本模块，不再硬编码
 const require2=createRequire(import.meta.url);
 assert.equal(r.data.version,require2('../../Pages/server/version.js').version);
 assert.ok(r.data.agentVersion,'agentVersion 必须有值');assert.equal(r.data.agentReachable,true);assert.equal(r.data.authorized,true);assert.ok(r.data.scheduler);});
test('U07 账号角色变化隐藏旧范围历史，停用后所有保护 API 拒绝访问',async()=>{
 const a=await login(),c=await a.call('/api/conversations',{mode:'chat'}),file=path.join(temporary,'native','credentials.json'),creds=JSON.parse(fs.readFileSync(file,'utf8'));
 try{creds['review-admin'].identity='student';fs.writeFileSync(file,JSON.stringify(creds));
  // 2026-10-05：学生身份不再被 LabOps 接受 → 账号一经变为学生，原会话**直接失效（403）**，
  //            比原先"降级后仍持会话、只是范围受限"更严。原断言注释保留（恢复见 U02 顶部说明）：
  //            assert.equal((await a.call('/api/conversations/'+c.data.id)).status,404);
  //            assert.equal((await a.call('/api/business/proxy/context')).data.actor.identity,'student');
  assert.equal((await a.call('/api/conversations/'+c.data.id)).status,403);
  assert.equal((await a.call('/api/business/proxy/context')).status,403);
  creds['review-admin'].status='disabled';fs.writeFileSync(file,JSON.stringify(creds));assert.equal((await a.call('/api/state')).status,401);}finally{creds['review-admin'].identity='admin';creds['review-admin'].status='active';fs.writeFileSync(file,JSON.stringify(creds));}
});
after(async()=>{agent.closeAllConnections();await new Promise<void>(r=>agent.close(()=>r()));getDb().close();native.kill('SIGTERM');if(native.exitCode===null&&native.signalCode===null)await new Promise<void>(r=>native.once('exit',()=>r()));fs.rmSync(temporary,{recursive:true,force:true});});
