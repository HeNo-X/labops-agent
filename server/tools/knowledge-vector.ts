/**
 * 知识向量索引与向量路召回（RAG 批次 1）
 * ============================================================================
 *  · 分块：段落即分块（与 BM25 路同粒度，locator §N 一一对应）；中文感知切分
 *    与重叠窗口属批次 2；
 *  · 存储：sqlite 表 knowledge_chunks_vec（Float32 原始字节 BLOB），**无向量库、
 *    无原生模块**——语料规模（数百~数千块）下 JS 余弦毫秒级，R1 零依赖 ✓；
 *  · 索引幂等：chunkKey=docId#paraIndex upsert，语料变更后陈旧键清剪；
 *  · 召回：候选集由调用方按权限/生效日期过滤后传入（与 BM25/关键词路同一硬前置），
 *    维度不符的旧向量（改过 EMBEDDING_DIMENSIONS）自动跳过。
 */
import { DatabaseSync } from 'node:sqlite';
import { getDb } from '../persistence/db.ts';
import { cosine, embedTexts, embeddingEndpoint, type EmbeddingEndpoint } from '../llm/embeddings.ts';
import type { KnowledgeDocument } from './knowledge.ts';

export function ensureKnowledgeVecTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_chunks_vec (
    chunkKey TEXT PRIMARY KEY,
    docId TEXT NOT NULL,
    paraIndex INTEGER NOT NULL,
    dim INTEGER NOT NULL,
    model TEXT NOT NULL,
    vec BLOB NOT NULL,
    updatedAt TEXT NOT NULL
  )`);
}

/** Float32 字节安全解码（Buffer 可能非 4 字节对齐，先拷贝进新 ArrayBuffer） */
function decodeVec(buf: Buffer): Float32Array {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

export interface IndexResult {
  /** 本次写入/更新的块数 */
  indexed: number;
  /** 语料变更后清剪的陈旧块数 */
  pruned: number;
  docs: number;
}

export interface IndexOptions {
  /** 测试注入：覆盖 endpoint（进程内假上游）与向量化函数（确定性向量） */
  endpoint?: Partial<EmbeddingEndpoint>;
  embed?: typeof embedTexts;
  /** 测试注入：:memory: 库；缺省用持久库 */
  db?: DatabaseSync;
}

/**
 * 全量重建索引（幂等）：对每份文档的每个段落向量化并 upsert，
 * 库中不属于当前语料的键一律清剪。批内任何失败整体回滚——绝不留半截索引不吭声。
 */
export async function indexKnowledge(docs: KnowledgeDocument[], opts: IndexOptions = {}): Promise<IndexResult> {
  const db = opts.db ?? getDb();
  ensureKnowledgeVecTable(db);
  const ep = embeddingEndpoint(opts.endpoint);
  const entries = docs.flatMap((d) => d.paragraphs.map((text, i) => ({ key: `${d.id}#${i + 1}`, docId: d.id, idx: i + 1, text })));
  if (!entries.length) {
    const existing = db.prepare('SELECT chunkKey FROM knowledge_chunks_vec').all() as Array<{ chunkKey: string }>;
    const del = db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunkKey=?');
    db.exec('BEGIN');
    try {
      for (const r of existing) del.run(r.chunkKey);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { indexed: 0, pruned: existing.length, docs: docs.length };
  }
  const embed = opts.embed ?? embedTexts;
  const vecs = await embed(entries.map((e) => e.text), opts.endpoint);
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO knowledge_chunks_vec (chunkKey,docId,paraIndex,dim,model,vec,updatedAt) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(chunkKey) DO UPDATE SET docId=excluded.docId, paraIndex=excluded.paraIndex, dim=excluded.dim, model=excluded.model, vec=excluded.vec, updatedAt=excluded.updatedAt`
  );
  const validKeys = new Set(entries.map((e) => e.key));
  db.exec('BEGIN');
  try {
    entries.forEach((e, i) => {
      const f32 = Float32Array.from(vecs[i]!);
      upsert.run(e.key, e.docId, e.idx, f32.length, ep.model, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), now);
    });
    const existing = db.prepare('SELECT chunkKey FROM knowledge_chunks_vec').all() as Array<{ chunkKey: string }>;
    const stale = existing.filter((r) => !validKeys.has(r.chunkKey)).map((r) => r.chunkKey);
    const del = db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunkKey=?');
    for (const k of stale) del.run(k);
    db.exec('COMMIT');
    return { indexed: entries.length, pruned: stale.length, docs: docs.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function vecIndexStats(db: DatabaseSync = getDb()): { count: number; models: string[]; dims: number[] } {
  ensureKnowledgeVecTable(db);
  const rows = db.prepare('SELECT model, dim, COUNT(*) AS n FROM knowledge_chunks_vec GROUP BY model, dim').all() as Array<{ model: string; dim: number; n: number }>;
  return {
    count: rows.reduce((s, r) => s + r.n, 0),
    models: rows.map((r) => r.model),
    dims: rows.map((r) => r.dim)
  };
}

/**
 * 向量路召回：queryVec 对候选段落算余弦，返回 `docId#paraIndex` → 名次（1 起）。
 * 候选集（权限/日期过滤后）由调用方传入；维度不符的旧向量跳过；全零分不占名次。
 */
export function vectorRecallByVec(queryVec: number[], eligible: KnowledgeDocument[], topN: number, db: DatabaseSync = getDb()): Map<string, number> {
  ensureKnowledgeVecTable(db);
  const rows = db.prepare('SELECT chunkKey, dim, vec FROM knowledge_chunks_vec').all() as Array<{ chunkKey: string; dim: number; vec: Buffer }>;
  const allowed = new Set(eligible.flatMap((d) => d.paragraphs.map((_, i) => `${d.id}#${i + 1}`)));
  const scored: Array<{ key: string; score: number }> = [];
  for (const r of rows) {
    if (r.dim !== queryVec.length) continue;
    if (!allowed.has(r.chunkKey)) continue;
    const score = cosine(queryVec, decodeVec(r.vec));
    if (score > 0) scored.push({ key: r.chunkKey, score });
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const out = new Map<string, number>();
  scored.slice(0, topN).forEach((s, i) => out.set(s.key, i + 1));
  return out;
}
