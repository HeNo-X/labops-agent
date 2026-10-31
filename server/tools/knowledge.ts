import {businessRequest,isBusinessConnected} from '../business/bridge.ts';
import { effectiveRole } from '../business/bridge.ts';
import { searchChunks, eligibleDocs } from './knowledge-search.ts';
import { vectorRecallByVec, rankManualParagraphs } from './knowledge-vector.ts';
import { embedQuery, isEmbeddingEnabled } from '../llm/embeddings.ts';
import { rerankHits } from './knowledge-rerank.ts';
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
export interface RankedHit {doc:KnowledgeDocument;paragraphs:Array<{index:number;text:string}>;via:Array<'keyword'|'bm25'|'vector'>;score:number}
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

/**
 * RAG 批次1：三路混合检索（关键词 + BM25 + 向量）。
 * 向量路是**锦上添花**：未启用（EMBEDDING_ENABLED=0）、无 Key、索引未建、
 * 维度不符、调用失败——任何一种情况都静默退回两路词法检索，检索本身绝不因
 * 向量路失败而失败。opts 供测试注入（假上游 / 确定性向量 / :memory: 库）。
 */
export interface HybridOptions {
  enabled?: boolean;
  embed?: typeof embedQuery;
  db?: import('node:sqlite').DatabaseSync;
}
export async function retrieveHybrid(query:string,role:string,date:string,docs=documents(),maxDocs=4,maxParagraphs=4,opts:HybridOptions={}):Promise<RankedHit[]>{
  const effective=effectiveRole(role);
  const eligible=eligibleDocs(docs,effective,date);
  let vectorRanks:Map<string,number>|null=null;
  const gate=opts.enabled ?? isEmbeddingEnabled();
  if(gate&&eligible.length&&query.trim()){
    try{
      const embed=opts.embed ?? embedQuery;
      const qv=await embed(query);
      vectorRanks=vectorRecallByVec(qv,eligible,maxDocs*maxParagraphs,opts.db);
      if(!vectorRanks.size)vectorRanks=null; // 索引未建或全部维度不符 → 纯词法路
    }catch{vectorRanks=null;} // 向量路失败如实降级，不影响检索
  }
  return retrieveRankedChunks(searchChunks(query,effective,date,docs,maxDocs*maxParagraphs,vectorRanks),docs,maxDocs,maxParagraphs);
}

/** 与 retrieveRanked 相同的聚合（chunks → 文档级 hits），抽出复用 */
function retrieveRankedChunks(chunks:ReturnType<typeof searchChunks>,docs=documents(),maxDocs=4,maxParagraphs=4):RankedHit[]{
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
      // RAG 批次2：向量路对**主系统已返回**的手册段落排序（集合权威在主系统侧，
      // 权限在它那边过滤；排序失败保持原序，不影响可用性）
      if(manuals.length&&isEmbeddingEnabled()){
        try{
          const qv=await embedQuery(args['query']);
          const ranks=rankManualParagraphs(qv,manuals);
          if(ranks.size)manuals.forEach((m)=>{m.paragraphs=[...m.paragraphs].sort((a,b)=>(ranks.get(`m:${m.id}@${m.version}#${a.id}`)??1e9)-(ranks.get(`m:${m.id}@${m.version}#${b.id}`)??1e9));});
        }catch{/* 排序失败保持原序 */}
      }
      const summary=manuals.length?'已找到当前权限范围内的设备资料。':'没有命中已上传审核的设备资料，维修规范未知。';return {ok:true,resultKind:'knowledge',summary,result:{summary,scope:'实际导入并按权限检索的设备资料；照片不能替代人工验收。',hits:manuals.map(d=>({id:d.id,title:d.title+'（适用设备 '+d.device+'）',version:d.version,effectiveFrom:d.importedAt.slice(0,10),source:'主系统管理员审核资料：'+d.sourceUrl,url:d.sourceUrl,paragraphs:d.paragraphs.map(p=>({locator:d.id+'@'+d.version+'#'+p.id,text:p.text}))}))}};
    }catch(e){return {ok:false,code:'evidence_unavailable',message:(e as Error).message,suggestions:[],summary:'未取得有效设备资料'};}
  }
  // 角色必须经 effectiveRole：它取服务端核验的真实身份，客户端声明的角色不得提权
  // RAG 批次1：检索走三路混合（向量路按配置静默启用/降级）
  // RAG 批次3：LLM 重排按配置启用（RERANK_LLM，缺省关；任何失败静默回原序）
  const retrieved=await retrieveHybrid(args['query'],effectiveRole(ctx.actor?.role||'student'),ctx.now.date);
  const hits=await rerankHits(args['query'],retrieved,(ctx.mode??'task')==='chat'?'chat':'task',undefined,{signal:ctx.signal});
  const summary=hits.length?`检索到 ${hits.length} 份当前有效的系统操作说明。`:'知识库未命中有效依据，不能回答该制度或设备问题。';
  return {ok:true,resultKind:'knowledge',summary,result:{summary,scope:'本库仅含当前软件操作说明，学校管理制度与设备厂家手册尚待上传审核。',hits:hits.map(h=>({id:h.doc.id,title:h.doc.title,version:h.doc.version,effectiveFrom:h.doc.effectiveFrom,source:h.doc.source,url:`/api/knowledge/${h.doc.id}`,paragraphs:h.paragraphs.map(p=>({locator:`§${p.index}`,text:p.text}))}))}};
}
