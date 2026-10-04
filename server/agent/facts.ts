import crypto from 'node:crypto';
import { getDb } from '../persistence/db.ts';
import { businessScope } from '../business/bridge.ts';
import type { ToolExecution } from '../tools/registry.ts';
import type { ScheduleQueryResult } from '../../shared/types.ts';
import type { Intent } from './intent.ts';
import { parseIntent } from './intent.ts';
import type { ServerNow } from '../time/term.ts';

type Fact = Extract<ToolExecution,{ok:true}>;
export interface VerifiedFact {factId:string;conversationId:string;toolName:string;scopeKey:string;principal:unknown;query:Record<string,unknown>;coverage:unknown;sourceRevision:string|null;queriedAt:string;purpose:'historical_evidence';fact:Fact}
function schema(){getDb().exec(`CREATE TABLE IF NOT EXISTS verified_fact_sets(factId TEXT PRIMARY KEY,ownerId TEXT NOT NULL,sessionId TEXT NOT NULL,scopeKey TEXT NOT NULL,toolName TEXT NOT NULL,envelope TEXT NOT NULL,updatedAt INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_fact_scope ON verified_fact_sets(ownerId,sessionId,scopeKey,updatedAt);`);}
export function saveFacts(owner:string,session:string,fact:Fact,meta:{toolName?:string;query?:Record<string,unknown>;sourceRevision?:string}={}):void{
  schema();const scope=businessScope(owner),result=fact.result as unknown as Record<string,unknown>;
  const envelope:VerifiedFact={factId:'fact-'+crypto.randomUUID(),conversationId:session,toolName:meta.toolName||fact.resultKind,scopeKey:scope.scopeKey,principal:scope.principal,
    query:meta.query||{labName:result['labName'],date:result['date'],periodKey:result['periodFilter']},coverage:result['coverage']??(result['periodFilter']?'partial':'query_scope'),sourceRevision:meta.sourceRevision||(typeof result['sourceRevision']==='string'?result['sourceRevision']:null),queriedAt:new Date().toISOString(),purpose:'historical_evidence',fact};
  getDb().prepare('INSERT INTO verified_fact_sets VALUES (?,?,?,?,?,?,?)').run(envelope.factId,owner,session,scope.scopeKey,envelope.toolName,JSON.stringify(envelope),Date.now());
  getDb().prepare('DELETE FROM verified_fact_sets WHERE ownerId=? AND sessionId=? AND factId NOT IN (SELECT factId FROM verified_fact_sets WHERE ownerId=? AND sessionId=? ORDER BY updatedAt DESC,rowid DESC LIMIT 50)').run(owner,session,owner,session);
}
export function listFacts(owner:string,session:string):VerifiedFact[]{schema();return (getDb().prepare('SELECT envelope FROM verified_fact_sets WHERE ownerId=? AND sessionId=? AND scopeKey=? AND updatedAt>? ORDER BY updatedAt DESC,rowid DESC LIMIT 50').all(owner,session,businessScope(owner).scopeKey,Date.now()-86400000) as Array<{envelope:string}>).map(r=>JSON.parse(r.envelope) as VerifiedFact);}
export function readFacts(owner:string,session:string):Fact|null{return listFacts(owner,session)[0]?.fact||null;}
export function wantsScheduleTable(q:string):boolean{return /刚才|上次|上述|上面|前面|此前|前一次|第[一二三123]份|fact-[a-f0-9-]+/.test(q)&&/表格|两列|二列|只保留|只看|过滤|汇总|去重|排序/.test(q);}
export type FactTransform={kind:'none'}|{kind:'error';message:string}|{kind:'query';args:Record<string,unknown>;question:string}|{kind:'answer';answer:string;fact:VerifiedFact};
const fields=[['课程','courseName'],['节次','periodLabel'],['班级','className'],['教师','teacher'],['开始时间','startTime'],['结束时间','endTime']] as const;
function cell(s:unknown){return String(s??'').replace(/\|/g,'／').replace(/[\r\n]/g,' ');}
function columns(q:string){
  if(!/列|字段/.test(q))return fields.slice(0,2);
  if(/学分|学时|成绩|人数|手机号|设备|任意字段/.test(q))return null;
  const selected=fields.filter(([label])=>q.includes(label)).sort((a,b)=>q.indexOf(a[0])-q.indexOf(b[0]));return selected.length?selected:fields.slice(0,2);
}
function courseFilter(q:string):{kind:'none'}|{kind:'error';message:string}|{kind:'filter';value:string}{
  const prefix=/课程(?:名称|名)?\s*(?:等于|为|是|[:：=])\s*/.exec(q);
  if(!prefix)return /只保留|只看|过滤/.test(q)&&/课程(?:名称|名)/.test(q)?{kind:'error',message:'课程筛选未能解析，请写“课程名称等于「完整课程名」”；不支持没有依据的课程别名。'}:{kind:'none'};
  const rest=q.slice(prefix.index+prefix[0].length);
  const match=/^(?:“([^”]+)”|「([^」]+)」|"([^"]+)"|'([^']+)'|([^\s，,。；;]+))/.exec(rest);
  const rawValue=match?.slice(1).find(Boolean)?.trim();
  const value=match?.[5]?rawValue?.replace(/的(?:课程|记录|教学活动)$/,''):rawValue;
  if(!value)return {kind:'error',message:'课程筛选缺少完整名称，请补充“课程名称等于「完整课程名」”。'};
  return {kind:'filter',value};
}
export function transformSchedule(question:string,owner:string,session:string,now:ServerNow):FactTransform{
  if(!wantsScheduleTable(question))return {kind:'none'};
  const facts=listFacts(owner,session).filter(f=>f.fact.resultKind==='schedule');
  const id=/fact-[a-f0-9-]+/.exec(question)?.[0];
  const ord=/第([一二三123])份/.exec(question)?.[1];
  const index=ord?({'一':1,'二':2,'三':3,'1':1,'2':2,'3':3}[ord]||1)-1:null;
  const selected=id?facts.find(f=>f.factId===id):index!==null?[...facts].reverse()[index]:/前一次/.test(question)?facts[1]:facts[0];
  if(!selected||selected.fact.resultKind!=='schedule')return {kind:'error',message:'没有该身份与授权范围下的历史课表依据，请指定房间、日期重新查询。'};
  const r=selected.fact.result,explicit:Intent=parseIntent(question,now);
  if(explicit.dateInvalid)return {kind:'error',message:explicit.dateInvalid.reason};
  const changed=explicit.labName&&explicit.labName!==r.labName||explicit.date&&explicit.date.date!==r.date;
  const wanted=explicit.periodKey?[explicit.periodKey]:explicit.periodKeys;
  const wider=Boolean(wanted&&r.periodFilter&&wanted.some(p=>p!==r.periodFilter));
  if(changed||wider||/最新|重新查|重新查询|实时|现在/.test(question))return {kind:'query',args:{labName:explicit.labName||r.labName,date:explicit.date?.date||r.date,...(explicit.periodKey?{periodKey:explicit.periodKey}:{})},question};
  const cols=columns(question);if(!cols)return {kind:'error',message:'课表依据不含所请求的字段（'+(question.match(/学分|学时|成绩|人数|手机号|设备|任意字段/g)||[]).join('、')+'）。目前支持课程、节次、班级、教师、开始时间和结束时间；请指定其中的列。'};
  const filter=courseFilter(question);if(filter.kind==='error')return filter;
  if(/只保留|只看|过滤/.test(question)&&!wanted&&filter.kind==='none')return {kind:'error',message:'该过滤条件尚不能可靠解析，请指定上午、下午、晚上或完整课程名称。'};
  let rows=r.lessons.filter(l=>!wanted||wanted.includes(l.periodKey));
  const course=filter.kind==='filter'?filter.value:null;if(course)rows=rows.filter(l=>l.courseName===course);
  if(/排序/.test(question)){const sortField=fields.find(([label])=>question.includes('按'+label))?.[1]||'startTime';rows=[...rows].sort((a,b)=>String(a[sortField]).localeCompare(String(b[sortField]))||a.courseName.localeCompare(b.courseName));}
  if(/降序|倒序/.test(question))rows=[...rows].reverse();
  const origin=`${r.labName} · ${r.date} · ${r.provenance.sourceLabel}（历史事实转换；查询时间：${r.provenance.queryTime}；事实编号：${selected.factId}；源版本：${selected.sourceRevision||'未提供'}）`+(course?`\n实际筛选条件：课程名称等于「${course}」。`:'');
  if(/汇总/.test(question))return {kind:'answer',fact:selected,answer:origin+`\n\n符合条件 ${rows.length} 条班级展开记录，${new Set(rows.map(l=>l.timetableId)).size} 个教学活动，${new Set(rows.map(l=>l.periodKey)).size} 个大节，${new Set(rows.map(l=>l.className)).size} 个班级。`};
  const data=rows.map(l=>cols.map(([label,key])=>label==='节次'?`${l.periodLabel}（${l.startTime}–${l.endTime}）`:l[key]));
  const unique=/去重/.test(question)?[...new Map(data.map(row=>[JSON.stringify(row),row])).values()]:data;
  const table='| '+cols.map(([label])=>label==='节次'?'上课节次':label).join(' | ')+' |\n| '+cols.map(()=>'---').join(' | ')+' |\n'+unique.map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n');
  return {kind:'answer',fact:selected,answer:origin+'\n\n'+table+`\n\n${wanted||course?'筛选后':'保留原结果全部'} ${rows.length} 条记录${/去重/.test(question)?`，按展示字段去重后 ${unique.length} 行`:'；合班展开的记录保持独立'}。\n`+r.notes.join('\n')};
}
export function scheduleTable(r:ScheduleQueryResult):string{return `${r.labName} · ${r.date} · ${r.provenance.sourceLabel}（沿用已核实查询，查询时间：${r.provenance.queryTime}）\n\n| 课程 | 上课节次 |\n| --- | --- |\n`+r.lessons.map(l=>`| ${cell(l.courseName)} | ${cell(l.periodLabel)}（${l.startTime}–${l.endTime}） |`).join('\n')+`\n\n保留原结果全部 ${r.lessons.length} 条记录；合班展开的记录保持独立。\n`+r.notes.join('\n');}
