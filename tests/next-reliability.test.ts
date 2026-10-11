// Legacy regression fixture explicitly uses the isolated demo workspaces.
process.env.LABOPS_AUTH_MODE='demo';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@shared/'))return next(new URL('../shared/'+specifier.slice(8)+'.ts',import.meta.url).href,context);if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);return next(specifier,context);}});
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labops-next-'));process.env.LABOPS_DB_PATH=path.join(temp,'agent.sqlite');process.env.AGNES_API_KEY='';
const {runAgent}=await import('../server/agent/run.ts');
const {loadDataset,buildFromSnapshotLike}=await import('../server/data/store.ts');
const {runQuerySchedule}=await import('../server/tools/query-schedule.ts');
const {runQueryFreeRooms}=await import('../server/tools/query-free-rooms.ts');
const {saveFacts,listFacts,transformSchedule}=await import('../server/agent/facts.ts');
const {serverNow}=await import('../server/time/term.ts');
const {getDb}=await import('../server/persistence/db.ts');
const {handleRequest}=await import('../server/index.ts');const {withHttpIdentity}=await import('../server/security/http.ts');
Object.assign(globalThis,{window:{setInterval,clearInterval}});
const {createPinia,setActivePinia}=await import('pinia');const {useRunStore}=await import('../web/stores/run.ts');
const {verifiedRecommendation,planNativeDialogue}=await import('../server/tools/business.ts');
const {rememberBusinessTask}=await import('../server/business/bridge.ts');
const {readDraft,writeDraft,selectedDraftEntity}=await import('../web/business/drafts.ts');
test('S03-01 班次草稿隔离、所选实体与字段保存，过期/版本变化须显式恢复',()=>{
 const map=new Map<string,string>(),storage={getItem:(k:string)=>map.get(k)||null,setItem:(k:string,v:string)=>{map.set(k,v);}},base={schemaVersion:2 as const,scopeKey:'scope',cardId:'card',taskId:'task-A',view:'duty' as const,revision:1,savedAt:new Date().toISOString()};
 writeDraft(storage,{...base,entityId:'shift-A',fields:{shiftId:'shift-A',note:'A事项',checklist:[{key:'keys',state:'done'}]}});writeDraft(storage,{...base,entityId:'shift-B',fields:{shiftId:'shift-B',note:'B事项',checklist:[{key:'keys',state:'unchecked'}]}});assert.equal(selectedDraftEntity(storage,'scope','card'),'shift-B');assert.equal(readDraft(storage,'scope','card','shift-A',1).draft?.fields['note'],'A事项');assert.equal(readDraft(storage,'scope','card','shift-B',1).draft?.fields['shiftId'],'shift-B');assert.equal(readDraft(storage,'other','card','shift-B',1).draft,null);assert.ok(readDraft(storage,'scope','card','shift-B',2).warning.includes('版本'));assert.equal(readDraft(storage,'scope','card','shift-B',1,Date.now()+8*86400000).draft,null);
});
const actor={id:'next-owner',role:'admin' as const,label:'next'},ds=loadDataset(),now=serverNow();
test('X08 新请求含多门课时不借用旧任务原课程，不重算/作废未确认任务',()=>{
 const session='independent-task';const source=ds.timetable.find(r=>r.labId===ds.labs.find(l=>l.name==='E310')?.id)!;
 rememberBusinessTask(session,{view:'schedule',date:'2026-09-28',sourceLesson:source,plan:{id:'old-plan'},candidates:[]});const routed=planNativeDialogue('调课E310在2026-09-28的课程，比较替代方案',{dataset:ds,now,actor,conversationId:session,mode:'task'});assert.equal(routed?.tool,'query_business_context');assert.equal(routed?.args['view'],'schedule');
});
async function run(q:string,s='next-query'){const events=[];for await(const e of runAgent({question:q,sessionId:s,actor}))events.push(e);return events;}
function answer(events:Awaited<ReturnType<typeof run>>){const p=events.find(e=>e.type==='run_completed')?.payload as {answer:string}|undefined;assert.ok(p,JSON.stringify(events.at(-1)));return p.answer;}
test('V03-01 完整课程名称、引号和短别名正确筛选，无法解析明确失败',async()=>{
 const session='course-name-fix';await run('查询E310在2026-09-28的课表',session);
 for(const q of ['把刚才课表改成两列表格，只保留课程名称等于计算机网络原理的课程，改为两列表格','把刚才课表改成两列表格，只保留课程名为“计算机网络原理”的课程，改为两列表格','把刚才课表改成两列表格，只保留课程名称为「计算机网络原理」的课程，改为两列表格']){
  const events=await run(q,session);assert.equal(events.filter(e=>e.type==='tool_started').length,0);assert.ok(answer(events).includes('筛选后 3 条记录'),answer(events));assert.ok(answer(events).includes('实际筛选条件'));
 }
 const invalid=await run('把刚才课表改成两列表格，只保留课程名称等于，改为两列表格',session);assert.ok(invalid.some(e=>e.type==='run_failed'));assert.ok(!invalid.some(e=>e.type==='run_completed'));
});
test('V03-02 改房间并要求缺失列：重查事实保留，但转换失败不得报告泛化成功',async()=>{
 const session='requery-missing-column';await run('查询E310在2026-09-28的课表',session);const events=await run('把刚才课表改成两列表格，改查E312同日，列为课程和学分',session);
 assert.equal(events.filter(e=>e.type==='tool_started').length,1);assert.ok(events.some(e=>e.type==='run_failed'));assert.ok(events.every(e=>e.type!=='run_completed'));assert.ok(events.filter(e=>e.type==='answer_delta').map(e=>(e.payload as {text:string}).text).join('').includes('学分'));assert.ok(listFacts(actor.id,session).some(f=>(f.fact.result as any).labName==='E312'));
});
test('R01 改房间后重查对象；R02 历史课表只保留下午2条，不能忽略条件',async()=>{
 await run('查询E310在2026-09-28的课表');const filtered=await run('把刚才结果改成两列表格，只保留下午的课程');assert.equal(filtered.filter(e=>e.type==='tool_started').length,0);assert.equal(answer(filtered).split('\n').filter(l=>l.startsWith('|')).length,4);
 const changed=await run('把刚才结果改成两列表格，但改查E312在同日的课表');assert.equal(changed.filter(e=>e.type==='tool_started').length,1);assert.ok(answer(changed).startsWith('E312'));assert.ok(!answer(changed).includes('保留原结果全部 8 条'));
});
test('历史换日期和扩展节次必须重查；指定列、去重和汇总由已验证字段计算',async()=>{
 await run('查询E310在2026-09-28的课表','next-fields');const changed=await run('把刚才结果改成两列表格，但改查2026-09-29的课表','next-fields');assert.equal(changed.filter(e=>e.type==='tool_started').length,1);assert.ok(answer(changed).includes('2026-09-29'));
 await run('查询E310在2026-09-28下午第一大节的课表','next-period');const expanded=await run('把刚才课表改成两列表格，只看上午','next-period');assert.equal(expanded.filter(e=>e.type==='tool_started').length,1);assert.ok(!answer(expanded).includes('下午第一大节） |'));
 await run('查询E310在2026-09-28的课表','next-columns');const col=answer(await run('把刚才课表改成表格，只列课程和班级并去重','next-columns'));assert.ok(col.includes('| 课程 | 班级 |'));assert.ok(col.includes('去重后'));
 assert.ok(answer(await run('把上次课表汇总','next-columns')).includes('8 条班级展开记录'));
 const rejected=await run('把上次课表改成表格，列课程和学分','next-columns');assert.ok(rejected.some(e=>e.type==='run_failed'));
});
test('R03 状态/知识查询不覆盖课表事实，可以按事实编号或前一次选择',async()=>{
 await run('查询E310在2026-09-28的课表','next-history');const first=listFacts(actor.id,'next-history').find(f=>f.fact.resultKind==='schedule')!;
 await run('查询E310现在状态','next-history');await run('交接操作说明','next-history');assert.ok(answer(await run('把上次课表结果改成两列表格','next-history')).includes('全部 8 条'));
 await run('查询E312在2026-09-28的课表','next-history');assert.ok(answer(await run('把前一次课表改成两列表格','next-history')).startsWith('E310'));
 assert.ok(answer(await run(`把 ${first.factId} 改成两列表格`,'next-history')).startsWith('E310'));
});
test('事实最新查询不得复用旧数据，事实集按身份和授权代次隔离',async()=>{
 const historical=runQuerySchedule({date:'2026-09-28',labName:'E310'},ds,now);saveFacts(actor.id,'next-scope',{ok:true,resultKind:'schedule',result:historical,summary:'x'});
 assert.equal(transformSchedule('把刚才课表改成两列，重新查询最新安排',actor.id,'next-scope',now).kind,'query');
 assert.equal(transformSchedule('把刚才课表改成两列','other-owner','next-scope',now).kind,'error');
 getDb().prepare("INSERT INTO business_generations VALUES (?,1,'disconnected') ON CONFLICT(ownerId) DO UPDATE SET generation=generation+1").run(actor.id);
 assert.equal(transformSchedule('把刚才课表改成两列',actor.id,'next-scope',now).kind,'error');
});
test('R04 原系统停用覆盖全天/部分节次/跨日/撤销/稳定ID，不混入沙盒',()=>{
 const data=buildFromSnapshotLike({term:{term:'test',termStart:'2026-09-07',termEnd:'2027-01-31'},labs:[{id:'stable-b',name:'E312',status:'active',capacity:60}],openLabs:[],timetable:[{id:'x',weekday:1,term:'test',labName:'Other',periodKey:'pm1',weeks:{from:1,to:20}}],roomClosures:[{id:'c',roomId:'stable-b',startDate:'2026-09-28',endDate:'2026-09-30',periodKeys:['am1'],status:'active'}],revision:'v1'},'live','');
 assert.equal(runQueryFreeRooms({date:'2026-09-28',periodKey:'am1'},data,now).freeByPeriod[0]!.rooms.length,0);
 assert.equal(runQueryFreeRooms({date:'2026-09-29',periodKey:'am2'},data,now).freeByPeriod[0]!.rooms.length,1);
 data.roomClosures![0]!.periodKeys=[];assert.equal(runQueryFreeRooms({date:'2026-09-29',periodKey:'pm1'},data,now).freeByPeriod[0]!.rooms.length,0);
 data.roomClosures![0]!.status='revoked';assert.equal(runQueryFreeRooms({date:'2026-09-29',periodKey:'pm1'},data,now).freeByPeriod[0]!.rooms.length,1);
});
const server=http.createServer((req,res)=>{withHttpIdentity(req,res,()=>handleRequest(req,res)).catch(e=>{res.writeHead(500);res.end(String(e));});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function stream(fail=false){const init=await fetch(base+'/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'task',title:'SSE test'})});const cookie=init.headers.get('set-cookie')!.split(';')[0]!;const conv=await init.json() as {id:string};if(fail)getDb().exec("CREATE TEMP TRIGGER inject_finalize BEFORE UPDATE OF status ON messages WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture durable failure'); END");try{const response=await fetch(base+`/api/conversations/${conv.id}/messages`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({message:'你好',clientRequestId:crypto.randomUUID()})});const text=await response.text();return text.split('\n\n').map(s=>s.split('\n').find(l=>l.startsWith('data: '))).filter(Boolean).map(s=>JSON.parse(s!.slice(6)));}finally{if(fail)getDb().exec('DROP TRIGGER inject_finalize');}}
test('R07 正常HTTP SSE只有一个durable成功终态，失败事件不重复',async()=>{const events=await stream();const completed=events.filter(e=>e.type==='run_completed');assert.equal(completed.length,1);assert.equal(completed[0].payload.durable,true);assert.equal(events.at(-1).payload.saved,true);assert.ok(events.findIndex(e=>e.type==='run_completed')>events.findIndex(e=>e.type==='answer_delta'));});
test('R07 终态落库故障无成功声明，实际Pinia仓库呈现失败并保留正文；取消优先',async()=>{const events=await stream(true);assert.equal(events.filter(e=>e.type==='run_completed').length,0);assert.equal(events.filter(e=>e.type==='save_failed').length,1);assert.equal(events.at(-1).payload.saved,false);setActivePinia(createPinia());const store=useRunStore();store.beginRun('你好');store.adoptRunId(events[0].runId);for(const e of events)store.ingest(e);assert.equal(store.runStatus,'failed');assert.equal(store.error?.code,'save_failed');assert.ok(store.stream.includes('实验室工作助手'));store.finishRun();
 store.beginRun('cancel');store.cancelRun();store.ingest({v:1,seq:1,runId:store.runId!,type:'save_failed',ts:new Date().toISOString(),payload:{message:'fail'}});assert.equal(store.runStatus,'cancelled');store.finishRun();});
test('HTTP显式取消只发一次取消终态，保存与实际Pinia状态一致',async()=>{
 const init=await fetch(base+'/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'task',title:'cancel-test'})});
 const cookie=init.headers.get('set-cookie')!.split(';')[0]!,conv=await init.json() as {id:string};
 const response=await fetch(base+`/api/conversations/${conv.id}/messages`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({message:'查询E310在2026-09-28的课表',clientRequestId:crypto.randomUUID()})});
 const reader=response.body!.getReader(),decoder=new TextDecoder();let body='';
 while(!body.includes('\n\n')){const chunk=await reader.read();assert.equal(chunk.done,false);body+=decoder.decode(chunk.value,{stream:true});}
 const accepted=JSON.parse(body.split('\n').find(l=>l.startsWith('data: '))!.slice(6));
 const cancelled=await fetch(base+`/api/runs/${accepted.runId}/cancel`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(cancelled.status,200);
 for(;;){const chunk=await reader.read();if(chunk.done)break;body+=decoder.decode(chunk.value,{stream:true});}
 const events=body.split('\n\n').map(s=>s.split('\n').find(l=>l.startsWith('data: '))).filter(Boolean).map(s=>JSON.parse(s!.slice(6)));
 assert.equal(events.filter(e=>e.type==='run_completed'||e.type==='run_failed').length,0);assert.equal(events.filter(e=>e.type==='run_cancelled').length,1);assert.equal(events.at(-1).payload.status,'cancelled');assert.equal(events.at(-1).payload.saved,true);
 const history=await (await fetch(base+'/api/conversations/'+conv.id,{headers:{Cookie:cookie}})).json() as {messages:Array<{status:string}>};assert.equal(history.messages.at(-1)!.status,'cancelled');
 setActivePinia(createPinia());const store=useRunStore();store.beginRun('cancel');store.adoptRunId(accepted.runId);for(const e of events)store.ingest(e);store.finishRun();assert.equal(store.runStatus,'cancelled');assert.equal(store.error,null);
});
test('模型推荐必须引用同版本可行候选，错误人数/房间/引用回退',()=>{
 const facts=[{summary:'test',planId:null,sourceRevision:'v1',candidates:[{roomId:'b',roomName:'E312',periodKey:'pm1',capacity:60,headcount:30,requiredEquipment:[],reasons:[],eligible:true}],source:'test',workbenchUrl:''}];
 saveFacts(actor.id,'business-revision',{ok:true,resultKind:'business_plan',summary:'test',result:facts[0]!});assert.equal(listFacts(actor.id,'business-revision')[0]!.sourceRevision,'v1');
 const good={recommendations:[{candidateId:'b:pm1',capacity:60,headcount:30,reasonCodes:['capacity','conflict_free'],evidenceRefs:['snapshot:v1']}]};assert.ok(verifiedRecommendation(JSON.stringify(good),facts)?.includes('30 人 / 容量 60'));
 for(const change of [{candidateId:'made-up'},{headcount:10},{evidenceRefs:['snapshot:v0']},{reasonCodes:['invented']}])assert.equal(verifiedRecommendation(JSON.stringify({recommendations:[{...good.recommendations[0],...change}]}),facts),null);
});
after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));getDb().close();fs.rmSync(temp,{recursive:true,force:true});});
