/**
 * 【批3 归档定位（2026-11-11）】本模块实现向量索引与向量路召回（RAG 批次 1）。
 *  当前语料仅 3049 字——知识检索**默认走全量注入**（KNOWLEDGE_FULL_INJECT 缺省开），
 *  本模块处于**归档维护态**：测试与回退口径仍可用（KNOWLEDGE_FULL_INJECT=0 启用），
 *  语料增长到数万字前不要在生产启用检索路径（复杂度必须与数据规模匹配）。
 */
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
import { docChunks, manualChunks, type ManualDoc } from './knowledge-chunker.ts';

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
  /** 分块参数（缺省 420 字窗口 / 50 字重叠） */
  chunk?: { window?: number; overlap?: number };
}

/**
 * 全量重建索引（幂等）：对每份文档的每个段落向量化并 upsert，
 * 库中不属于当前语料的键一律清剪。批内任何失败整体回滚——绝不留半截索引不吭声。
 */
export async function indexKnowledge(docs: KnowledgeDocument[], opts: IndexOptions = {}): Promise<IndexResult> {
  const db = opts.db ?? getDb();
  ensureKnowledgeVecTable(db);
  const ep = embeddingEndpoint(opts.endpoint);
  // RAG 批次2：分块器接管——短段落 1 段 1 块（与批次 1 行为一致），长段落按
  // 句边界开窗重叠；向量化文本带标题语境前缀。paraIndex 存**父段落号**，
  // chunkKey 保留子块号（docId#N / docId#N.k）。
  const entries = docs.flatMap((d) => docChunks(d, opts.chunk).map((c) => ({ key: c.key, docId: d.id, idx: c.paraIndex, text: c.embedText })));
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
  const rows = db.prepare('SELECT chunkKey, docId, paraIndex, dim, vec FROM knowledge_chunks_vec').all() as Array<{ chunkKey: string; docId: string; paraIndex: number; dim: number; vec: Buffer }>;
  // 候选 = 权限/日期过滤后的文档段落（含子块：docId#N 与 docId#N.k 同属父段 N）
  const allowed = new Set(eligible.flatMap((d) => d.paragraphs.map((_, i) => `${d.id}#${i + 1}`)));
  const allowedChunk = (r: { docId: string; paraIndex: number }): boolean => allowed.has(`${r.docId}#${r.paraIndex}`);
  // 同段多子块取最优分，折叠回父段落（对外 locator §N 的契约不变）
  const best = new Map<string, number>();
  for (const r of rows) {
    if (r.dim !== queryVec.length) continue;
    if (!allowedChunk(r)) continue;
    const score = cosine(queryVec, decodeVec(r.vec));
    if (score <= 0) continue;
    const parent = `${r.docId}#${r.paraIndex}`;
    const cur = best.get(parent);
    if (cur === undefined || score > cur) best.set(parent, score);
  }
  const scored = [...best.entries()].map(([parent, score]) => ({ parent, score }));
  scored.sort((a, b) => b.score - a.score || a.parent.localeCompare(b.parent));
  const out = new Map<string, number>();
  scored.slice(0, topN).forEach((s, i) => out.set(s.parent, i + 1));
  return out;
}

/**
 * RAG 批次2：主系统手册向量索引。键命名空间 `m:${id}@${version}#paraId(.k)`，
 * **版本在键里**——重导入新版本自动新增键，同 id 旧版本键清剪（增量去重）。
 * 权限口径：只索引主系统按当前账号返回的手册（manualVisible 在主系统侧过滤）。
 */
export async function indexManuals(manuals: ManualDoc[], opts: IndexOptions = {}): Promise<IndexResult> {
  const db = opts.db ?? getDb();
  ensureKnowledgeVecTable(db);
  const ep = embeddingEndpoint(opts.endpoint);
  const entries = manuals.flatMap((m) => manualChunks(m, opts.chunk).map((c) => ({ key: c.key, docId: c.docId, text: c.embedText })));
  const embed = opts.embed ?? embedTexts;
  const vecs = entries.length ? await embed(entries.map((e) => e.text), opts.endpoint) : [];
  const validPrefixes = new Set(manuals.map((m) => `m:${m.id}@`));
  db.exec('BEGIN');
  try {
    const upsert = db.prepare(
      `INSERT INTO knowledge_chunks_vec (chunkKey,docId,paraIndex,dim,model,vec,updatedAt) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(chunkKey) DO UPDATE SET dim=excluded.dim, model=excluded.model, vec=excluded.vec, updatedAt=excluded.updatedAt`
    );
    const now = new Date().toISOString();
    entries.forEach((e, i) => {
      const f32 = Float32Array.from(vecs[i]!);
      upsert.run(e.key, e.docId, 0, f32.length, ep.model, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), now);
    });
    // 清剪：同手册旧版本（前缀匹配但不在当前键集）；其他手册（本轮未返回、
    // 可能当前无权限）的键不动——不越权清剪
    const all = db.prepare("SELECT chunkKey FROM knowledge_chunks_vec WHERE chunkKey LIKE 'm:%'").all() as Array<{ chunkKey: string }>;
    const validKeys = new Set(entries.map((e) => e.key));
    const del = db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunkKey=?');
    let pruned = 0;
    for (const r of all) {
      if (validKeys.has(r.chunkKey)) continue;
      if ([...validPrefixes].some((p) => r.chunkKey.startsWith(p))) { del.run(r.chunkKey); pruned += 1; }
    }
    db.exec('COMMIT');
    return { indexed: entries.length, pruned, docs: manuals.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * RAG 批次2：手册段落向量排序。**只对主系统本次返回的手册段落排序**——
 * 手册集合的权威仍是主系统端点（权限在它那边过滤），向量路只决定段落先后。
 * 返回 `m:id@version#paraId` → 名次（1 起）。
 */
export function rankManualParagraphs(queryVec: number[], manuals: ManualDoc[], db: DatabaseSync = getDb()): Map<string, number> {
  ensureKnowledgeVecTable(db);
  const allowed = new Set(manuals.flatMap((m) => manualChunks(m).map((c) => c.key)));
  const rows = db.prepare('SELECT chunkKey, dim, vec FROM knowledge_chunks_vec').all() as Array<{ chunkKey: string; dim: number; vec: Buffer }>;
  const best = new Map<string, number>();
  for (const r of rows) {
    if (r.dim !== queryVec.length) continue;
    // 子块键（…#paraId.2）折算回父键（…#paraId）
    const parent = r.chunkKey.replace(/\.\d+$/, '');
    if (!allowed.has(parent)) continue;
    const score = cosine(queryVec, decodeVec(r.vec));
    if (score <= 0) continue;
    const cur = best.get(parent);
    if (cur === undefined || score > cur) best.set(parent, score);
  }
  const sorted = [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = new Map<string, number>();
  sorted.forEach(([key], i) => out.set(key, i + 1));
  return out;
}
