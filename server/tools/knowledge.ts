import {businessRequest,isBusinessConnected} from '../business/bridge.ts';
import { effectiveRole } from '../business/bridge.ts';
import { searchChunks } from './knowledge-search.ts';
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

/** 文档级命中 + 段落级排序：hits 按最相关文档排序，每篇内只给命中的段落，§N 仍是原文序号 */
export interface RankedHit {doc:KnowledgeDocument;paragraphs:Array<{index:number;text:string}>;via:Array<'keyword'|'bm25'>;score:number}
export function retrieveRanked(query:string,role:string,date:string,docs=documents(),maxDocs=4,maxParagraphs=4):RankedHit[]{
  const chunks=searchChunks(query,effectiveRole(role),date,docs,maxDocs*maxParagraphs);
  const byId=new Map<string,KnowledgeDocument>(docs.map(d=>[d.id,d]));
  const hits=new Map<string,RankedHit>();
  for(const c of chunks){
    const doc=byId.get(c.docId);if(!doc)continue;
    let h=hits.get(c.docId);
    if(!h){h={doc,paragraphs:[],via:[],score:0};hits.set(c.docId,h);}
    if(h.paragraphs.length>=maxParagraphs)continue;
    h.paragraphs.push({index:c.index,text:c.text});
    for(const v of c.via) if(!h.via.includes(v)) h.via.push(v);
    h.score+=c.score;
  }
  return [...hits.values()].sort((a,b)=>b.score-a.score).slice(0,maxDocs);
}
export async function runKnowledge(args:Record<string,unknown>,ctx:ToolContext):Promise<ToolExecution>{
  if(typeof args['query']!=='string'||!args['query'].trim())return {ok:false,code:'query_required',message:'请提供检索问题',suggestions:[],summary:'缺少检索问题'};
  if(isBusinessConnected()&&/手册|设备|厂家|维修|投影|铭牌/.test(args['query'])){
    try{const raw=await businessRequest('/evidence/manuals?q='+encodeURIComponent(args['query']));const manuals=raw['manuals'] as Array<{id:string;title:string;device:string;version:string;sourceUrl:string;importedAt:string;paragraphs:Array<{id:string;text:string}>}>;
      const summary=manuals.length?'已找到当前权限范围内的设备资料。':'没有命中已上传审核的设备资料，维修规范未知。';return {ok:true,resultKind:'knowledge',summary,result:{summary,scope:'实际导入并按权限检索的设备资料；照片不能替代人工验收。',hits:manuals.map(d=>({id:d.id,title:d.title+'（适用设备 '+d.device+'）',version:d.version,effectiveFrom:d.importedAt.slice(0,10),source:'主系统管理员审核资料：'+d.sourceUrl,url:d.sourceUrl,paragraphs:d.paragraphs.map(p=>({locator:d.id+'@'+d.version+'#'+p.id,text:p.text}))}))}};
    }catch(e){return {ok:false,code:'evidence_unavailable',message:(e as Error).message,suggestions:[],summary:'未取得有效设备资料'};}
  }
  // 角色必须经 effectiveRole：它取服务端核验的真实身份，客户端声明的角色不得提权
  const hits=retrieveRanked(args['query'],effectiveRole(ctx.actor?.role||'student'),ctx.now.date);
  const summary=hits.length?`检索到 ${hits.length} 份当前有效的系统操作说明。`:'知识库未命中有效依据，不能回答该制度或设备问题。';
  return {ok:true,resultKind:'knowledge',summary,result:{summary,scope:'本库仅含当前软件操作说明，学校管理制度与设备厂家手册尚待上传审核。',hits:hits.map(h=>({id:h.doc.id,title:h.doc.title,version:h.doc.version,effectiveFrom:h.doc.effectiveFrom,source:h.doc.source,url:`/api/knowledge/${h.doc.id}`,paragraphs:h.paragraphs.map(p=>({locator:`§${p.index}`,text:p.text}))}))}};
}
