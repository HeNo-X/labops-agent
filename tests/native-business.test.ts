import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.TZ='Asia/Shanghai';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qizhen-business-'));process.env.DATA_DIR=temp;
const require=createRequire(import.meta.url);
const {dispatch}=require('../../Pages/server/operations.js');
const calendar=require('../../Pages/lib/calendar.js');
const {LabSched,LabTime}=require('../../Pages/lib/lab-time.js');
const nativeDb=require('../../Pages/lib/db.js');
const {retrieve}=await import('../server/tools/knowledge.ts');
// Deliberately invented, isolated fixture. Never migrates into deployed data.
const admin={username:'fixture-admin',identity:'admin'},vol={username:'fixture-vol',identity:'volunteer'},student={username:'fixture-student',identity:'student',className:'Fixture A'};
const now=new Date('2026-10-05T15:30:00+08:00');
function fixture(){return {
  sysConfig:{term:'fixture',termStart:'2026-09-07',termEnd:'2027-01-31',holidays:[],specialDays:[]},
  labs:[{id:'a',name:'E310',capacity:60,status:'active',equipment:['projector']},{id:'b',name:'E312',capacity:60,status:'active',equipment:['projector']}],openLabs:[],
  timetable:[{id:'t',labId:'a',labName:'E310',className:'Fixture A',classNames:['Fixture A'],courseId:'c',courseName:'Fixture Course',teacher:'Fixture Teacher',term:'fixture',weekday:1,periodKey:'pm1',status:'normal',weeks:{from:1,to:20,parity:'all'}}],
  courses:[{id:'c',name:'Fixture Course',requiredEquipment:['projector']}],classes:[{id:'class-a',name:'Fixture A',size:30}],classRoster:[],
  users:[admin,vol,student].map(u=>({...u})),scheduleAdjust:[],dutyShifts:[{id:'shift-fixture',date:'2026-10-05',roomId:'a',roomName:'E310',periodKey:'pm1',userId:'fixture-vol'}],notifications:[]
};}
function harness(){let state:any=fixture();let fail=false;return {get state(){return state;},setFail:(v:boolean)=>{fail=v;},call:(path:string,body?:unknown,actor=admin)=>dispatch({method:body===undefined?'GET':'POST',path,body,actor,state,now,commit:(next:any)=>{if(fail)throw new Error('injected durable write failure');state=next;}})};}
const draft={date:'2026-10-05',timetableId:'t',toLabId:'b',toPeriodKey:'pm1',reason:'Fixture projector outage'};
function incident(h:ReturnType<typeof harness>,periodKeys=['pm1']){return h.call('/incidents/draft',{roomId:'a',date:'2026-10-05',periodKeys,description:'隔离样例：设备无画面，现场未修复'}).incident;}
function joint(h:ReturnType<typeof harness>,i:any,preference='keep_period'){const analyzed=h.call('/incidents/'+i.id+'/analyze',{preference});const plan=h.call('/incidents/'+i.id+'/preview',{candidateSetId:analyzed.candidateSet.id,optionId:analyzed.options[0].id}).plan;return {analyzed,plan};}
test('X08 当前方案链、候选版本和同编号回执跨序列化恢复，过期不删除任务',()=>{
 const h=harness(),compared=h.call('/schedule/preview',{date:draft.date,timetableId:'t',cardId:'A'}),p1=h.call('/schedule/preview',{...draft,taskId:compared.task.id,candidateSetId:compared.candidateSetId}).plan,p2=h.call('/schedule/preview',{...draft,taskId:p1.taskId,reason:'重新核对后的说明'}).plan;
 assert.equal(p2.previousPlanId,p1.id);const saved=JSON.parse(JSON.stringify(h.state));const call=(path:string)=>dispatch({method:'GET',path,actor:admin,state:saved,now,commit:()=>{throw new Error('read-only');}});const restored=call('/tasks/'+p1.taskId);assert.equal(restored.plan.id,p2.id);assert.equal(restored.plans.length,2);assert.equal(restored.plans[0].state,'superseded');assert.equal(restored.candidateSet.kind,'schedule.move');saved.opsPlans.find((p:any)=>p.id===p2.id).expiresAt='2020-01-01T00:00:00Z';assert.equal(call('/tasks/'+p1.taskId).task.status,'expired');assert.equal(call('/tasks').tasks.length,1);
 assert.throws(()=>h.call('/tasks/'+p1.taskId,undefined,vol),/本人任务/);
});
test('X08 过期、错任务和资源变更后的候选集合不能被选择',()=>{
 const h=harness(),c=h.call('/schedule/preview',{date:draft.date,timetableId:'t'});h.state.opsCandidateSets[0].expiresAt='2020-01-01T00:00:00Z';assert.throws(()=>h.call('/schedule/preview',{...draft,candidateSetId:c.candidateSetId,taskId:c.task.id}),/候选/);assert.equal(h.state.scheduleAdjust.length,0);
});
test('X14 资源健康基于缺失字段，受控修正记录前后值、操作者、依据与回执',()=>{
 const h=harness();delete h.state.courses[0].requiredEquipment;const health=h.call('/resource-health'),check=health.checks.find((c:any)=>c.resourceKind==='course');assert.ok(check);assert.throws(()=>h.call('/resource-health',undefined,vol),/管理员/);
 const p=h.call('/workflow/preview',{kind:'resource.patch',resourceKind:check.resourceKind,resourceId:check.resourceId,field:check.field,expectedResourceVersion:check.expectedResourceVersion,after:['projector'],note:'管理员核对课程设备',evidence:'隔离测试资源清单记录01'}).plan;
 assert.equal(h.state.courses[0].requiredEquipment,undefined);const receipt=h.call('/plans/commit',{planId:p.id,version:1}).receipt;assert.deepEqual(h.state.courses[0].requiredEquipment,['projector']);assert.equal(h.state.resourceCorrections[0].before,null);assert.equal(h.state.resourceCorrections[0].actorId,admin.username);assert.equal(receipt.objects[0].kind,'resource_correction');assert.equal(h.call('/resource-health').checks.filter((c:any)=>c.resourceKind==='course').length,0);
});
test('X14 不支持的字段、无依据或并发变更阻止资源修正',()=>{
 const h=harness(),input={kind:'resource.patch',resourceKind:'class',resourceId:'class-a',field:'size',after:31,note:'核对人数',evidence:'隔离清单'};
 for(const patch of [{field:'identity'},{after:0},{evidence:''}])assert.throws(()=>h.call('/workflow/preview',{...input,...patch}));
 const p=h.call('/workflow/preview',input).plan;h.state.classes[0].size=32;const before=JSON.stringify(h.state);assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1}),/已变化/);assert.equal(JSON.stringify(h.state),before);
});
test('X09/10 故障联合办理一份回执关联调课、停用、工单、定向通知，重复确认幂等',()=>{
 const h=harness(),i=incident(h),{plan}=joint(h,i);assert.equal(h.state.scheduleAdjust.length,0);assert.equal(h.state.roomClosures,undefined);const r=h.call('/plans/commit',{planId:plan.id,version:1}).receipt;
 assert.equal(r.objects.length,5);assert.equal(h.call('/plans/commit',{planId:plan.id,version:1}).receipt.operationId,r.operationId);assert.equal(h.state.issueTickets.length,1);assert.equal(h.state.notifications.length,1);assert.equal(h.state.incidents[0].status,'in_progress');assert.equal(calendar.effective('2026-10-05',h.state)[0].labId,'b');assert.equal(h.state.roomClosures[0].incidentId,i.id);assert.equal(h.call('/tasks/'+i.taskId).receipt.operationId,r.operationId);
 assert.throws(()=>h.call('/incidents/'+i.id+'/restore',{note:'未完成维修'}),/尚未验收/);
});
test('X10 联合原子写失败无半提交，恢复后同方案编号成功',()=>{
 const h=harness(),{plan}=joint(h,incident(h)),before=JSON.stringify(h.state);h.setFail(true);assert.throws(()=>h.call('/plans/commit',{planId:plan.id,version:1}),/durable/);assert.equal(JSON.stringify(h.state),before);h.setFail(false);h.call('/plans/commit',{planId:plan.id,version:1});assert.equal(h.state.opsLedger.length,1);
});
test('X10 另一业务对象更新、课程占用或事件修订使候选/确认失效',()=>{
 for(const change of [(s:any)=>s.notifications.push({id:'concurrent',time:now.toISOString()}),(s:any)=>s.classes[0].size=31,(s:any)=>s.incidents[0].revision++]){const h=harness(),{plan}=joint(h,incident(h));change(h.state);const before=JSON.stringify(h.state);assert.throws(()=>h.call('/plans/commit',{planId:plan.id,version:1}),/变化/);assert.equal(JSON.stringify(h.state),before);}
});
test('X09 事件严格按日期和节次限定；校历、人数或设备缺失不会产生可执行联合候选',()=>{
 const h=harness();h.state.timetable.push({...h.state.timetable[0],id:'later',periodKey:'pm2'});const i=incident(h);assert.equal(h.call('/incidents/'+i.id).impact.activityCount,1);
 for(const change of [(s:any)=>s.sysConfig.termEnd='',(s:any)=>s.classes[0].size=0,(s:any)=>s.courses[0].requiredEquipment=undefined]){const g=harness();change(g.state);const j=incident(g),a=g.call('/incidents/'+j.id+'/analyze',{});assert.equal(a.options.length,0);assert.ok(a.blocked.length);assert.equal(g.state.scheduleAdjust.length,0);}
});
test('X10 两门课不能共同占用同一房间节次，联合评分显示实际改节次数',()=>{
 const h=harness();h.state.classes.push({id:'cb',name:'Fixture B',size:25});h.state.timetable.push({...h.state.timetable[0],id:'t2',className:'Fixture B',classNames:['Fixture B'],teacher:'Other Teacher'});
 const i=incident(h),{analyzed,plan}=joint(h,i);assert.equal(analyzed.impact.activityCount,2);for(const o of analyzed.options){assert.equal(o.moves.length,2);const slots=o.moves.map((m:any)=>m.candidate.roomId+':'+m.candidate.periodKey);assert.equal(new Set(slots).size,2);assert.equal(o.cost.periodChanges,o.moves.filter((m:any)=>m.source.periodKey!==m.candidate.periodKey).length);}
 h.call('/plans/commit',{planId:plan.id,version:1});assert.equal(h.state.scheduleAdjust.length,2);assert.equal(h.state.notifications.length,2);
});
test('X10 没有全组解时保持阻塞；多个单课可行不构成联合可行',()=>{
 const h=harness();h.state.classes.push({id:'cb',name:'Fixture B',size:25});h.state.timetable.push({...h.state.timetable[0],id:'t2',className:'Fixture B',classNames:['Fixture B'],teacher:'Other Teacher'});
 h.state.roomClosures=h.state.labs.map((r:any)=>({id:r.id+'-blocked',roomId:r.id,startDate:'2026-10-05',endDate:'2026-10-05',periodKeys:['am1','am2','pm2','eve_ab','eve_cd'],status:'active'}));const i=incident(h),a=h.call('/incidents/'+i.id+'/analyze',{});assert.equal(a.options.length,0);assert.ok(a.blocked.join().includes('联合方案'));assert.equal(h.state.scheduleAdjust.length,0);
});
test('X11 三种偏好有明确成本与版本，越权或错集合不能选候选',()=>{
 const h=harness(),i=incident(h);for(const preference of ['keep_period','few_rooms','early']){const a=h.call('/incidents/'+i.id+'/analyze',{preference});assert.equal(a.candidateSet.preference,preference);assert.ok(a.options[0].cost);assert.throws(()=>h.call('/incidents/'+i.id+'/preview',{candidateSetId:'fake',optionId:'option-1'}));assert.throws(()=>h.call('/incidents/'+i.id+'/analyze',{preference},vol),/管理员/);}
});
test('X09 维修验收关闭不自动恢复停用；新确认恢复开放保留教学调整',()=>{
 const h=harness(),i=incident(h),{plan}=joint(h,i);h.call('/plans/commit',{planId:plan.id,version:1});h.state.issueTickets[0].status='closed';h.state.issueTickets[0].revision++;assert.equal(h.state.roomClosures[0].status,'active');assert.equal(h.state.incidents[0].status,'in_progress');
 const restore=h.call('/incidents/'+i.id+'/restore',{note:'隔离样例：管理员确认维修验收及现场开放',undoMoves:false}).plan;h.call('/plans/commit',{planId:restore.id,version:1});assert.equal(h.state.roomClosures[0].status,'revoked');assert.equal(h.state.scheduleAdjust[0].status,'active');assert.equal(h.state.incidents[0].status,'completed');assert.equal(h.state.incidents[0].history.at(-1).action,'incident.restore');
});
test('X11 恢复原课需重新检查整体冲突；新增占用阻止撤销调课',()=>{
 const h=harness(),i=incident(h),{plan}=joint(h,i);h.call('/plans/commit',{planId:plan.id,version:1});h.state.issueTickets[0].status='closed';h.state.timetable.push({...h.state.timetable[0],id:'new-conflict',classNames:['Other'],className:'Other',teacher:'Other'});assert.throws(()=>h.call('/incidents/'+i.id+'/restore',{note:'恢复原课',undoMoves:true}),/冲突/);assert.equal(h.state.roomClosures[0].status,'active');
});
test('X09 另一管理员人工接续事件，保留创建人、转交历史并取消旧待确认方案',()=>{
 const h=harness(),b={username:'coordinator-b',identity:'admin'};h.state.users.push(b);const i=incident(h),{plan:a}=joint(h,i),p=h.call('/incidents/'+i.id+'/takeover',{note:'管理员B承担后续事件办理'},b).plan;
 assert.equal(h.state.incidents[0].coordinatorId,admin.username);const receipt=h.call('/plans/commit',{planId:p.id,version:1},b).receipt;assert.equal(h.state.incidents[0].coordinatorId,b.username);assert.equal(h.state.incidents[0].actorId,admin.username);assert.equal(h.call('/plans/'+a.id).plan.state,'superseded');assert.equal(h.state.incidents[0].coordinatorHistory[0].before,admin.username);assert.equal(h.state.incidents[0].coordinatorHistory[0].after,b.username);assert.equal(h.call('/plans/commit',{planId:p.id,version:1},b).receipt.operationId,receipt.operationId);
 assert.throws(()=>h.call('/incidents/'+i.id+'/analyze',{}),/接续/);const analyzed=h.call('/incidents/'+i.id+'/analyze',{},b),proposal=h.call('/incidents/'+i.id+'/preview',{candidateSetId:analyzed.candidateSet.id,optionId:analyzed.options[0].id},b).plan;h.call('/plans/commit',{planId:proposal.id,version:1},b);assert.equal(h.state.issueTickets.length,1);assert.equal(h.state.incidents[0].status,'in_progress');
});
test('X09 事件接续落盘失败不更改管理人、旧方案或关联任务',()=>{
 const h=harness(),b={username:'coordinator-b',identity:'admin'};h.state.users.push(b);const i=incident(h),{plan:a}=joint(h,i),p=h.call('/incidents/'+i.id+'/takeover',{note:'原子接续'},b).plan,before=JSON.stringify(h.state);h.setFail(true);assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1},b),/durable/);assert.equal(JSON.stringify(h.state),before);assert.equal(h.state.opsPlans.find((p:any)=>p.id===a.id).state,'awaiting_confirmation');
});
test('X12 接收人接续结构化遗留事项，下一班次检查保持未确认，工单未验收事项不能完成',()=>{
 const h=harness(),b={username:'vol-b',identity:'volunteer'};h.state.users.push(b);h.state.dutyShifts.push({id:'next-b',date:'2026-10-06',roomId:'a',roomName:'E310',periodKey:'am1',userId:b.username});h.state.issueTickets=[{id:'linked',roomId:'a',actorId:vol.username,status:'open',revision:1}];
 const p=h.call('/handover/preview',{shiftId:'shift-fixture',checklist:['power','lights','doors','keys','todo'].map(key=>({key,state:'done'})),note:'检查已完成，工单仍待维修',finalize:true,receiverId:b.username,leftovers:[{localId:'draft1',description:'跟进维修',deadline:'2026-10-06',linkedIssueId:'linked'}]},vol).plan;h.call('/plans/commit',{planId:p.id,version:1},vol);
 const record=h.state.handoverRecords[0],item=h.state.handoverItems[0],accept=h.call('/workflow/preview',{kind:'duty.accept',recordId:record.id,expectedRevision:1,note:'接收并接续',adoptItemIds:[item.id]},b).plan;h.call('/plans/commit',{planId:accept.id,version:1},b);const current=h.state.handoverItems[0];assert.equal(current.assigneeId,b.username);assert.equal(h.state.issueTickets[0].status,'open');assert.equal(h.state.handoverRecords.some((r:any)=>r.shiftId==='next-b'),false);
 assert.throws(()=>h.call('/workflow/preview',{kind:'duty.item',itemId:item.id,expectedRevision:current.revision,action:'complete',note:'不能伪造完成'},b),/尚未验收/);
 const carry=h.call('/workflow/preview',{kind:'duty.item',itemId:item.id,expectedRevision:current.revision,action:'carry',targetShiftId:'next-b',note:'关联下一班次'},b).plan;h.call('/plans/commit',{planId:carry.id,version:1},b);assert.deepEqual(h.state.handoverItems[0].linkedShiftIds,['next-b']);assert.equal(h.state.handoverItems[0].state,'open');assert.equal(h.state.handoverRecords.length,1);
});

test('V03-03 非指派动作拒绝夹带负责人，预览与历史方案确认均零副作用',()=>{
 const h=harness();h.state.issueTickets=[{id:'i',status:'assigned',revision:2,roomId:'a',actorId:admin.username,assigneeId:vol.username,history:[]}];
 const input={kind:'issue.action',issueId:'i',expectedRevision:2,action:'start',note:'开始检查'};
 for(const assigneeId of ['fixture-student','',admin.username]){const before=JSON.stringify(h.state);assert.throws(()=>h.call('/workflow/preview',{...input,assigneeId},vol),/只有指派/);assert.equal(JSON.stringify(h.state),before);}
 const p=h.call('/workflow/preview',input,vol).plan;p.payload.assigneeId=student.username;const before=JSON.stringify(h.state);assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1},vol),/只有指派/);assert.equal(JSON.stringify(h.state),before);
 delete p.payload.assigneeId;h.call('/plans/commit',{planId:p.id,version:1},vol);assert.equal(h.state.issueTickets[0].assigneeId,vol.username);assert.equal(h.state.issueTickets[0].history[0].beforeAssignee,vol.username);
});
test('V03-03 指派要求当前有效工作人员，学生和停用账号不能接单',()=>{
 const h=harness();h.state.issueTickets=[{id:'i',status:'open',revision:1}];h.state.users.push({username:'off',identity:'volunteer',status:'disabled'});
 for(const assigneeId of [student.username,'off','unknown'])assert.throws(()=>h.call('/workflow/preview',{kind:'issue.action',issueId:'i',expectedRevision:1,action:'assign',assigneeId,note:'指派'}),/有效负责人/);
});
test('V03-04 独立工单和通知各有稳定任务，重算只替换当前任务方案',()=>{
 const h=harness();const a=h.call('/workflow/preview',{kind:'issue.create',roomId:'a',description:'A故障',cardId:'a'}),b=h.call('/workflow/preview',{kind:'issue.create',roomId:'a',description:'B故障',cardId:'b'});
 assert.notEqual(a.task.id,b.task.id);assert.equal(h.state.opsPlans[0].state,'awaiting_confirmation');
 const p2=h.call('/workflow/preview',{kind:'issue.create',roomId:'a',description:'A修订',taskId:a.task.id,cardId:'a'}).plan;
 assert.equal(h.call('/tasks/'+a.task.id).plan.id,p2.id);assert.equal(h.call('/plans/'+a.plan.id).plan.state,'superseded');assert.equal(h.call('/plans/'+b.plan.id).plan.state,'awaiting_confirmation');
 for(const p of [p2,b.plan])h.call('/plans/commit',{planId:p.id,version:1});assert.equal(h.state.issueTickets.length,2);assert.equal(h.call('/tasks').tasks.length,2);
});
test('V03-05 自己、停用和非工作人员接收人在预览阶段被拒绝，确认再次核验',()=>{
 const h=harness(),input={shiftId:'shift-fixture',checklist:['power','lights','doors','keys','todo'].map(key=>({key,state:'done'})),note:'完成现场检查',finalize:true};
 for(const receiverId of [vol.username,student.username,'unknown'])assert.throws(()=>h.call('/handover/preview',{...input,receiverId},vol),/接收/);
 const p=h.call('/handover/preview',{...input,receiverId:admin.username},vol).plan;h.state.users.find((u:any)=>u.username===admin.username).status='disabled';assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1},vol),/接收/);assert.equal(h.state.handoverRecords,undefined);
});
test('V03-05 默认管理员也要存在可接收的另一有效账号；旧死锁接收人可审计重指定',()=>{
 const h=harness();h.state.users.find((u:any)=>u.username===admin.username).status='disabled';const input={shiftId:'shift-fixture',checklist:['power','lights','doors','keys','todo'].map(key=>({key,state:'done'})),note:'完成现场检查',finalize:true};assert.throws(()=>h.call('/handover/preview',input,vol),/没有可接收/);
 h.state.users.find((u:any)=>u.username===admin.username).status='active';h.state.handoverRecords=[{id:'legacy-self',actorId:vol.username,receiverId:vol.username,status:'awaiting_acceptance',revision:1,shiftId:'shift-fixture'}];const p=h.call('/workflow/preview',{kind:'duty.reassign',recordId:'legacy-self',expectedRevision:1,receiverId:'',note:'修复旧记录自接收死锁'}).plan;h.call('/plans/commit',{planId:p.id,version:1});assert.equal(h.state.handoverRecords[0].receiverId,'');assert.equal(h.state.handoverRecords[0].receiverHistory[0].before,vol.username);assert.equal(h.state.handoverRecords[0].revision,2);
});
test('X08 原账号角色变化只显示任务不可用标记，不继承原计划和候选内容',()=>{
 const h=harness(),p=h.call('/schedule/preview',draft).plan,downgraded={...admin,identity:'volunteer'},r=h.call('/tasks/'+p.taskId,undefined,downgraded);assert.equal(r.task.status,'permission_changed');assert.equal(r.plan,null);assert.equal(r.candidateSet,null);assert.deepEqual(r.plans,[]);assert.throws(()=>h.call('/plans/'+p.id,undefined,downgraded),/角色已变化/);assert.equal(h.call('/context',undefined,downgraded).plans.length,0);
});
test('V03-06/07 一致日报给未知数量null，业务变化更新版本，权限限定统计依据',()=>{
 const h=harness(),r=h.call('/report/2026-10-05');assert.equal(r.metrics[0].value,1);assert.equal(h.call('/report/2030-10-05').metrics[0].value,null);
 h.state.issueTickets=[{id:'i',actorId:vol.username,status:'open',createdAt:now.toISOString(),revision:1}];const after=h.call('/report/2026-10-05');assert.notEqual(after.reportRevision,r.reportRevision);assert.equal(after.sourceRevision,r.sourceRevision);assert.equal(after.metrics[3].value,1);assert.equal(after.metrics[5].coverage,'current_visible');assert.throws(()=>h.call('/report/2026-10-05',undefined,student),(e:any)=>e.status===403);
 assert.ok(after.metrics.every((m:any)=>m.sourceRevision===after.reportRevision&&m.queriedAt===after.queriedAt));
});

test('指定日期调课：预览—确认—同编号回查—原系统有效课表及签到解算同步',()=>{
  const h=harness(),plan=h.call('/schedule/preview',draft).plan;
  assert.equal(h.state.scheduleAdjust.length,0);
  const receipt=h.call('/plans/commit',{planId:plan.id,version:plan.version}).receipt;
  assert.equal(receipt.objects[0].id,h.state.scheduleAdjust[0].id);
  assert.equal(h.call('/operations/'+receipt.operationId).receipt.operationId,receipt.operationId);
  const rows=calendar.effective(draft.date,h.state);assert.equal(rows[0].labId,'b');assert.equal(rows[0].labName,'E312');
  const resolved=LabSched.resolve(new Date('2026-10-05T14:30:00+08:00'),h.state);assert.equal(resolved.byClass['Fixture A'].labId,'b');
  assert.equal(resolved.byLab.a.items.length,0);assert.equal(resolved.byLab.b.items.length,1);
  assert.equal(h.state.timetable[0].labId,'a','周课表本身不被永久改动');
});
test('外部提交已成功但响应丢失，重放同一方案只返回同一操作',()=>{
  const h=harness(),p=h.call('/schedule/preview',draft).plan;
  const first=h.call('/plans/commit',{planId:p.id,version:1});
  const recovered=h.call('/plans/commit',{planId:p.id,version:1});
  assert.equal(first.receipt.operationId,recovered.receipt.operationId);assert.equal(h.state.scheduleAdjust.length,1);
});
test('外部原子落盘故障零副作用，恢复后仍按同一方案办理',()=>{
  const h=harness(),p=h.call('/schedule/preview',draft).plan,before=JSON.stringify(h.state);h.setFail(true);
  assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1}));assert.equal(JSON.stringify(h.state),before);
  h.setFail(false);assert.ok(h.call('/plans/commit',{planId:p.id,version:1}).receipt);assert.equal(h.state.scheduleAdjust.length,1);
});
test('确认前源课程、容量或目标占用变化都要求重新计算',()=>{
  for(const change of [(s:any)=>{s.timetable[0].updatedAt='new';},(s:any)=>{s.labs[1].capacity=10;},(s:any)=>{s.timetable.push({...s.timetable[0],id:'conflict',labId:'b',labName:'E312'});}]){
    const h=harness(),p=h.call('/schedule/preview',draft).plan;change(h.state);
    assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1}),/变化/);assert.equal(h.state.scheduleAdjust.length,0);
  }
});
test('未知人数、设备能力不足、校历不全或房间关闭不能生成可执行调课',()=>{
  for(const change of [(s:any)=>{s.classes[0].size=0;},(s:any)=>{s.labs[1].equipment=[];},(s:any)=>{s.sysConfig.termEnd='';},(s:any)=>{s.labs[1].status='closed';}]){
    const h=harness();change(h.state);assert.throws(()=>h.call('/schedule/preview',draft));assert.equal(h.state.scheduleAdjust.length,0);
  }
});
test('学生或另一个管理员无法确认他人原系统方案，版本错误零副作用',()=>{
  const h=harness(),p=h.call('/schedule/preview',draft).plan;
  assert.throws(()=>h.call('/schedule/preview',draft,student),/管理员/);
  assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1},{username:'other-admin',identity:'admin'}),/本人/);
  assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:9}),/版本/);assert.equal(h.state.scheduleAdjust.length,0);
});
test('校历处理单双周、假期、特殊教学日、停课与跨学期',()=>{
  const s:any=fixture();s.sysConfig.holidays=['2026-10-05'];assert.equal(calendar.effective('2026-10-05',s).length,0);
  s.sysConfig.specialDays=[{date:'2026-10-10',teachingDate:'2026-10-05',isTeachingDay:true}];assert.equal(calendar.effective('2026-10-10',s).length,1);
  s.timetable[0].weeks.parity='even';assert.equal(calendar.effective('2026-10-10',s).length,0);
  s.timetable[0].weeks.parity='all';s.timetable[0].status='cancelled';assert.equal(calendar.effective('2026-10-10',s).length,0);
  s.timetable[0].status='normal';s.timetable[0].term='other';assert.equal(calendar.effective('2026-10-10',s).length,0);
});
test('合班展开、活动数与占用大节分别统计，独立活动重叠提示待核实',()=>{
  const rows=[{id:'a',labId:'l',periodKey:'pm1',classNames:['A','B']},{id:'b',labId:'l',periodKey:'pm1',classNames:['C']}];
  const stats=calendar.stats(rows);assert.equal(stats.recordCount,3);assert.equal(stats.activityCount,2);assert.equal(stats.occupiedPeriodCount,1);assert.equal(stats.classCount,3);assert.equal(stats.conflicts[0].status,'needs_verification');
});
test('关门不派生为停用，人数保持未知',()=>{
  const s:any=fixture();s.labs[0].status='closed';const out=calendar.roomState(s.labs[0],s,'2026-10-05','am1');assert.equal(out.door,'closed');assert.equal(out.service,'normal');assert.equal(out.presence,'unknown');
  const resolved=LabSched.resolve(new Date('2026-10-05T08:30:00+08:00'),s);assert.notEqual(resolved.byLab.a.state,'disabled');
});
test('巡检无记录、部分、异常、全部四种状态，不制造准确率',()=>{
  const rooms=[{id:'a'},{id:'b'}],record=(roomId:string,state='done')=>({kind:'field_inspection',date:'2026-10-05',roomId,submittedAt:now.toISOString(),checklist:[{key:'keys',state}]});
  assert.equal(calendar.inspectionSummary([],rooms,'2026-10-05').status,'not_started');
  assert.equal(calendar.inspectionSummary([record('a')],rooms,'2026-10-05').status,'partial');
  assert.equal(calendar.inspectionSummary([record('a','abnormal')],rooms,'2026-10-05').status,'abnormal');
  const all=calendar.inspectionSummary([record('a'),record('b')],rooms,'2026-10-05');assert.equal(all.status,'completed');assert.equal(all.accuracy,null);
});
test('正式班次交接、异常工单、巡检与管理员回查共用记录编号',()=>{
  const h=harness();const p=h.call('/handover/preview',{shiftId:'shift-fixture',checklist:['power','lights','doors','keys','todo'].map(key=>({key,state:key==='power'?'abnormal':'unchecked'})),note:'Fixture power indicator abnormal',createIssue:true},vol).plan;
  const r=h.call('/plans/commit',{planId:p.id,version:1},vol).receipt;
  assert.equal(h.state.handoverRecords[0].id,r.operationId);assert.equal(h.state.inspectionRecords[0].id,r.operationId);assert.equal(h.state.issueTickets.length,1);
  assert.equal(h.call('/context').handovers.length,1);assert.equal(h.call('/context',undefined,student).handovers.length,0);
  assert.throws(()=>h.call('/handover/preview',{shiftId:'shift-fixture',checklist:[],note:'x'},vol));
});
test('值班窗口六个关键边界与超界由同一共享规则判断',()=>{
  const p=LabTime.periods()[0],window=calendar.dutyWindow;
  assert.equal(window(p,'checkin',469).valid,false);assert.equal(window(p,'checkin',470).status,'签到');
  assert.equal(window(p,'checkin',510).status,'签到');assert.equal(window(p,'checkin',511).status,'补签到');
  assert.equal(window(p,'checkout',589).valid,false);assert.equal(window(p,'checkout',590).status,'签退');
  assert.equal(window(p,'checkout',610).status,'签退');assert.equal(window(p,'checkout',611).status,'补签退');
  assert.equal(window(p,'checkout',650).valid,true);assert.equal(window(p,'checkout',651).valid,false);
});
test('定向通知不串角色，已读只由接收本人登记，同请求不重复发布',()=>{
  const h=harness(),input={requestId:'notice-request',title:'Fixture notice',content:'Fixture only',audience:{kind:'role',role:'volunteer'}};
  const n=h.call('/notifications',input).notification;assert.equal(h.call('/notifications',input).notification.id,n.id);assert.equal(h.state.notifications.length,1);
  assert.equal(h.call('/context',undefined,student).notifications.length,0);assert.equal(h.call('/context',undefined,vol).notifications.length,1);
  assert.throws(()=>h.call('/notifications/read',{id:n.id},student));h.call('/notifications/read',{id:n.id},vol);
  assert.equal(Object.keys(h.state.notifications[0].reads).length,1);assert.equal(h.call('/context',undefined,vol).notifications[0].readAt,now.toISOString());
});
test('签到分页按账号精确过滤，不允许用户名子串与跨表越权',()=>{
  nativeDb.insertCheckin({id:'ca',labId:'a',username:'user',type:'checkin'});nativeDb.insertCheckin({id:'cb',labId:'a',username:'user2',type:'checkin'});
  nativeDb.insertVolunteerRecord({id:'va',username:'user'});nativeDb.insertVolunteerRecord({id:'vb',username:'user2'});
  nativeDb.insertOpenLabRecord({id:'oa',username:'user'});nativeDb.insertOpenLabRecord({id:'ob',username:'user2'});
  for(const fn of ['queryCheckin','queryVolunteerRecord','queryOpenLabRecord']){const r=nativeDb[fn]({username:'user'});assert.equal(r.total,1);assert.equal(r.rows[0].username,'user');}
});
test('签到批量写入故障整体回滚，申报时间和接收时间分别存审计',()=>{
  nativeDb.db.exec("CREATE TEMP TRIGGER fail_second BEFORE INSERT ON volunteer_records WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(()=>nativeDb.insertRecordBatch('insertVolunteerRecord',[{id:'first',username:'audit-user'},{id:'second',username:'audit-user'}]));assert.equal(nativeDb.queryVolunteerRecord({username:'audit-user'}).total,0);
  nativeDb.db.exec('DROP TRIGGER fail_second');nativeDb.insertRecordBatch('insertVolunteerRecord',[{id:'first',username:'audit-user',actorId:'audit-user',time:'2026-10-05 15:30:00',clientTime:'2026-10-05 15:28:00',shiftId:'s'}]);
  const row=nativeDb.db.prepare("SELECT * FROM record_audit WHERE id='first'").get();assert.notEqual(row.declaredAt,row.receivedAt);assert.equal(row.shiftId,'s');
});
test('操作说明检索带版本与权限、生效期；无命中拒绝补编制度',()=>{
  assert.ok(retrieve('管理员调课约束','admin','2026-10-05').some(d=>d.id==='schedule-adjustment'));
  assert.ok(retrieve('管理员调课约束','student','2026-10-05').every(d=>d.id!=='schedule-adjustment'));
  assert.equal(retrieve('调课','admin','2026-09-01').length,0);assert.equal(retrieve('全国考试报销金额','admin','2026-10-05').length,0);
});
after(()=>{try{nativeDb.db?.close();}catch{}try{fs.rmSync(temp,{recursive:true,force:true});}catch(e){console.warn('cleanup skipped: '+(e as {code?:string}).code);}});

test('R05 部分检查可补全，修订历史保留且异常工单不重复，旧版本与并发方案拒绝',()=>{
 const h=harness();const checks=(value:string)=>['power','lights','doors','keys','todo'].map(key=>({key,state:key==='keys'?'done':value}));
 const first=h.call('/handover/preview',{shiftId:'shift-fixture',checklist:checks('unchecked'),note:'仅钥匙已确认'},vol).plan;h.call('/plans/commit',{planId:first.id,version:1},vol);
 assert.equal(h.state.handoverRecords[0].status,'partial');
 const input={shiftId:'shift-fixture',expectedRevision:1,checklist:checks('abnormal'),note:'补充检查发现设备异常',createIssue:true};
 const old=h.call('/handover/preview',input,vol).plan,newer=h.call('/handover/preview',input,vol).plan;
 assert.throws(()=>h.call('/plans/commit',{planId:old.id,version:1},vol));h.call('/plans/commit',{planId:newer.id,version:1},vol);
 const id=h.state.handoverRecords[0].id;assert.equal(id,'business-'+first.id);assert.equal(h.state.handoverRecords[0].revision,2);assert.equal(h.state.handoverRecords[0].revisions.length,2);assert.equal(h.state.issueTickets.length,1);
 const again=h.call('/handover/preview',{...input,expectedRevision:2},vol).plan;h.call('/plans/commit',{planId:again.id,version:1},vol);assert.equal(h.state.issueTickets.length,1);assert.equal(h.state.inspectionRecords.length,1);
 assert.throws(()=>h.call('/handover/preview',input,vol),/更新/);
});
test('检查登记、最终交接与另一人接收是独立确认，关联异常不自动修复',()=>{
 const h=harness(),body={shiftId:'shift-fixture',checklist:['power','lights','doors','keys','todo'].map(key=>({key,state:'done'})),note:'五项已确认，待接收',finalize:true};
 assert.throws(()=>h.call('/handover/preview',{...body,checklist:body.checklist.map(c=>({...c,state:'unchecked'}))},vol),/补全/);
 const p=h.call('/handover/preview',body,vol).plan;h.call('/plans/commit',{planId:p.id,version:1},vol);const record=h.state.handoverRecords[0];assert.equal(record.status,'awaiting_acceptance');
 assert.throws(()=>h.call('/workflow/preview',{kind:'duty.accept',recordId:record.id,expectedRevision:record.revision,note:'我接收'},vol));
 const accept=h.call('/workflow/preview',{kind:'duty.accept',recordId:record.id,expectedRevision:record.revision,note:'已核对并接收'}).plan;const r=h.call('/plans/commit',{planId:accept.id,version:1}).receipt;
 assert.equal(h.state.handoverRecords[0].status,'completed');assert.equal(h.state.handoverRecords[0].acceptedBy,admin.username);assert.equal(h.call('/plans/commit',{planId:accept.id,version:1}).receipt.operationId,r.operationId);
});
test('真实工单按创建、指派、处理中、验收、退回、再验收、关闭流转并回查',()=>{
 const h=harness();const p=h.call('/workflow/preview',{kind:'issue.create',roomId:'a',description:'投影无画面'},vol).plan;h.call('/plans/commit',{planId:p.id,version:1},vol);
 const issue=h.state.issueTickets[0];function advance(action:string,who=admin){const current=h.state.issueTickets[0];const plan=h.call('/workflow/preview',{kind:'issue.action',issueId:issue.id,expectedRevision:current.revision,action,...(action==='assign'?{assigneeId:vol.username}:{}),note:'隔离处理说明'},who).plan;const r=h.call('/plans/commit',{planId:plan.id,version:1},who).receipt;assert.equal(h.call('/plans/commit',{planId:plan.id,version:1},who).receipt.operationId,r.operationId);}
 assert.throws(()=>advance('close'));advance('assign');advance('start',vol);advance('submit',vol);assert.equal(h.state.issueTickets[0].status,'awaiting_acceptance');assert.throws(()=>advance('close',vol));advance('return');advance('submit',vol);advance('close');
 assert.equal(h.state.issueTickets[0].status,'closed');assert.equal(h.state.issueTickets[0].history.length,7);assert.equal(h.state.issueTickets.length,1);
});
test('工单与交接版本故障、其他人处理和原子落盘故障不能产生副作用',()=>{
 const h=harness();const p=h.call('/workflow/preview',{kind:'issue.create',roomId:'a',description:'故障记录'},vol).plan;h.setFail(true);assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1},vol));assert.equal(h.state.issueTickets?.length||0,0);h.setFail(false);h.call('/plans/commit',{planId:p.id,version:1},vol);
 const i=h.state.issueTickets[0];const input={kind:'issue.action',issueId:i.id,expectedRevision:i.revision,action:'assign',assigneeId:vol.username,note:'指派'};
 assert.throws(()=>h.call('/workflow/preview',{...input,expectedRevision:999}));assert.throws(()=>h.call('/workflow/preview',input,student));assert.equal(i.status,'open');
});
test('真实通知通过待确认方案发布、同编号重试，已读只由接收人登记',()=>{
 const h=harness(),p=h.call('/workflow/preview',{kind:'notification.publish',title:'调课通知',content:'2026-10-05 E312 pm1',audience:{kind:'class',className:'Fixture A'}}).plan;
 assert.equal(h.state.notifications.length,0);const r=h.call('/plans/commit',{planId:p.id,version:1}).receipt;h.call('/plans/commit',{planId:p.id,version:1});assert.equal(h.state.notifications.length,1);
 assert.equal(h.call('/operations/'+r.operationId).receipt.objects[0].kind,'notification');assert.equal(h.call('/context',undefined,vol).notifications.length,0);const notice=h.call('/context',undefined,student).notifications[0];h.call('/notifications/read',{id:notice.id},student);assert.ok(h.state.notifications[0].reads[student.username]);
});
test('原系统停用稳定ID与旧房间号兼容：全天、跨日、部分节次和撤销同版本一致',()=>{
 const h=harness();const p=h.call('/workflow/preview',{kind:'closure.create',roomId:'b',startDate:'2026-10-05',endDate:'2026-10-06',periodKeys:['pm1'],reason:'隔离设备检修'}).plan;h.call('/plans/commit',{planId:p.id,version:1});
 assert.equal(calendar.roomState(h.state.labs[1],h.state,'2026-10-05','pm1').service,'suspended');assert.equal(calendar.roomState(h.state.labs[1],h.state,'2026-10-06','am1').service,'normal');
 const options=h.call('/schedule/preview',{date:'2026-10-05',timetableId:'t'}).candidates;assert.ok(options.find((c:any)=>c.roomId==='b'&&c.periodKey==='pm1').reasons.includes('房间处于停用范围'));
 const snapshot=h.call('/snapshot');assert.equal(snapshot.contractVersion,2);assert.equal(snapshot.roomClosures[0].roomId,'b');
 const revoke=h.call('/workflow/preview',{kind:'closure.revoke',closureId:snapshot.roomClosures[0].id}).plan;h.call('/plans/commit',{planId:revoke.id,version:1});assert.equal(calendar.roomState(h.state.labs[1],h.state,'2026-10-05','pm1').service,'normal');
});
test('调课条件重算后旧方案失效，按卡片编号可恢复当前原系统方案',()=>{
 const h=harness(),p=h.call('/schedule/preview',{...draft,cardId:'message:tool'}).plan;assert.equal(p.clientCardId,'message:tool');
 h.call('/schedule/preview',{date:draft.date,timetableId:'t',supersedePlanId:p.id});assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1}));assert.equal(h.state.scheduleAdjust.length,0);assert.equal(h.call('/plans/'+p.id).plan.state,'superseded');
});

test('0.2.0旧部分交接记录迁移为可补全检查，保留原声明与同一记录编号',()=>{
 const h=harness();h.state.handoverRecords=[{id:'legacy-record',shiftId:'shift-fixture',roomId:'a',actorId:vol.username,date:'2026-10-05',kind:'field_inspection',submittedAt:now.toISOString(),checklist:['power','lights','doors','keys','todo'].map(key=>({key,state:key==='keys'?'done':'unchecked'})),note:'原版本只有钥匙已确认'}];
 const current=h.call('/context',undefined,vol).handovers[0];assert.equal(current.revision,1);assert.equal(current.status,'partial');
 const p=h.call('/handover/preview',{shiftId:'shift-fixture',expectedRevision:1,checklist:current.checklist.map((c:any)=>({...c,state:'done'})),note:'补全现场检查'},vol).plan;h.call('/plans/commit',{planId:p.id,version:1},vol);
 assert.equal(h.state.handoverRecords[0].id,'legacy-record');assert.equal(h.state.handoverRecords[0].revisions.length,2);assert.equal(h.state.handoverRecords[0].revisions[0].note,'原版本只有钥匙已确认');
});
test('管理员代录签到：预览—确认—幂等回执，记录带 agent-manual 标记与代录人',()=>{
 const h=harness();h.state.classRoster=[{sno:student.username,className:'Fixture A'}];
 const base={kind:'checkin.manual',targetUsername:student.username,date:'2026-10-05',periodKey:'pm1',labId:'a',reason:'隔离样例：设备故障无法扫码'};
 const p=h.call('/workflow/preview',base).plan;assert.equal(p.kind,'checkin.manual');assert.equal(p.payload.timetableId,'t');assert.equal(p.payload.className,'Fixture A');assert.equal(p.state,'awaiting_confirmation');
 const r=h.call('/plans/commit',{planId:p.id,version:1});assert.equal(r.receipt.objects[0].kind,'checkin_record');
 const rec=h.state.checkinRecords[0];assert.equal(rec.source,'agent-manual');assert.equal(rec.username,student.username);assert.equal(rec.actorId,admin.username);assert.equal(rec.status,'补签到','课后补录记补签到');assert.equal(rec.timetableId,'t');assert.ok(String(rec.registrationReason).includes('设备故障'));assert.equal(rec.id,'manual-'+p.id.slice(5));
 const again=h.call('/plans/commit',{planId:p.id,version:1});assert.equal(again.replayed,true);assert.equal(again.receipt.operationId,r.receipt.operationId);assert.equal(h.state.checkinRecords.length,1,'确定性 id+台账双保险，不产生第二条记录');
 assert.equal(h.call('/checkin-status',undefined,student).lessons[0].status,'signed','提交后本人状态端点立即可见');
});
test('代录拦截：非管理员、不存在的账号、在册账号未登名册、缺原因、未来日期、归属不匹配、提交时重复与课表变化、过期',()=>{
 const h=harness();h.state.classRoster=[{sno:student.username,className:'Fixture A'}];h.state.checkinRecords=[];
 const base={kind:'checkin.manual',targetUsername:student.username,date:'2026-10-05',periodKey:'pm1',labId:'a',reason:'隔离样例原因'};
 assert.throws(()=>h.call('/workflow/preview',base,vol),/管理员/);
 assert.throws(()=>h.call('/workflow/preview',{...base,targetUsername:'8888'}),/目标学生不存在/);
 h.state.users.push({username:'2023009',identity:'student',className:'Fixture A'});
 assert.throws(()=>h.call('/workflow/preview',{...base,targetUsername:'2023009'}),/名册/,'在册账号但未登名册：无法确定班级归属');
 assert.throws(()=>h.call('/workflow/preview',{...base,reason:''}),/原因/);
 assert.throws(()=>h.call('/workflow/preview',{...base,date:'2026-10-10'}),/未来/);
 assert.throws(()=>h.call('/workflow/preview',{...base,periodKey:'am1'}),/课程/);
 const p=h.call('/workflow/preview',base).plan;
 assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1},vol),/方案/,'他人方案对 volunteer 不可见（404 先于身份门控）');
 h.state.checkinRecords.push({id:'dup-1',labId:'a',type:'checkin',username:student.username,periodKey:'pm1',time:'2026-10-05 14:05:00',valid:true});
 assert.throws(()=>h.call('/plans/commit',{planId:p.id,version:1}),/已有有效签到/);
 h.state.classRoster.push({sno:'2023009',className:'Fixture A'});
 const p3=h.call('/workflow/preview',{...base,targetUsername:'2023009',reason:'第二次准备'}).plan;
 h.state.timetable[0].courseName='Changed Course'; // 课表版本变化
 assert.throws(()=>h.call('/plans/commit',{planId:p3.id,version:1}),/变化/);
 const p4=h.call('/workflow/preview',{...base,targetUsername:'2023009',reason:'第三次准备'}).plan;h.state.opsPlans.find((x:any)=>x.id===p4.id).expiresAt='2020-01-01T00:00:00Z';
 assert.throws(()=>h.call('/plans/commit',{planId:p4.id,version:1}),/过期/);
});
test('业务提交的记录增量经 syncBusinessRecords 落 SQLite 并写审计（重启不丢）',()=>{
 const record={id:'manual-sync-1',labId:'a',type:'checkin',username:student.username,name:'S',periodKey:'pm1',time:'2026-10-05 14:05:00',status:'补签到',source:'agent-manual',actorId:admin.username,registrationReason:'隔离样例原因'};
 const synced=nativeDb.syncBusinessRecords({checkinRecords:[]},{checkinRecords:[record]});
 assert.deepEqual(synced,[{key:'checkinRecords',route:'insertCheckin',count:1}]);
 const again=nativeDb.syncBusinessRecords({checkinRecords:[record]},{checkinRecords:[record]});
 assert.equal(again.length,0,'同一 id 不重复写入');
 const {DatabaseSync}=require('node:sqlite');
 const ro=new DatabaseSync(nativeDb.dbPath,{readOnly:true});
 try{
  const row=ro.prepare('SELECT * FROM checkin_records WHERE id=?').get('manual-sync-1') as Record<string,unknown>|undefined;
  assert.ok(row,'SQLite 权威层必须有该记录');
  assert.equal(row?.lab_id,'a');
  assert.equal(row?.username,student.username);
  const audit=ro.prepare('SELECT * FROM record_audit WHERE id=? AND route=?').get('manual-sync-1','insertCheckin') as Record<string,unknown>|undefined;
  assert.ok(audit,'审计必须有代录痕迹');
  assert.equal(audit?.actorId,admin.username,'代录人入审计');
  assert.equal(audit?.reason,'隔离样例原因','代录原因入审计');
 }finally{ro.close();}
});
