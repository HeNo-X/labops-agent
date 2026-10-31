/**
 * RAG 批次 3：LLM 重排（可关，缺省关）
 * ============================================================================
 *  三路混合召回给出"候选"，重排决定"先后"。用当前会话模式的模型链对 top 候选
 *  段落做一次轻量打分（严格 JSON），按分数重排文档与段落。
 *
 *  保守性三原则：
 *   · 缺省关（RERANK_LLM=1 才启用）——配额敏感，聊天/任务主链是稀缺资源；
 *   · 任何失败（模型不可用/JSON 解析失败/超时）**静默回原序**——三路召回本身
 *     已经可用，重排只是锦上添花，绝不因它把检索搞挂；
 *   · 重排只动顺序，不增删内容——引用（[n] + §定位）由渲染层按最终顺序编号。
 */
import { streamChatWithFallback } from '../llm/router.ts';
import { getConfig } from '../config.ts';
import type { RankedHit } from './knowledge.ts';
import type { Logger } from '../obs/trace.ts';

export function isLlmRerankEnabled(): boolean {
  return getConfig().rerank.llm;
}

export interface RerankOptions {
  enabled?: boolean;
  /** 测试注入：假的模型链生成器 */
  chat?: typeof streamChatWithFallback;
  signal?: AbortSignal;
}

const RERANK_SYSTEM = '你是检索重排序器。只输出一个 JSON 对象，不要输出任何其他文字、解释或代码块标记。';

export async function rerankHits(
  query: string,
  hits: RankedHit[],
  mode: 'chat' | 'task',
  log?: Logger,
  opts: RerankOptions = {}
): Promise<RankedHit[]> {
  const enabled = opts.enabled ?? isLlmRerankEnabled();
  if (!enabled || hits.length < 2) return hits;

  // 候选段落扁平化（编号 i 从 1 起），总量上限 8——重排是轻量动作，不是二次检索
  const cands: Array<{ i: number; hit: RankedHit; p: { index: number; text: string } }> = [];
  outer: for (const h of hits) {
    for (const p of h.paragraphs) {
      cands.push({ i: cands.length + 1, hit: h, p });
      if (cands.length >= 8) break outer;
    }
  }
  if (cands.length < 2) return hits;

  const userPrompt = [
    `查询：${query}`,
    '候选段落：',
    ...cands.map((c) => `[${c.i}] ${c.p.text.slice(0, 200)}`),
    '对每段输出与查询的相关度分数 s（0-10 整数）。只输出 JSON：{"scores":[{"i":1,"s":9},{"i":2,"s":3}]}'
  ].join('\n');

  const chat = opts.chat ?? streamChatWithFallback;
  let text = '';
  try {
    for await (const ev of chat({ messages: [ { role: 'system', content: RERANK_SYSTEM }, { role: 'user', content: userPrompt } ], tools: [], signal: opts.signal }, mode, log)) {
      if (ev.type === 'text') text += ev.text;
    }
  } catch (err) {
    log?.warn('rerank_failed', { error: (err as Error).message.slice(0, 160), reason: '模型链不可用，保持三路召回原序' });
    return hits;
  }

  const scores = parseScores(text, cands.length);
  if (!scores) {
    log?.warn('rerank_parse_failed', { raw: text.slice(0, 120), reason: '重排响应不是合法 JSON，保持原序' });
    return hits;
  }

  // 段落按分数降序（同分保持原相对顺序），文档按其最优段落名次重排
  const ranked = [...cands].sort((a, b) => (scores.get(b.i) ?? 0) - (scores.get(a.i) ?? 0));
  const docOrder: string[] = [];
  const paraOrder = new Map<string, Array<{ index: number; text: string }>>();
  for (const c of ranked) {
    if (!docOrder.includes(c.hit.doc.id)) docOrder.push(c.hit.doc.id);
    const key = c.hit.doc.id;
    const list = paraOrder.get(key) ?? [];
    list.push({ index: c.p.index, text: c.p.text });
    paraOrder.set(key, list);
  }
  const byId = new Map(hits.map((h) => [h.doc.id, h]));
  return docOrder.map((id) => {
    const h = byId.get(id)!;
    return { ...h, paragraphs: paraOrder.get(id) ?? h.paragraphs };
  });
}

/** 严格解析：取第一个 {...}，校验 scores 数组与编号范围；任何不合法返回 null（回原序） */
export function parseScores(text: string, count: number): Map<number, number> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  const arr = (parsed as { scores?: unknown })?.scores;
  if (!Array.isArray(arr)) return null;
  const out = new Map<number, number>();
  for (const item of arr) {
    const i = (item as { i?: unknown })?.i;
    const s = (item as { s?: unknown })?.s;
    if (typeof i !== 'number' || typeof s !== 'number' || !Number.isInteger(i) || i < 1 || i > count) return null;
    out.set(i, Math.max(0, Math.min(10, s)));
  }
  return out.size ? out : null;
}
