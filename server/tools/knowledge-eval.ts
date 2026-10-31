/**
 * RAG 批次 4：知识检索质量评估（金样本 runner）
 * ============================================================================
 *  金样本 = 「用户问题 → 应命中的文档 + 应出现的原文片段」。评估双配置跑同一批
 *  样本：① 词法两路（关键词+BM25，确定性、任何环境可复现）；② 三路混合
 *  （+向量，EMBEDDING_ENABLED 且索引在库时；不可得则如实标 skipped）。
 *  指标：hit@1 / hit@3（应命中文档排进第 1 / 前 3）与 textHit（该文档返回的
 *  段落里确实出现金样本片段——防"命中文档但引错段落"）。
 *  **改检索（分块/召回/融合/重排）必须跑评估**：质量门测试按基线锁分。
 */
import { retrieveHybrid } from './knowledge.ts';
import { isEmbeddingEnabled } from '../llm/embeddings.ts';

export interface GoldCase {
  /** 用户原话（越口语越好） */
  q: string;
  /** 应命中的文档 id */
  doc: string;
  /** 应出现在该文档被引段落里的原文片段（防引错段落） */
  text: string;
  /** 检索身份（缺省 admin——admin 可见全部文档） */
  role?: string;
}

export interface CaseResult {
  q: string;
  doc: string;
  /** 第 1 名即应命中文档 */
  hit1: boolean;
  /** 前 3 含应命中文档 */
  hit3: boolean;
  /** 该文档被引段落里出现金样本片段 */
  textHit: boolean;
  topDoc: string | null;
  via: string[];
}

export interface EvalReport {
  total: number;
  hit1: number;
  hit3: number;
  textHit: number;
  mode: 'lexical' | 'hybrid';
  /** 真·混合模式（至少一条命中走了向量路）；false = 实际等价词法两路 */
  vectorUsed: boolean;
  results: CaseResult[];
}

export const EVAL_DATE = '2026-11-30'; // 晚于全部语料生效日，恒有效

/** 跑一批金样本（单配置）。opts 透传给 retrieveHybrid（测试注入向量路） */
export async function runKnowledgeEval(cases: GoldCase[], docs: NonNullable<Parameters<typeof retrieveHybrid>[3]>, opts: Parameters<typeof retrieveHybrid>[6] = {}): Promise<EvalReport> {
  const wantVector = opts.enabled ?? isEmbeddingEnabled();
  const results: CaseResult[] = [];
  for (const c of cases) {
    const role = c.role ?? 'admin';
    // 与生产口径一致（runKnowledge 用 maxDocs=4/maxParagraphs=4）；hit@3 门只看前 3
    const hits = await retrieveHybrid(c.q, role, EVAL_DATE, docs, 3, 4, { ...opts, enabled: wantVector });
    const hitDoc = hits.find((h) => h.doc.id === c.doc);
    const result: CaseResult = {
      q: c.q,
      doc: c.doc,
      hit1: hits[0]?.doc.id === c.doc,
      hit3: Boolean(hitDoc),
      textHit: Boolean(hitDoc?.paragraphs.some((p) => p.text.includes(c.text))),
      topDoc: hits[0]?.doc.id ?? null,
      via: hitDoc?.via ?? []
    };
    results.push(result);
  }
  // 模式以**结果为准**：任一命中带 via:'vector' 才算真混合——向量化腿的
  // 启用/降级是 retrieveHybrid 的内部细节，报告不靠猜
  const vectorUsed = results.some((r) => r.via.includes('vector'));
  return {
    total: cases.length,
    hit1: results.filter((r) => r.hit1).length,
    hit3: results.filter((r) => r.hit3).length,
    textHit: results.filter((r) => r.textHit).length,
    mode: vectorUsed ? 'hybrid' : 'lexical',
    vectorUsed,
    results
  };
}

/** 报告表格（对齐输出，供 quality 报告与 CLI） */
export function formatReport(r: EvalReport, title = '知识检索评估'): string {
  const head = `${title}｜模式=${r.mode}${r.vectorUsed ? '（含向量路）' : '（向量路未参与：未启用/未建索引/失败降级，等价词法两路）'}｜样本 ${r.total}`;
  const line = `hit@1 ${r.hit1}/${r.total}（${Math.round((r.hit1 / r.total) * 100)}%）｜hit@3 ${r.hit3}/${r.total}（${Math.round((r.hit3 / r.total) * 100)}%）｜引文片段命中 ${r.textHit}/${r.total}`;
  const rows = r.results.map((x) => `${x.hit1 ? '①' : x.hit3 ? '③' : '✖'} ${x.textHit ? '✓' : '片段✖'} [${x.doc}] ${x.q}${x.hit3 ? '' : ` ← top=${x.topDoc ?? '无'}`}`);
  return [head, line, ...rows].join('\n');
}
