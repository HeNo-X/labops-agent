import { businessRequest,businessScope,rememberBusinessTask,readBusinessTask,listBusinessTasks } from '../business/bridge.ts';
import { effectiveSchedule } from '../data/calendar.ts';
import { isValidDateString } from '../time/term.ts';
import { parseIntent } from '../agent/intent.ts';
import type { ToolExecution, ToolContext } from './registry.ts';
import type { BusinessResult, NativeContext, NativePlan, NativeCandidate } from '../../shared/business.ts';
function fail(e:unknown):ToolExecution{return {ok:false,code:(e as {code?:string}).code||'business_unavailable',message:e instanceof Error?e.message:'原系统不可用',suggestions:[],summary:'未取得有效业务依据，尚未提交操作'};}
function result(data:Partial<BusinessResult>,ctx:ToolContext):ToolExecution{
  const r:BusinessResult={summary:'原系统查询完成',planId:data.plan?.id||null,candidates:[],workbenchUrl:'/operations.html?bridge=1'+(data.plan?'&planId='+data.plan.id:''),source:'原实验室系统',scopeKey:businessScope().scopeKey,queriedAt:ctx.now.iso,...data};
  if(r.taskId||r.plan||r.view==='schedule')rememberBusinessTask(ctx.conversationId,r);
  return {ok:true,resultKind:'business_plan',summary:r.summary,result:r};
}
export async function prepareSchedule(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
  if(ctx.mode==='chat')return fail(new Error('聊天模式不能准备业务方案，请切换任务模式'));
  try{const r=await businessRequest('/schedule/preview','POST',{...args,conversationId:ctx.conversationId||undefined},ctx.signal);const plan=r['plan'] as NativePlan|undefined,candidates=r['candidates'] as NativeCandidate[];
    return result({view:'schedule',task:r['task'] as BusinessResult['task'],taskId:(r['task'] as BusinessResult['task'])?.id,candidateSetId:r['candidateSetId'] as string|undefined,date:String(args['date']),plan,sourceLesson:r['source'] as BusinessResult['sourceLesson'],candidates,sourceRevision:plan?.sourceRevision||String(r['revision']),summary:plan?'指定日期调课方案已准备，请本人在消息卡确认。':`比较 ${candidates.length} 个房间与节次组合，${candidates.filter(c=>c.eligible).length} 个符合当前约束。`},ctx);
  }catch(e){return fail(e);}
}
export async function queryBusiness(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
  try{const context=await businessRequest('/context','GET',undefined,ctx.signal) as unknown as NativeContext;const view=(['schedule','duty','issues','notifications','closures','report','tasks','incidents','health'].includes(String(args['view']))?args['view']:'issues') as BusinessResult['view'];
    if(view==='schedule'){const date=typeof args['date']==='string'?args['date']:context.date;if(!isValidDateString(date))throw new Error('查询日期无效');context.date=date;context.timetable=effectiveSchedule(ctx.dataset,date) as unknown as NativeContext['timetable'];}
    const tasks=view==='tasks'?await businessRequest('/tasks','GET',undefined,ctx.signal) as unknown as BusinessResult['tasks']:undefined;
    const incidents=view==='incidents'?(await businessRequest('/incidents','GET',undefined,ctx.signal))['incidents'] as BusinessResult['incidents']:undefined;
    const resourceHealth=view==='health'?await businessRequest('/resource-health','GET',undefined,ctx.signal):undefined;
    let report:BusinessResult['report'];
    if(view==='report'){
      const date=typeof args['date']==='string'?args['date']:context.date;
      if(!isValidDateString(date))throw new Error('日报日期无效');
      report=await businessRequest('/report/'+date,'GET',undefined,ctx.signal) as unknown as BusinessResult['report'];
    }
    return result({view,context,report,tasks,incidents,resourceHealth,date:report?.date||context.date,queriedAt:report?.queriedAt||ctx.now.iso,sourceRevision:report?.sourceRevision||context.revision,summary:view==='duty'?`${context.actor.username} 的正式排班与检查记录已查询；未检查项目保持未确认。`:view==='report'?'真实日报已按原账号权限聚合，数字附对象编号。':view==='tasks'?`原系统持久任务 ${tasks?.tasks.length||0} 项，请通过“我的工作”继续或回查。`:view==='health'?'原系统资源数据健康已查询；补录必须由管理员核对依据并人工确认。':'当前业务对象已从原系统回查。'},ctx);
  }catch(e){return fail(e);}
}
export async function queryDuty(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{return queryBusiness({...args,view:'duty'},ctx);}
export async function prepareWorkflow(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
  if(ctx.mode==='chat')return fail(new Error('聊天模式不能准备业务方案，请切换任务模式'));
  try{const endpoint=args['kind']==='duty.handover'?'/handover/preview':'/workflow/preview';const r=await businessRequest(endpoint,'POST',{...args,conversationId:ctx.conversationId||undefined},ctx.signal);const plan=r['plan'] as NativePlan;
    return result({plan,task:r['task'] as BusinessResult['task'],taskId:plan.taskId,view:plan.kind==='resource.patch'?'health':plan.kind.startsWith('duty.')?'duty':plan.kind.startsWith('issue.')?'issues':plan.kind.startsWith('closure.')?'closures':'notifications',sourceRevision:plan.sourceRevision,summary:'原系统待确认方案已准备；业务尚未提交，请核对后本人点击确认。'},ctx);
  }catch(e){return fail(e);}
}
export async function queryIncident(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
 try{if(typeof args['incidentId']!=='string')return queryBusiness({view:'incidents'},ctx);const r=await businessRequest('/incidents/'+args['incidentId'],'GET',undefined,ctx.signal);return result({view:'incidents',incident:r['incident'] as BusinessResult['incident'],impact:r['impact'] as BusinessResult['impact'],taskId:(r['incident'] as BusinessResult['incident'])?.taskId,summary:'故障事件及其原系统关联对象已回查；工单登记不代表修复。'},ctx);}catch(e){return fail(e);}
}
export async function prepareIncident(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
 if(ctx.mode==='chat')return fail(new Error('请切换任务模式准备事件方案'));
 try{const action=args['action']||'draft',incidentId=args['incidentId'];if(!['draft','analyze','preview','restore','takeover'].includes(String(action)))throw new Error('事件动作不支持');if(action!=='draft'&&typeof incidentId!=='string')throw new Error('请先查询并指定原系统事件编号');
 const endpoint=action==='draft'?'/incidents/draft':'/incidents/'+incidentId+'/'+action;const r=await businessRequest(endpoint,'POST',{...args,conversationId:ctx.conversationId||undefined},ctx.signal),plan=r['plan'] as NativePlan|undefined;
 return result({view:'incidents',plan,incident:r['incident'] as BusinessResult['incident'],task:r['task'] as BusinessResult['task'],taskId:plan?.taskId||(r['incident'] as BusinessResult['incident'])?.taskId,incidentSet:r['candidateSet'] as BusinessResult['incidentSet'],impact:r['impact'] as BusinessResult['impact'],summary:plan?'故障事件方案已准备，等待本人核对全部对象并点击确认。':'故障事件草稿或联合候选已准备，教学安排尚未变更。'},ctx);
 }catch(e){return fail(e);}
}
export async function queryScheduled(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
 try{const p=args['view']==='results'?'/scheduled-results':args['view']==='preparation'?'/preparation-pack':'/scheduled-jobs';const data=await businessRequest(p,'GET',undefined,ctx.signal);return result({view:'jobs',scheduledData:data,summary:'定时规则或事实结果已按当前账号读取。'},ctx);}catch(e){return fail(e);}
}
export async function prepareScheduled(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
 if(ctx.mode==='chat')return fail(new Error('聊天模式不能设置规则，请切换任务模式'));
 try{const data=await businessRequest('/scheduled-jobs/preview','POST',{...args,conversationId:ctx.conversationId||undefined},ctx.signal);return result({view:'jobs',scheduledRule:data['plan'] as BusinessResult['scheduledRule'],summary:'定时规则已预览，未来时间、样例与效果待本人核对确认；尚未激活规则。'},ctx);}catch(e){return fail(e);}
}
/** Deterministic routing is an honest fallback. Explicit buttons still own all commit authority. */
export function planNativeDialogue(q:string,ctx:ToolContext):{tool:string;args:Record<string,unknown>;execute:()=>Promise<ToolExecution>}|null{
  const query=(args:Record<string,unknown>)=>({tool:'query_business_context',args,execute:()=>queryBusiness(args,ctx)});
  const writes=/创建.*(?:规则|定时)|发布通知|调课|换教室|关闭工单|执行|自动.*(?:关闭|验收)|登记故障/.test(q);
  if(ctx.mode==='chat'&&writes){if(/查询|查看|课表|有哪些|日报|排班/.test(q))return {tool:'query_business_context',args:{view:/日报/.test(q)?'report':/排班/.test(q)?'duty':'schedule'},execute:async()=>{const out=await queryBusiness({view:/日报/.test(q)?'report':/排班/.test(q)?'duty':'schedule',date:parseIntent(q,ctx.now).date?.date||ctx.now.date},ctx);if(out.ok&&out.resultKind==='business_plan')out.result.summary+='；执行部分请切换任务模式并人工确认。';return out;}};return {tool:'chat_mode_guard',args:{},execute:async()=>result({summary:'聊天模式仅查询；请切换任务模式准备方案并人工确认。'},ctx)};}
  const prepare=(args:Record<string,unknown>)=>({tool:'prepare_schedule_adjustment',args,execute:()=>prepareSchedule(args,ctx)});
  if(/定时|订阅|每日.*提醒|每天.*日报|提醒.*规则/.test(q)){
    if(ctx.mode==='chat'&&/创建|设置|新增|暂停|恢复|执行|修改/.test(q))return {tool:'chat_mode_guard',args:{},execute:async()=>result({summary:'请切换任务模式设置定时规则并人工确认。'},ctx)};
    if(ctx.mode!=='chat'&&/创建|设置|新增/.test(q)){
      const tm=/(\d{1,2})[:：](\d{2})/.exec(q),daily=/每天|每日|每个教学日/.test(q);
      // Incomplete recurrence/recipient parsing must not silently become a daily self rule.
      const unsupported=/每周|每月|每年|星期|周[一二三四五六日天]|班.*前|班.*开始|Cron|cron|\d{4}-\d{2}-\d{2}|给(?!我|本人|自己)|全校|全体|班级|角色|\d+\s*小时|仅|只保存|不要.*(?:发|提醒)|上午|下午|晚上|中午|早上|夜间|早晨|AM|PM|节假日|工作日|周末|除外|排除|不提醒|为(?!我|本人|自己).*?(?:设置|创建|订阅)|帮(?!我).*?(?:设置|创建|订阅)/i.test(q);
      const kind=/未读.*通知/.test(q)?'notice_reminder':/停用.*到期/.test(q)?'closure_expiry':/资源.*风险|风险.*巡检/.test(q)?'resource_risk':/周报/.test(q)?'weekly_report':/值班/.test(q)?'duty_reminder':/明日|明天/.test(q)?'tomorrow_courses':/工单|催办/.test(q)?'due_followup':/日报/.test(q)?'daily_report':null;
      if(!tm||!daily||unsupported||!kind||Number(tm[1])>23||Number(tm[2])>59)return {tool:'query_scheduled_jobs',args:{},execute:async()=>result({summary:'请在“定时任务与提醒”面板核对模板、每天/每周/正式班次前、时间与接收对象，预览后本人确认。本轮未创建规则方案。'},ctx)};
      const args={action:'create',spec:{kind,calendarPolicy:/教学日/.test(q)?'teaching_days':'all_days',trigger:{type:'daily',time:tm[1]!.padStart(2,'0')+':'+tm[2]},recipients:[{kind:'user',userId:businessScope().principal?.username}],approvedEffects:['report','inbox']}};return {tool:'prepare_scheduled_job',args,execute:()=>prepareScheduled(args,ctx)};
    }
    return {tool:'query_scheduled_jobs',args:{view:/结果|执行记录/.test(q)?'results':'rules'},execute:()=>queryScheduled({view:/结果|执行记录/.test(q)?'results':'rules'},ctx)};
  }
  if(/准备包/.test(q))return {tool:'query_scheduled_jobs',args:{view:'preparation'},execute:()=>queryScheduled({view:'preparation'},ctx)};
  if(/我的工作|任务中心|未完成任务|恢复任务/.test(q))return query({view:'tasks'});
  if(/资源数据健康|资源健康|数据健康清单/.test(q))return query({view:'health'});
  if(/故障事件|联合方案|联合处置|多门课|几门课|登记故障/.test(q)){const incidentId=/incident-[a-f0-9-]+/.exec(q)?.[0];return {tool:'query_incident',args:{incidentId},execute:()=>queryIncident({incidentId},ctx)};}
  if(/下次值班|下一次值班|正式排班|我的班次|检查|交接|值班收尾/.test(q))return {tool:'query_duty_context',args:{},execute:()=>queryDuty({},ctx)};
  if(/日报|运营报告/.test(q))return query({view:'report',date:parseIntent(q,ctx.now).date?.date||ctx.now.date});
  if(/通知|已读/.test(q))return query({view:'notifications'});
  if(/报修|工单|维修|故障/.test(q)&&!/调课|换教室/.test(q))return query({view:'issues'});
  if(/停用/.test(q))return query({view:'closures'});
  const selection=/选(?:择)?\s*第?([一二三123])(?:个|项|方案)/.exec(q);
  if(selection){
    const tasks=listBusinessTasks(ctx.conversationId).filter(t=>t['view']==='schedule'&&t['taskId']) as unknown as BusinessResult[];
    const taskId=/task-[a-f0-9-]+/.exec(q)?.[0],ord=/任务\s*第?([一二三123])|第([一二三123])(?:个)?任务/.exec(q),n=ord?.[1]||ord?.[2];
    const active=taskId?tasks.find(t=>t.taskId===taskId):n?tasks[({'一':1,'二':2,'三':3,'1':1,'2':2,'3':3}[n]||1)-1]:tasks.length===1?tasks[0]:null;
    if(!active)return {tool:'prepare_schedule_adjustment',args:{selection:selection[1]},execute:async()=>fail(new Error(tasks.length>1?'当前有多个任务，请指定任务编号或“任务1/任务2”：'+tasks.map((t,i)=>`任务${i+1} ${t.taskId} · ${t.sourceLesson?.courseName||'待选择课程'} · ${t.date}`).join('；'):'没有当前身份下的候选集合，请先比较调课方案'))};
    const index=({'一':1,'二':2,'三':3,'1':1,'2':2,'3':3}[selection[1]!]||1)-1;
    return {tool:'prepare_schedule_adjustment',args:{taskId:active.taskId,selection:index+1},execute:async()=>{
      try{const current=await businessRequest('/tasks/'+active.taskId,'GET',undefined,ctx.signal),set=current['candidateSet'] as {id:string;source:BusinessResult['sourceLesson'];date:string;candidates:NativeCandidate[];expiresAt:string}|null;
        if(!set||set.id!==active.candidateSetId||Date.parse(set.expiresAt)<=Date.now())throw new Error('所引用的候选集合已被重算或过期，请回查任务并重新比较');
        const c=set.candidates.filter(c=>c.eligible)[index];if(!c||!set.source)throw new Error('此任务没有所选候选，请重新比较');
        return prepareSchedule({taskId:active.taskId,candidateSetId:set.id,date:set.date,timetableId:set.source.id,toLabId:c.roomId,toPeriodKey:c.periodKey,reason:active.plan?.payload.reason||'用户选择替代方案，请核对并填写原因'},ctx);
      }catch(e){return fail(e);}
    }};
  }
  if(/调课|换教室|教学影响|替代方案/.test(q)){
    const intent=parseIntent(q,ctx.now);if(intent.dateInvalid)return {tool:'prepare_schedule_adjustment',args:{question:q},execute:async()=>fail(new Error(intent.dateInvalid!.reason))};
    const active=readBusinessTask(ctx.conversationId) as unknown as BusinessResult|null;const date=intent.date?.date||active?.date;
    const rows=date?effectiveSchedule(ctx.dataset,date).filter(r=>!intent.labName||r.labName===intent.labName):[];
    const target=rows.length===1?rows[0]:/刚才|这项任务|同一任务|原课程|此前方案/.test(q)&&active?.sourceLesson?rows.find(r=>r.id===active.sourceLesson!.id):undefined;
    if(!date||!target)return {tool:'query_business_context',args:{view:'schedule'},execute:async()=>{try{return result({view:'schedule',date:date||ctx.now.date,summary:'请在卡片选择日期与原课程，再比较候选；业务尚未提交。',context:await businessRequest('/context','GET',undefined,ctx.signal) as unknown as NativeContext},ctx);}catch(e){return fail(e);}}};
    return prepare({date,timetableId:target.id,supersedePlanId:active?.plan?.id});
  }
  return null;
}
/** Validate model recommendations against authoritative candidates; no free-form ungrounded claims. */
export function verifiedRecommendation(text:string,facts:BusinessResult[]):string|null{
  let parsed:{recommendations?:Array<{candidateId:string;reasonCodes:string[];evidenceRefs:string[];capacity?:number;headcount?:number}>};try{parsed=JSON.parse(text);}catch{return null;}
  if(!parsed.recommendations?.length||parsed.recommendations.length>3)return null;
  const reasons={capacity:'人数与容量满足约束',equipment:'课程设备需求满足约束',conflict_free:'房间、教师和班级在目标节次无冲突',service:'房间开放且该节次未停用'};
  const lines:string[]=[];
  for(const r of parsed.recommendations){const fact=facts.find(f=>f.candidates.some(c=>c.roomId+':'+c.periodKey===r.candidateId));const c=fact?.candidates.find(c=>c.roomId+':'+c.periodKey===r.candidateId);
    if(!fact||!c?.eligible||!Array.isArray(r.evidenceRefs)||!r.evidenceRefs.length||r.evidenceRefs.some(ref=>ref!=='snapshot:'+fact.sourceRevision)||!Array.isArray(r.reasonCodes)||r.reasonCodes.some(code=>!(code in reasons))||r.capacity!==undefined&&r.capacity!==c.capacity||r.headcount!==undefined&&r.headcount!==c.headcount)return null;
    lines.push(`${c.roomName} ${c.periodKey}：${r.reasonCodes.map(code=>reasons[code as keyof typeof reasons]).join('；')}（${c.headcount} 人 / 容量 ${c.capacity}；依据 snapshot:${fact.sourceRevision}）。`);
  }
  return '经业务事实校验的推荐：\n'+lines.join('\n');
}
