import { businessRequest,businessScope,effectiveRole,rememberBusinessTask,readBusinessTask,listBusinessTasks } from '../business/bridge.ts';
import { queryCheckinStatus, PERSONAL_CHECKIN_RE } from './query-checkin-status.ts';
import { queryCheckinSummary, CHECKIN_SUMMARY_RE } from './query-checkin-summary.ts';
import { effectiveSchedule } from '../data/calendar.ts';
import { isValidDateString } from '../time/term.ts';
import { PERIOD_KEYS, isPeriodKey } from '../../shared/periods.ts';
import { normalizeLabName } from '../data/store.ts';
import { parseIntent } from '../agent/intent.ts';
import type { ToolExecution, ToolContext } from './registry.ts';
import type { BusinessResult, NativeContext, NativePlan, NativeCandidate } from '../../shared/business.ts';
function fail(e:unknown):ToolExecution{return {ok:false,code:(e as {code?:string}).code||'business_unavailable',message:e instanceof Error?e.message:'原系统不可用',suggestions:[],summary:'未取得有效业务依据，尚未提交操作'};}
// 自主执行（高危，spec.autonomous）：待确认方案直接提交原系统；失败不炸本轮，方案保留可人工确认
async function autoCommit(plan:NativePlan|undefined,ctx:ToolContext):Promise<string>{
  if(!ctx.autonomous||!plan||plan.state!=='awaiting_confirmation')return '';
  try{await businessRequest('/plans/commit','POST',{planId:plan.id,version:plan.version},ctx.signal);return '定时任务自主执行：方案已直接提交原系统，未等待人工确认。';}
  catch(e){return '定时任务自主执行：方案自动提交失败（'+(e instanceof Error?e.message:'未知错误')+'），方案已保留，仍可人工确认。';}
}
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
  try{if(effectiveRole()==='student'&&!['schedule','notifications','closures'].includes(String(args['view'])))throw Object.assign(new Error('学生共享聊天仅可查询本人课程、本人通知和公开房间状态'),{code:'scope_forbidden'});const context=await businessRequest('/context','GET',undefined,ctx.signal) as unknown as NativeContext;const view=(['schedule','duty','issues','notifications','closures','report','tasks','incidents','health'].includes(String(args['view']))?args['view']:'issues') as BusinessResult['view'];
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
/**
 * 原系统通知受众的口径归一（2026-10-06 修复 bad_audience）
 * ============================================================================
 *  事实：沙盒工具 `prepare_notification` 的受众是 `{kind:'class_ids'|'role_scope'|'all'}`，
 *  而原系统 `/workflow/preview`（notification.publish）只认 `{kind:'all'|'role'|'class'|'user'}`
 *  （见 Pages/server/operations.js 的 validateAudience）。两个工具同处一份工具清单，
 *  模型很容易把沙盒词表套到原系统工具上 —— 实测就会出现 `bad_audience 接收对象无效`。
 *
 *  这里只做**语义等价的词表翻译**（role_scope→role；单班级的 class_ids→class）。
 *  一旦有歧义（多班级、角色不明、给管理员群发）就明确报错并列出可选形式 ——
 *  通知的收件人绝不能靠猜，猜错就是打扰一批不该收到的人。
 */
export type AudienceCheck = { ok: true; audience: Record<string, unknown> } | { ok: false; message: string };

const AUDIENCE_FORMS = '请说明发给谁：全体（all）／志愿者（role=volunteer）／学生（role=student）／某个班级（class+className）／某个账号（user+userId）';

function checkRole(raw: unknown): AudienceCheck {
  const role = String(raw ?? '').trim();
  if (role === 'student' || role === 'volunteer') return { ok: true, audience: { kind: 'role', role } };
  if (role === 'admin' || role === '管理员') {
    return { ok: false, message: `原系统不支持给「管理员」群发通知；${AUDIENCE_FORMS}` };
  }
  return { ok: false, message: `role 只能是 student 或 volunteer（收到「${role || '（空）'}」）；${AUDIENCE_FORMS}` };
}

export function normalizeNoticeAudience(raw: unknown): AudienceCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: `缺少接收对象 audience；${AUDIENCE_FORMS}` };
  }
  const a = raw as Record<string, unknown>;
  const kind = String(a['kind'] ?? '').trim();
  // —— 沙盒词表（prepare_notification 用）→ 原系统词表 ——
  if (kind === 'role_scope') return checkRole(a['role']);
  if (kind === 'class_ids' || kind === 'classes' || kind === 'classNames') {
    const list = (Array.isArray(a['classIds']) ? a['classIds'] : Array.isArray(a['classes']) ? a['classes'] : []).map((x) => String(x).trim()).filter(Boolean);
    if (list.length === 1) return { ok: true, audience: { kind: 'class', className: list[0] } };
    if (list.length > 1) {
      return { ok: false, message: `原系统一次只能给一个班级发通知（收到 ${list.length} 个班级：${list.join('、')}）；请拆成多条通知，或改为发给全体/志愿者/学生` };
    }
    return { ok: false, message: `class_ids 没有给出班级名称；${AUDIENCE_FORMS}` };
  }
  // —— 原系统词表 ——
  if (kind === 'all') return { ok: true, audience: { kind: 'all' } };
  if (kind === 'role') return checkRole(a['role']);
  if (kind === 'class') {
    const className = String(a['className'] ?? '').trim();
    return className ? { ok: true, audience: { kind: 'class', className } } : { ok: false, message: `kind=class 时必须给出 className（班级名称）；${AUDIENCE_FORMS}` };
  }
  if (kind === 'user') {
    const userId = String(a['userId'] ?? a['username'] ?? '').trim();
    return userId ? { ok: true, audience: { kind: 'user', userId } } : { ok: false, message: `kind=user 时必须给出 userId（账号）；${AUDIENCE_FORMS}` };
  }
  return {
    ok: false,
    message:
      `接收对象类型「${kind || '（空）'}」无效：原系统只接受 all / role / class / user。` +
      `注意 class_ids 与 role_scope 是**沙盒工具** prepare_notification 的写法，原系统工具请用 class 与 role。${AUDIENCE_FORMS}`
  };
}

export async function prepareWorkflow(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
  if(ctx.mode==='chat')return fail(new Error('聊天模式不能准备业务方案，请切换任务模式'));
  // 通知：先把受众口径归一，口径不对就不发请求（省一次往返，也避免把无效方案落到原系统任务上）
  let payload:Record<string,unknown>=args;
  if(args['kind']==='notification.publish'){
    const audited=normalizeNoticeAudience(args['audience']);
    if(!audited.ok)return {ok:false,code:'bad_audience',message:audited.message,suggestions:[],summary:'通知的接收对象未确定，尚未提交任何内容'};
    payload={...args,audience:audited.audience};
  }
  // 管理员代录：把工具词表归一到主系统口径（roomId→labId；periodKeys 单元素→periodKey），其余校验交给主系统
  if(args['kind']==='checkin.manual'){
    payload={...payload,labId:args['labId']||args['roomId'],periodKey:args['periodKey']||(Array.isArray(args['periodKeys'])&&args['periodKeys'].length?args['periodKeys'][0]:undefined)};
    delete payload['roomId'];delete payload['periodKeys'];
  }
  try{const endpoint=payload['kind']==='duty.handover'?'/handover/preview':'/workflow/preview';const r=await businessRequest(endpoint,'POST',{...payload,conversationId:ctx.conversationId||undefined},ctx.signal);const plan=r['plan'] as NativePlan;const autoNote=await autoCommit(plan,ctx);
    return result({plan,task:r['task'] as BusinessResult['task'],taskId:plan.taskId,view:plan.kind==='resource.patch'?'health':plan.kind.startsWith('key.')?'tasks':plan.kind.startsWith('duty.')?'duty':plan.kind.startsWith('issue.')?'issues':plan.kind.startsWith('closure.')?'closures':plan.kind==='checkin.manual'?'checkin':'notifications',sourceRevision:plan.sourceRevision,summary:autoNote||(plan.kind==='checkin.manual'?'管理员代录方案已准备：记录标记 agent-manual 并全程审计，业务未提交，请核对后本人点击确认。':plan.kind.startsWith('key.')?'钥匙借还方案已准备：台账尚未变化，请核对借用人/归还状态后本人点击确认。':'原系统待确认方案已准备；业务尚未提交，请核对后本人点击确认。')},ctx);
  }catch(e){return fail(e);}
}
export async function queryIncident(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
 try{const incidentId=typeof args['incidentId']==='string'?args['incidentId'].trim():'';if(!incidentId)return queryBusiness({view:'incidents'},ctx);const r=await businessRequest('/incidents/'+incidentId,'GET',undefined,ctx.signal);return result({view:'incidents',incident:r['incident'] as BusinessResult['incident'],impact:r['impact'] as BusinessResult['impact'],taskId:(r['incident'] as BusinessResult['incident'])?.taskId,summary:'故障事件及其原系统关联对象已回查；工单登记不代表修复。'},ctx);}catch(e){return fail(e);}
}
/**
 * 主系统 /incidents/draft 需要 roomId+date+description+periodKeys 四项，但工具清单只把
 * action 标成必填——模型据此漏项时，请求会在原系统撞成一句"请选择故障影响节次"，
 * 既没给合法值也没给映射，只能反复重试到步数上限（2026-11-10 实机演示实测到）。
 * 这里在发起请求前按同一口径校验，并把缺什么、合法值是什么一次说清；缺资料时模型应先问用户。
 */
function assertIncidentDraftArgs(args:Record<string,unknown>,ctx:ToolContext):{roomId:string}{
  const bad=(code:string,message:string)=>Object.assign(new Error(message),{code});
  const rawRoom=typeof args['roomId']==='string'?args['roomId'].trim():'';
  if(!rawRoom)throw bad('missing_room','登记故障事件需要 roomId：房间编号或房号都可（如 E310），建议取 query_business_context 返回的 rooms[].id。');
  // 主系统只认 rooms[].id，模型常交房间名（"E310"）→ 撞一句"请选择实验室"再回头查清单，
  // 一次演示要多烧两轮。服务端已有房间清单，这里做唯一映射：编号或名字都收，歧义才报错。
  // 清单必须同时含上机实验室与开放实验室——只查 labs 会让 5 楼 D5xx 全部报"找不到房间"。
  const known=[...(ctx.dataset?.labs||[]),...(ctx.dataset?.openLabs||[])] as Array<{id:string;name:string}>;
  const byId=known.find(l=>l.id===rawRoom);
  const byName=byId?[]:known.filter(l=>normalizeLabName(l.name)===normalizeLabName(rawRoom));
  if(byId===undefined&&byName.length===0)throw bad('lab_not_found',`系统里没有房间「${rawRoom}」；请改用 rooms[].id，可选：${known.slice(0,24).map(l=>l.id+'（'+l.name+'）').join('、')||'清单为空'}`);
  if(!byId&&byName.length>1)throw bad('lab_ambiguous',`房号「${rawRoom}」在系统里有 ${byName.length} 条登记：${byName.map(l=>l.id+'（'+l.name+'）').join('、')}；请向用户确认指的是哪一条，不要自行挑选。`);
  const roomId=(byId||byName[0]!).id;
  const date=typeof args['date']==='string'?args['date'].trim():'';
  if(!isValidDateString(date))throw bad('bad_date',`登记故障事件需要合法 date（YYYY-MM-DD，用服务端给出的日期），收到：${date||'（未提供）'}。`);
  const description=typeof args['description']==='string'?args['description'].trim():'';
  if(description.length<4)throw bad('missing_description','登记故障事件需要 description：用户明确声明的故障事实原文，不得代用户猜测。');
  const raw=args['periodKeys'];
  if(!Array.isArray(raw)||!raw.length)throw bad('missing_period',`登记故障事件需要 periodKeys（影响节次，数组）：合法值 ${PERIOD_KEYS.join(' / ')}（上午第一大节=am1、上午第二大节=am2、下午第一大节=pm1、下午第二大节=pm2、晚上AB节=eve_ab、晚上CD节=eve_cd）。用户未说明影响哪些节次时请先向用户确认，不要猜测。`);
  const illegal=raw.filter(p=>!isPeriodKey(p));
  if(illegal.length)throw bad('bad_period',`periodKeys 含非法节次：${illegal.join(' / ')}；合法值 ${PERIOD_KEYS.join(' / ')}（上午第一大节=am1、上午第二大节=am2、下午第一大节=pm1、下午第二大节=pm2、晚上AB节=eve_ab、晚上CD节=eve_cd）。`);
  return {roomId};
}
export async function prepareIncident(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
 if(ctx.mode==='chat')return fail(new Error('请切换任务模式准备事件方案'));
 try{const action=args['action']||'draft',incidentId=args['incidentId'];if(!['draft','analyze','preview','restore','takeover'].includes(String(action)))throw new Error('事件动作不支持');if(action!=='draft'&&typeof incidentId!=='string')throw new Error('请先查询并指定原系统事件编号');
 if(action!=='draft'&&typeof incidentId!=='string')throw new Error('请先查询并指定原系统事件编号');
 const patch=action==='draft'?assertIncidentDraftArgs(args,ctx):{};
 const endpoint=action==='draft'?'/incidents/draft':'/incidents/'+incidentId+'/'+action;const r=await businessRequest(endpoint,'POST',{...args,...patch,conversationId:ctx.conversationId||undefined},ctx.signal),plan=r['plan'] as NativePlan|undefined;
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
      const kind=/未读.*通知/.test(q)?'notice_reminder':/开门|提前.*开门|开实验室的门/.test(q)?'lab_open_reminder':/签到.*(?:缺口|情况|提醒)|上机.*签到/.test(q)?'session_checkin_reminder':/巡检|巡查/.test(q)?'patrol_reminder':/值班/.test(q)?'duty_reminder':/明日|明天/.test(q)?'tomorrow_courses':/工单|催办/.test(q)?'due_followup':/日报/.test(q)?'daily_report':null;
      if(!tm||!daily||unsupported||!kind||Number(tm[1])>23||Number(tm[2])>59)return {tool:'query_scheduled_jobs',args:{},execute:async()=>result({summary:'请在“定时任务与提醒”面板核对模板、每天/每周/正式班次前、时间与接收对象，预览后本人确认。本轮未创建规则方案。'},ctx)};
      const args={action:'create',spec:{kind,calendarPolicy:/教学日/.test(q)?'teaching_days':'all_days',trigger:{type:'daily',time:tm[1]!.padStart(2,'0')+':'+tm[2]},recipients:[{kind:'user',userId:businessScope().principal?.username}],approvedEffects:['report','inbox']}};return {tool:'prepare_scheduled_job',args,execute:()=>prepareScheduled(args,ctx)};
    }
    return {tool:'query_scheduled_jobs',args:{view:/结果|执行记录/.test(q)?'results':'rules'},execute:()=>queryScheduled({view:/结果|执行记录/.test(q)?'results':'rules'},ctx)};
  }
  if(/准备包/.test(q))return {tool:'query_scheduled_jobs',args:{view:'preparation'},execute:()=>queryScheduled({view:'preparation'},ctx)};
  // 签到汇总（只读，仅管理员）：问"签到情况/缺口/统计"且当前身份非学生时走汇总；
  // 学生问"签到情况"回落到本人状态（下一分支），保证学生永远拿不到缺口名单。
  if(CHECKIN_SUMMARY_RE.test(q)&&effectiveRole()!=='student'){
    const d=parseIntent(q,ctx.now).date?.date;
    const room=[...(ctx.dataset.labs||[]),...(ctx.dataset.openLabs||[])].find(l=>l.name&&q.includes(l.name));
    const args:{date?:string;labId?:string}={...(d?{date:d}:{}),...(room?{labId:room.id}:{})};
    return {tool:'query_checkin_summary',args,execute:()=>queryCheckinSummary(args,ctx)};
  }
  // 管理员代录（draft，任务模式）：只匹配显式"补录/补签/代录"问法；解析得动的字段先填，
  // 解析不动的留给主系统校验如实报错——绝不猜学号、节次或原因。
  if(/补录|补签|代录/.test(q)&&effectiveRole()!=='student'){
    const d=parseIntent(q,ctx.now).date?.date;
    const sno=/\d{5,}/.exec(q)?.[0];
    const room=[...(ctx.dataset.labs||[]),...(ctx.dataset.openLabs||[])].find(l=>l.name&&q.includes(l.name));
    const periodKey=([[/上午第一大节|上午第一/,'am1'],[/上午第二大节|上午第二/,'am2'],[/下午第一大节|下午第一/,'pm1'],[/下午第二大节|下午第二/,'pm2'],[/晚上\s*AB/i,'eve_ab'],[/晚上\s*CD/i,'eve_cd']] as Array<[RegExp,string]>).find(([re])=>re.test(q))?.[1];
    if(!sno)return {tool:'prepare_business_workflow',args:{kind:'checkin.manual'},execute:async()=>fail(new Error('请说明要补录的学号、日期、节次、实验室与代录原因，例如：给 2023002 补录今天下午第一大节在 E310 的签到，原因：设备故障无法扫码'))};
    const args:Record<string,unknown>={kind:'checkin.manual',targetUsername:sno,...(d?{date:d}:{}),...(periodKey?{periodKey}:{}),...(room?{labId:room.id}:{})};
    const reason=/原因[：:]\s*(.+)$/.exec(q)?.[1]?.trim();
    if(reason)args['reason']=reason;
    return {tool:'prepare_business_workflow',args,execute:()=>prepareWorkflow(args,ctx)};
  }
  // 学生本人签到状态（只读）：只匹配"我的签到"类问法；签到提醒规则仍由上方定时分支承接
  if(PERSONAL_CHECKIN_RE.test(q)){const d=parseIntent(q,ctx.now).date?.date;return {tool:'query_checkin_status',args:d?{date:d}:{},execute:()=>queryCheckinStatus(d?{date:d}:{},ctx)};}
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
  let parsed:unknown;try{parsed=JSON.parse(text);}catch{return null;}
  const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!isObject(parsed)||Object.keys(parsed).some(key=>key!=='recommendations')||!Array.isArray(parsed['recommendations'])||!parsed['recommendations'].length||parsed['recommendations'].length>3)return null;
  const reasons={capacity:'人数与容量满足约束',equipment:'课程设备需求满足约束',conflict_free:'房间、教师和班级在目标节次无冲突',service:'房间开放且该节次未停用'};
  const fields=new Set(['candidateId','reasonCodes','evidenceRefs','capacity','headcount']),seen=new Set<string>();
  const lines:string[]=[];
  for(const r of parsed['recommendations']){
    if(!isObject(r)||Object.keys(r).some(key=>!fields.has(key))||typeof r['candidateId']!=='string'||seen.has(r['candidateId']))return null;
    const reasonCodes=r['reasonCodes'],evidenceRefs=r['evidenceRefs'];
    if(!Array.isArray(reasonCodes)||reasonCodes.some(code=>typeof code!=='string'||!Object.hasOwn(reasons,code))||!Array.isArray(evidenceRefs)||!evidenceRefs.length||evidenceRefs.some(ref=>typeof ref!=='string'||!ref.trim()))return null;
    for(const key of ['capacity','headcount'])if(Object.hasOwn(r,key)&&(typeof r[key]!=='number'||!Number.isFinite(r[key])))return null;
    const matches=(c:NativeCandidate)=>c!=null&&typeof c.roomId==='string'&&typeof c.periodKey==='string'&&c.roomId+':'+c.periodKey===r['candidateId'];
    const fact=Array.isArray(facts)?facts.find(f=>f&&Array.isArray(f.candidates)&&f.candidates.some(matches)):undefined;
    const c=fact?.candidates.find(matches);
    if(!fact||!c||c.eligible!==true||evidenceRefs.some(ref=>ref!=='snapshot:'+fact.sourceRevision)||r['capacity']!==undefined&&r['capacity']!==c.capacity||r['headcount']!==undefined&&r['headcount']!==c.headcount)return null;
    seen.add(r['candidateId']);
    lines.push(`${c.roomName} ${c.periodKey}：${reasonCodes.map(code=>reasons[code as keyof typeof reasons]).join('；')}（${c.headcount} 人 / 容量 ${c.capacity}；依据 snapshot:${fact.sourceRevision}）。`);
  }
  return '经业务事实校验的推荐：\n'+lines.join('\n');
}
