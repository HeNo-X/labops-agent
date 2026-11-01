export interface ScheduledSpec {name:string;kind:string;timezone:string;trigger:Record<string,unknown>;calendarPolicy:string;params:Record<string,unknown>;recipients:Array<Record<string,string>>;approvedEffects:string[];templateVersion?:number;prompt?:string;execMode?:'message'|'agent';agentTools?:string[]}
export function newSpec(username:string):ScheduledSpec{return {name:'',kind:'daily_report',timezone:'Asia/Shanghai',trigger:{type:'daily',time:'20:30'},calendarPolicy:'all_days',params:{},recipients:[{kind:'user',userId:username}],approvedEffects:['report','inbox']};}
export function copySpec(spec:ScheduledSpec):ScheduledSpec{return JSON.parse(JSON.stringify(spec));}
export function mergeSpec(original:ScheduledSpec,fields:Partial<ScheduledSpec>):ScheduledSpec{return {...copySpec(original),...fields,params:fields.params===undefined?{...original.params}:{...fields.params},trigger:fields.trigger===undefined?{...original.trigger}:{...fields.trigger},recipients:fields.recipients===undefined?copySpec(original).recipients:fields.recipients,approvedEffects:fields.approvedEffects===undefined?[...original.approvedEffects]:fields.approvedEffects};}
export function changeTemplate(spec:ScheduledSpec,kind:string,applicable:Record<string,string[]>){const allowed=applicable[kind]||[],removed=Object.keys(spec.params).filter(k=>!allowed.includes(k));const next=copySpec(spec);next.kind=kind;next.params=Object.fromEntries(Object.entries(next.params).filter(([key])=>allowed.includes(key)));if(next.trigger.type==='duty'&&kind!=='duty_reminder')next.trigger={type:'daily',time:'20:30'};return {spec:next,removed};}

/**
 * RAG 之外的第二条线（对标 ZCode 自动化模块）：**规则名保留用户原话短语**。
 * 简明设置里没有名称输入框——用户写了什么指令，规则名就该默认是什么，
 * 而不是"自定义指令"这种模板名。规则：
 *   · 仅 agent_prompt 模板参与自动命名（固定模板的名字=模板语义本身）；
 *   · 当前名为空 / 等于上次自动名 / 等于模板名（说明用户没起过名）→ 取原话前 16 字；
 *   · 用户改过名（三者都不等）→ 返回 null，**绝不覆盖用户起的名字**。
 * 返回 null 表示"保持现名"。
 */
export function autoRuleName(kind:string,prompt:string|undefined,currentName:string,lastAutoName:string,templateLabel:string):string|null{
  if(kind!=='agent_prompt'||!prompt||!prompt.trim())return null;
  const flat=prompt.trim().replace(/\s+/g,' ');
  const fromPrompt=flat.slice(0,16)+(flat.length>16?'…':'');
  if(!currentName||currentName===lastAutoName||currentName===templateLabel)return fromPrompt;
  return null;
}