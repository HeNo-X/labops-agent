import { effectiveRole } from '../business/bridge.ts';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.ts';
import type { ToolContext, ToolExecution } from './registry.ts';
export interface KnowledgeDocument {id:string;title:string;version:string;effectiveFrom:string;effectiveTo?:string;roles:string[];keywords:string[];source:string;paragraphs:string[]}
export function documents():KnowledgeDocument[]{return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT,'seed','knowledge.json'),'utf8')) as KnowledgeDocument[];}
export function retrieve(query:string,role:string,date:string,docs=documents()):KnowledgeDocument[]{
  const q=query.toLowerCase();
  return docs.filter(d=>d.roles.includes(role)&&d.effectiveFrom<=date&&(!d.effectiveTo||d.effectiveTo>=date))
    .map(d=>({d,score:d.keywords.reduce((s,k)=>s+(q.includes(k.toLowerCase())?k.length:0),0)}))
    .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,4).map(x=>x.d);
}
export function runKnowledge(args:Record<string,unknown>,ctx:ToolContext):ToolExecution{
  if(typeof args['query']!=='string'||!args['query'].trim())return {ok:false,code:'query_required',message:'请提供检索问题',suggestions:[],summary:'缺少检索问题'};
  const hits=retrieve(args['query'],effectiveRole(ctx.actor?.role||'student'),ctx.now.date);
  const summary=hits.length?`检索到 ${hits.length} 份当前有效的系统操作说明。`:'知识库未命中有效依据，不能回答该制度或设备问题。';
  return {ok:true,resultKind:'knowledge',summary,result:{summary,scope:'本库仅含当前软件操作说明，学校管理制度与设备厂家手册尚待上传审核。',hits:hits.map(d=>({id:d.id,title:d.title,version:d.version,effectiveFrom:d.effectiveFrom,source:d.source,url:`/api/knowledge/${d.id}`,paragraphs:d.paragraphs.map((text,i)=>({locator:`§${i+1}`,text}))}))}};
}
