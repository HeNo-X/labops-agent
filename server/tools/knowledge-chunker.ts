/**
 * 中文感知分块器（RAG 批次 2）
 * ============================================================================
 *  批次 1 用"段落即分块"——内置操作说明的段落都很短（实测最长 107 字），够用；
 *  但主系统导入的厂家手册段落可能很长，直接整段向量化会稀释语义（一段讲三件事，
 *  向量落在中间）。本模块把长段落切成 300~500 字窗口、约 50 字重叠的块：
 *   · 切分点优先落在句子边界（。！？；）与**行边界**；
 *   · 表格行 / 列表项（| · - • 数字编号开头）作为整行单元，绝不从中间切断；
 *   · 超长单元（比窗口还长的单句）才允许硬切（末路兜底，如实存在）；
 *   · 短段落恒为 1 块（内置语料现状，行为与批次 1 完全一致）。
 *  引用契约不破坏：chunkKey 里保留父段落号（`docId#N` 单块 / `docId#N.k` 多块），
 *  对外 locator §N 永远指向原文段落序号。
 *  向量化文本带**标题语境前缀**（文档标题+版本）——孤立的段落向量获得主题锚点。
 */
import type { KnowledgeDocument } from './knowledge.ts';

export interface ChunkOptions {
  /** 单块目标长度（字符）。缺省 420：300~500 窗口的中间值 */
  window?: number;
  /** 相邻块重叠字符数（缺省 50），边界处的句子在两块各出现一次，避免语义切断 */
  overlap?: number;
}

export interface DocChunk {
  /** `docId#N`（单块）或 `docId#N.k`（多块，k 从 1 起） */
  key: string;
  /** 父段落序号（1 起），对外 locator §N 用它 */
  paraIndex: number;
  /** 段内子块序号（1 起；单块恒 1） */
  sub: number;
  text: string;
  /** 实际送向量化的文本：标题语境前缀 + 块正文 */
  embedText: string;
}

/** 列表/表格行：这些行是整体单元，不从中间切 */
const BLOCK_LINE = /^\s*(?:\|[-|:\s]*\||[-·•*]\s|\d+[.、)]\s|\|)/;

/** 把文本拆成不可再分的单元：先按行，行内再按句子边界（。！？；保留句尾符） */
function units(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine;
    if (!line.trim()) { out.push(''); continue; }
    if (BLOCK_LINE.test(line)) { out.push(line); continue; }
    // 句子切分：标点跟在句尾一起保留
    const parts = line.split(/(?<=[。！？；!?;])/).filter(Boolean);
    out.push(...parts);
  }
  return out;
}

/** 贪心装窗 + 重叠：按单元边界回退凑 ≈overlap 字（宁少勿超）；单超长单元硬切 */
function packWithOverlap(text: string, window: number, overlap: number): string[] {
  const us = units(text);
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length) { chunks.push(cur.join('')); cur = []; curLen = 0; }
  };
  for (let i = 0; i < us.length; i += 1) {
    const u = us[i]!;
    if (u.length > window) {
      flush();
      for (let p = 0; p < u.length; p += window - overlap) chunks.push(u.slice(p, p + window));
      continue;
    }
    if (curLen + u.length > window && curLen > 0) {
      flush();
      // 重叠：回退若干单元凑 ≈overlap 字（宁少勿超）
      let back = 0;
      let backLen = 0;
      for (let j = i - 1; j >= 0 && backLen < overlap && back < 3; j -= 1) {
        backLen += us[j]!.length;
        back += 1;
      }
      cur = us.slice(Math.max(0, i - Math.max(0, back - (backLen > overlap ? 1 : 0))), i);
      curLen = cur.join('').length;
    }
    cur.push(u);
    curLen += u.length;
  }
  flush();
  return chunks.filter((c) => c.trim());
}

/** 长文本切块（公开给测试与手册摄取使用） */
export function chunkLongText(text: string, opts: ChunkOptions = {}): string[] {
  const window = opts.window ?? 420;
  const overlap = Math.min(opts.overlap ?? 50, Math.floor(window / 4));
  if (text.length <= window) return [text];
  return packWithOverlap(text, window, overlap);
}

/** 文档 → 带键分块（向量索引的写入单元）。键契约：`docId#N` / `docId#N.k` */
export function docChunks(doc: KnowledgeDocument, opts: ChunkOptions = {}): Array<{ key: string; paraIndex: number; sub: number; text: string; embedText: string }> {
  const out: Array<{ key: string; paraIndex: number; sub: number; text: string; embedText: string }> = [];
  const contextPrefix = `${doc.title}（v${doc.version}）：`;
  doc.paragraphs.forEach((para, i) => {
    const paraIndex = i + 1;
    const pieces = chunkLongText(para, opts);
    pieces.forEach((text, k) => {
      const sub = k + 1;
      const key = pieces.length === 1 ? `${doc.id}#${paraIndex}` : `${doc.id}#${paraIndex}.${sub}`;
      out.push({ key, paraIndex, sub, text, embedText: contextPrefix + text });
    });
  });
  return out;
}

/** 手册 → 带键分块。键命名空间独立：`m:${id}@${version}#${paraId}(.k)`，版本在键里做增量去重 */
export interface ManualDoc {
  id: string;
  title: string;
  device: string;
  version: string;
  paragraphs: Array<{ id: string; text: string }>;
}
export function manualChunks(manual: ManualDoc, opts: ChunkOptions = {}): Array<{ key: string; docId: string; paraKey: string; sub: number; text: string; embedText: string }> {
  const out: Array<{ key: string; docId: string; paraKey: string; sub: number; text: string; embedText: string }> = [];
  const contextPrefix = `${manual.title}（适用设备 ${manual.device}，v${manual.version}）：`;
  manual.paragraphs.forEach((p) => {
    const pieces = chunkLongText(p.text, opts);
    pieces.forEach((text, k) => {
      const sub = k + 1;
      const paraKey = `m:${manual.id}@${manual.version}#${p.id}`;
      const key = pieces.length === 1 ? paraKey : `${paraKey}.${sub}`;
      out.push({ key, docId: `manual:${manual.id}`, paraKey, sub, text, embedText: contextPrefix + text });
    });
  });
  return out;
}

/** 导出给测试（内部装窗函数的行为锚点） */
export const __internals = { units, packWithOverlap };
