/**
 * 【批3 归档定位（2026-11-11）】本模块实现段落级混合召回（CJK 双字 BM25 + 关键词），RRF 融合。
 *  当前语料仅 3049 字——知识检索**默认走全量注入**（KNOWLEDGE_FULL_INJECT 缺省开），
 *  本模块处于**归档维护态**：测试与回退口径仍可用（KNOWLEDGE_FULL_INJECT=0 启用），
 *  语料增长到数万字前不要在生产启用检索路径（复杂度必须与数据规模匹配）。
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeDocument } from './knowledge.ts';

/**
 * 知识检索 —— 段落级混合召回（CJK 双字 BM25 + 关键词），RRF 融合。
 * ============================================================================
 *  为什么不是"直接上 FTS5 默认分词"：实测 unicode61 把整段中文当成**一个** token，
 *  任何中文查询都命中 0 条；trigram 能命中 3 字以上，但两字中文词（"调课""钥匙"）
 *  照样漏。中文可用的零依赖方案是把文本切成**相邻双字**再交给 unicode61，
 *  这样 BM25 的字段长度归一与逆文档频率才真正作用在中文语料上。
 *
 *  两路召回再融合，而不是二选一：
 *   · 关键词路（原有能力）擅长"命中了哪个受控词"，短词精准；
 *   · BM25 路擅长长句与同义表述的段落级排序。
 *  RRF（Reciprocal Rank Fusion）只用名次不用原始分，避免两路量纲不同导致的偏置。
 *
 *  权限与生效日期是**硬前置**：过滤发生在打分之前，
 *  越权或已过期的制度不可能靠"分数高"漏进来。这是本系统与通用 RAG 的差别。
 */

export interface ScoredChunk {
  docId: string;
  /** 段落序号，从 1 起，与对外 locator §N 一致 */
  index: number;
  text: string;
  score: number;
  /** 召回来源，便于评测归因与界面展示"为什么是这段"（RAG 批次1 新增 vector 路） */
  via: Array<'keyword' | 'bm25' | 'vector'>;
}

/**
 * 相邻**重叠**双字切分；ASCII/数字词保持完整。
 * "课程管理与值班" → 课程 程管 管理与…值 值班
 *
 * ⚠ 早先的实现是"当前字 + 更早那个字"，实测只产出非重叠对
 *   （"妈妈来了"→ 只有 "妈来"），导致文档里"值班"永远生成不出 bigram、
 *   BM25 路对奇数偏移的词稳定漏召回。这里按中文串整段生成，避免再犯。
 * 字符类只列区间、不夹裸 `-`：`[一-鿿-]` 会被解析成字面连字符，
 *   曾把 "A-B学" 切出脏 token。
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;
const LATIN = /[a-z0-9]/;

export function cjkBigrams(text: string): string {
  const out: string[] = [];
  let run = '';
  let latin = '';
  const flushLatin = () => {
    if (latin) {
      out.push(latin);
      latin = '';
    }
  };
  const flushRun = () => {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    run = '';
  };
  for (const ch of text.toLowerCase()) {
    if (CJK.test(ch)) {
      flushLatin();
      run += ch;
    } else if (LATIN.test(ch)) {
      flushRun();
      latin += ch;
    } else {
      flushRun();
      flushLatin();
    }
  }
  flushRun();
  flushLatin();
  return out.join(' ');
}

interface Index {
  db: DatabaseSync;
  /** 语料指纹：内容变了才重建 */
  fingerprint: string;
}

let index: Index | null = null;

function fingerprintOf(docs: KnowledgeDocument[]): string {
  return createHash('sha256').update(docs.map((d) => `${d.id}@${d.version}:${d.paragraphs.length}`).join('|')).digest('hex');
}

/** 段落级索引：一行一段，docId+index 可回溯到原文 */
function buildIndex(docs: KnowledgeDocument[]): Index {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE chunk USING fts5(text, docId UNINDEXED, idx UNINDEXED, keywords UNINDEXED, tokenize="unicode61")');
  const insert = db.prepare('INSERT INTO chunk VALUES (?,?,?,?)');
  for (const d of docs) {
    const kw = cjkBigrams(d.keywords.join(' '));
    d.paragraphs.forEach((p, i) => insert.run(cjkBigrams(p), d.id, i + 1, kw));
  }
  return { db, fingerprint: fingerprintOf(docs) };
}

function ensureIndex(docs: KnowledgeDocument[]): Index {
  const fp = fingerprintOf(docs);
  if (index && index.fingerprint === fp) return index;
  index = buildIndex(docs);
  return index;
}

/** BM25 路召回：按段落取 topN，返回 docId#index → 名次 */
function bm25Recall(query: string, docs: KnowledgeDocument[], topN: number): Map<string, number> {
  const idx = ensureIndex(docs);
  const tokens = cjkBigrams(query).trim();
  if (!tokens) return new Map();
  // 用 OR 组配，让"部分命中"的段落也能进候选；AND 在中文短查询下过于苛刻
  const match = tokens.split(' ').filter(Boolean).map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
  let rows: Array<{ docId: string; idx: number }> = [];
  try {
    rows = idx.db
      .prepare(`SELECT docId, idx, bm25(chunk) AS s FROM chunk WHERE chunk MATCH ? ORDER BY s LIMIT ?`)
      .all(match, topN) as Array<{ docId: string; idx: number }>;
  } catch {
    return new Map(); // 查询串不合语法时退化为"该路无结果"，不影响关键词路
  }
  const out = new Map<string, number>();
  rows.forEach((r, i) => out.set(`${r.docId}#${r.idx}`, i + 1));
  return out;
}

/** 关键词路召回：沿用原有"命中受控词按词长加权"的判据，落到段落上 */
function keywordRecall(query: string, docs: KnowledgeDocument[], topN: number): Map<string, number> {
  const q = query.toLowerCase();
  const scored: Array<{ key: string; score: number }> = [];
  for (const d of docs) {
    const docScore = d.keywords.reduce((s, k) => s + (q.includes(k.toLowerCase()) ? k.length : 0), 0);
    if (docScore <= 0) continue;
    d.paragraphs.forEach((p, i) => {
      // 段落级微调：段落自身含查询子串时加权，避免整篇文档平均分
      const direct = [...q.matchAll(/[一-鿿]{2,6}/g)].some((m) => p.includes(m[0])) ? 1.25 : 1;
      scored.push({ key: `${d.id}#${i + 1}`, score: docScore * direct });
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = new Map<string, number>();
  scored.slice(0, topN).forEach((s, i) => out.set(s.key, i + 1));
  return out;
}

/** RRF：只用名次，k=60 为业界常用平滑值。RAG 批次1 起支持任意多路（关键词/BM25/向量） */
function rrfMerge(...legs: Array<{ ranks: Map<string, number>; via: ScoredChunk['via'] }>): Map<string, { score: number; via: ScoredChunk['via'] }> {
  const merged = new Map<string, { score: number; via: ScoredChunk['via'] }>();
  for (const leg of legs) {
    for (const [key, rank] of leg.ranks) {
      const cur = merged.get(key);
      if (cur) {
        cur.score += 1 / (60 + rank);
        if (!cur.via.includes(leg.via[0]!)) cur.via.push(leg.via[0]!);
      } else merged.set(key, { score: 1 / (60 + rank), via: [...leg.via] });
    }
  }
  return merged;
}

/** 权限与生效日期过滤是检索的硬前置（打分之前），各召回路共用同一候选集 */
export function eligibleDocs(docs: KnowledgeDocument[], role: string, date: string): KnowledgeDocument[] {
  return docs.filter((d) => d.roles.includes(role) && d.effectiveFrom <= date && (!d.effectiveTo || d.effectiveTo >= date));
}

/**
 * 检索入口。返回按相关度排序的段落，并保留文档元信息。
 * 权限（roles）与生效日期在打分**之前**过滤。
 */
export function searchChunks(query: string, role: string, date: string, docs: KnowledgeDocument[], limit = 8, vectorRanks?: Map<string, number> | null): ScoredChunk[] {
  const eligible = eligibleDocs(docs, role, date);
  if (!eligible.length || !query.trim()) return [];
  const pool = eligible.length * 3;
  // RAG 批次1：向量路按需并入（未启用/未建索引/调用失败传 null，退回两路，检索不因向量路失败而失败）
  const merged = vectorRanks && vectorRanks.size
    ? rrfMerge(
        { ranks: keywordRecall(query, eligible, pool), via: ['keyword'] },
        { ranks: bm25Recall(query, eligible, pool), via: ['bm25'] },
        { ranks: vectorRanks, via: ['vector'] }
      )
    : rrfMerge(
        { ranks: keywordRecall(query, eligible, pool), via: ['keyword'] },
        { ranks: bm25Recall(query, eligible, pool), via: ['bm25'] }
      );
  const byKey = new Map(eligible.flatMap((d) => d.paragraphs.map((text, i): [string, ScoredChunk] => [
    `${d.id}#${i + 1}`,
    { docId: d.id, index: i + 1, text, score: 0, via: [] }
  ])));
  return [...merged.entries()]
    .map(([key, v]) => ({ ...(byKey.get(key) as ScoredChunk), score: v.score, via: v.via }))
    .sort((x, y) => y.score - x.score || x.docId.localeCompare(y.docId) || x.index - y.index)
    .slice(0, limit);
}

/** 供评测与调试：查看两路各自的召回名次，定位"没召回到"是过滤问题还是排序问题 */
export function explainRecall(query: string, role: string, date: string, docs: KnowledgeDocument[]) {
  const eligible = docs.filter((d) => d.roles.includes(role) && d.effectiveFrom <= date && (!d.effectiveTo || d.effectiveTo >= date));
  return {
    eligibleDocs: eligible.map((d) => d.id),
    filteredOut: docs.length - eligible.length,
    keyword: [...keywordRecall(query, eligible, 10).entries()],
    bm25: [...bm25Recall(query, eligible, 10).entries()]
  };
}

/** 测试用：强制重建索引 */
export function resetIndexForTests(): void {
  index?.db.close();
  index = null;
}
