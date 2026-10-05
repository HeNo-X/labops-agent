// Legacy regression fixture explicitly uses the isolated demo workspaces.
process.env.LABOPS_AUTH_MODE='demo';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { SandboxActor, Proposal } from '../shared/operations-contract.ts';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labops-reliability-'));
process.env.LABOPS_DB_PATH=path.join(temp,'test.sqlite');
process.env.AGNES_API_KEY='';
const db=await import('../server/persistence/db.ts');
const {executeTool,toolsForMode}=await import('../server/tools/registry.ts');
const {decideOnProposal}=await import('../server/operations/executor.ts');
const {loadDataset}=await import('../server/data/store.ts');
const {serverNow}=await import('../server/time/term.ts');
const {requestIdentity}=await import('../server/security/context.ts');
const {saveFacts,readFacts,scheduleTable}=await import('../server/agent/facts.ts');
const {runQuerySchedule}=await import('../server/tools/query-schedule.ts');
const {runQueryFreeRooms}=await import('../server/tools/query-free-rooms.ts');
const {handleRequest}=await import('../server/index.ts');
const {withHttpIdentity}=await import('../server/security/http.ts');
const alice:SandboxActor={id:'a',role:'admin',label:'A'},bob:SandboxActor={id:'b',role:'admin',label:'B'};
const ds=loadDataset(),now=serverNow(new Date('2026-10-04T09:00:00Z'));
async function proposal(actor=alice):Promise<Proposal>{
  const r=await executeTool('prepare_issue_ticket',{roomId:'E310',category:'equipment',description:'投影机无图像'},{dataset:ds,now,actor});
  assert.ok(r.ok&&r.resultKind==='operation_proposal');return r.result;
}
const decision=(p:Proposal,actor=alice,key=crypto.randomUUID())=>({taskId:p.taskId,proposalId:p.proposalId,proposalVersion:p.version,decision:'confirm' as const,clientRequestId:key,actor});
const counts=()=>['biz_issues','ops_decisions','ops_operations','ops_audit','ops_proposal_commits'].map(t=>Number((db.getDb().prepare('SELECT count(*) AS n FROM '+t).get() as {n:number}).n));

test('错任务、同角色跨创建者、旧版本、过期均零业务和决策副作用',async()=>{
  const p=await proposal();const before=counts();
  for(const changes of [{taskId:'wrong'},{actor:bob},{proposalVersion:999}])assert.equal(decideOnProposal({...decision(p),...changes}).ok,false);
  db.getDb().prepare('UPDATE ops_proposals SET expiresAt=? WHERE id=?').run('2000-01-01T00:00:00Z',p.proposalId);
  const outcome=decideOnProposal(decision(p));assert.equal(outcome.ok,false);assert.deepEqual(counts(),before);
});
test('回执故障回滚业务、审计、决策与终态，换键重试仍只执行一次',async()=>{
  const p=await proposal(),before=counts();
  db.getDb().exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON ops_operations BEGIN SELECT RAISE(ABORT,'injected disk failure'); END");
  assert.equal(decideOnProposal(decision(p)).ok,false);
  assert.deepEqual(counts(),before);assert.equal(db.getOpsProposal(p.proposalId)?.proposal.state,'awaiting_confirmation');
  db.getDb().exec('DROP TRIGGER fail_receipt');
  const first=decideOnProposal(decision(p));assert.ok(first.ok&&first.decision==='confirm');
  const replay=decideOnProposal(decision(p));assert.ok(replay.ok&&replay.decision==='confirm');
  assert.equal(replay.receipt.operationId,first.receipt.operationId);assert.equal(counts()[0],before[0]!+1);
});
test('成功后的重放不能绕过 actor、版本或决定的校验',async()=>{
  const p=await proposal(),request=decision(p);assert.ok(decideOnProposal(request).ok);
  for(const changes of [{actor:bob},{proposalVersion:999},{decision:'reject' as const}])assert.equal(decideOnProposal({...request,...changes}).ok,false);
});
test('跨提案复用请求键被拒绝，拒绝操作可以无副作用重放',async()=>{
  const p=await proposal(),q=await proposal(),request={...decision(p),decision:'reject' as const};
  assert.ok(decideOnProposal(request).ok);assert.ok(decideOnProposal(request).ok);
  assert.equal(decideOnProposal({...decision(q),clientRequestId:request.clientRequestId}).ok,false);
});
test('聊天模式声明和执行同一白名单，恶意 prepare 调用被拒绝',async()=>{
  assert.ok(toolsForMode('chat').some(t=>t.name==='query_schedule'));
  assert.ok(toolsForMode('chat').every(t=>!t.name.startsWith('prepare_')));
  const before=db.listOpsTasks().length;
  const r=await executeTool('prepare_issue_ticket',{roomId:'E310',category:'equipment',description:'故障'},{dataset:ds,now,actor:alice,mode:'chat'});
  assert.equal(r.ok,false);assert.equal(db.listOpsTasks().length,before);
});
test('8条课表改两列保留全部名称和顺序，事实缓存按本人隔离',()=>{
  const result=runQuerySchedule({labName:'E310',date:'2026-09-28'},ds,now);
  assert.equal(result.lessons.length,8);
  saveFacts('alice','session',{ok:true,resultKind:'schedule',result,summary:'fixture'});
  assert.equal(readFacts('bob','session'),null);
  const text=scheduleTable(result);assert.equal(text.split('\n').filter(l=>l.startsWith('|')).length,10);
  for(const lesson of result.lessons)assert.ok(text.includes(lesson.courseName));
  assert.ok(!text.includes('数据结构与算法'));assert.ok(!text.includes('数据库原理'));
});
test('沙盒停用覆盖只影响所属用户的可用房间，不能串租户',async()=>{
  const complete={...ds,term:{...ds.term,termEnd:'2027-01-31'}};
  const date='2026-10-06';
  await requestIdentity.run(alice,async()=>{
    const r=await executeTool('prepare_room_closure',{roomId:'E310',startDate:date,endDate:date,periodKeys:['am1'],reason:'检修',createIssue:false},{dataset:complete,now,actor:alice});
    assert.ok(r.ok&&r.resultKind==='operation_proposal');assert.ok(decideOnProposal(decision(r.result)).ok);
    const free=runQueryFreeRooms({date,periodKey:'am1'},complete,now);
    assert.ok(free.freeByPeriod.every(p=>p.rooms.every(room=>room.labName!=='E310')));
  });
  const other=requestIdentity.run(bob,()=>runQueryFreeRooms({date,periodKey:'am1'},complete,now));
  assert.ok(other.notes.every(n=>!n.includes('沙盒停用记录')));
});
test('日报只汇总当前创建者的数据，业务总数不受200条列表截断',async()=>{
  const before=db.listBizIssues({actorId:bob.id}).length;
  for(let i=0;i<205;i++)db.insertBizIssue({roomId:'E310',category:'other',description:'fixture-'+i,actor:bob,attachmentRefs:[]});
  const r=await executeTool('create_operations_report',{startDate:now.date,sections:['issues']},{dataset:ds,now,actor:bob});
  assert.ok(r.ok&&r.resultKind==='operations_report');
  assert.equal(r.result.metrics.find(m=>m.key==='issues_open')?.value,before+205);
});
test('两个真实HTTP浏览器会话不能读取、更改、删除、取消彼此对象',async()=>{
  const server=http.createServer((req,res)=>{withHttpIdentity(req,res,()=>handleRequest(req,res)).catch(()=>{res.writeHead(500);res.end();});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const call=(url:string,cookie='',method='GET',body?:unknown)=>fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try{
    const ar=await call('/api/capabilities'),br=await call('/api/capabilities');
    const aCookie=ar.headers.get('set-cookie')!.split(';')[0]!,bCookie=br.headers.get('set-cookie')!.split(';')[0]!;
    const av=await ar.json() as {actor:SandboxActor},bv=await br.json() as {actor:SandboxActor};assert.notEqual(av.actor.id,bv.actor.id);
    const created=await (await call('/api/conversations',aCookie,'POST',{title:'private'})).json() as {id:string};
    const own=await call('/api/conversations/'+created.id,aCookie);assert.equal(own.status,200);
    for(const method of ['GET','PATCH','DELETE'])assert.equal((await call('/api/conversations/'+created.id,bCookie,method,method==='PATCH'?{title:'hacked'}:undefined)).status,404);
    const list=await (await call('/api/conversations',bCookie)).json() as {conversations:unknown[]};assert.equal(list.conversations.length,0);
    const p=await proposal(av.actor);assert.equal((await call('/api/proposals/'+p.proposalId,bCookie)).status,404);
    const before=counts();assert.equal((await call('/api/tasks/wrong/decisions',aCookie,'POST',decision(p,av.actor))).status,400);assert.deepEqual(counts(),before);
    const run=db.createMessageWithRun(created.id,'hello','private-request','private-run');assert.ok(!('duplicate'in run));
    assert.equal((await call('/api/runs/private-run/cancel',bCookie,'POST',{})).status,404);
    assert.equal((await call('/api/runs/private-run',bCookie)).status,404);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
after(()=>{db.getDb().close();fs.rmSync(temp,{recursive:true,force:true});});
