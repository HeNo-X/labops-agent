/**
 * POST /api/agent/asr-lexicon-check —— 语音词汇体检（只读，不写任何东西）
 * ============================================================================
 *  为什么要这个端点：用户在面板里登记了词，但**看不出这些词到底落在哪条链路上** ——
 *  内置表里已经有了？被预算挤掉了？撞上了常用词保护？缺拼音没法进内置表？
 *  这些判断需要内置表、配置和清洗规则，全部在服务端，前端猜不出来也不该猜。
 *
 *  三条硬约束：
 *   1. **只读**：不写文件、不写库、不打上游。它算的是一份结论，请求体只是用户的输入本身。
 *   2. **结论必须可执行**：每条都给 verdict + 人话原因，而不是"有 N 条重复"这种没法操作的话。
 *   3. **缺拼音就标缺拼音**：合并候选条目的读音只用**内置表里已确认的读音**推导
 *     （deriveSyllables），推不出来的一律进 needPinyin，绝不猜一个填进去 ——
 *     错的音节会把"完全同音"这条最硬的判据变成"我们以为同音"。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody } from './agent-chat.ts';
import { currentActor } from '../security/context.ts';
import { getAsrConfig } from '../llm/asr.ts';
import { loadDataset } from '../data/store.ts';
import { lexiconFromDataset } from '../llm/asr-lexicon.ts';
import { sanitizeTermPairs, type UserTermPair } from '../llm/asr-lexicon.ts';
import {
  loadGlossaryData,
  sanitizeKeywords,
  deriveSyllables,
  glossaryFingerprint,
  ambiguousSyllables,
  buildContextText,
  hotwordFits,
  type AsrDomain,
  type GlossaryTerm
} from '../llm/asr-glossary.ts';

const MAX_BODY_BYTES = 64 * 1024;

export type KeywordVerdict =
  | 'in-context'            // 本次确实进了上下文实体词表
  | 'already-in-builtin'    // 内置表本来就有，重复登记不额外起作用
  | 'dropped-by-budget'     // 超出字符预算，被挤掉
  | 'bias-off';             // 服务端事前偏置关着，这条链路根本没启动
export type PairVerdict =
  | 'active'
  | 'redundant-with-builtin'
  | 'overrides-builtin-alias'
  | 'collides-with-protect'
  | 'rewrites-a-builtin-term';

export interface MergeCandidate {
  canonical: string;
  syll: string[];
  aliases: string[];
  weight: number;
  domain: AsrDomain;
  blockAfter: string[];
}

export interface LexiconReport {
  ok: true;
  builtIn: {
    terms: number;
    fingerprint: string;
    protect: number;
    ambiguousKeys: number;
    byDomain: Record<string, number>;
  };
  effective: {
    protocol: string;
    contextEnabled: boolean;
    contextMaxChars: number;
    hotwordsEnabled: boolean;
    hotwordsMax: number;
    termCorrectEnabled: boolean;
    /** 按当前配置真正构造出来的上下文：词数与字符数（不含用户词的基线） */
    contextTerms: number;
    contextChars: number;
    omittedFromBudget: number;
  };
  /** hotwordFits=false 只说明"换原生协议时这条进不了即时热词表"，不影响它能不能走上下文 */
  keywords: Array<{ word: string; verdict: KeywordVerdict; hotwordFits: boolean; why: string }>;
  pairs: Array<{ from: string; to: string; verdict: PairVerdict; why: string }>;
  merge: { candidates: MergeCandidate[]; needPinyin: string[] };
}

/**
 * 体检结论的纯函数版本：不碰 HTTP，方便单测把每一条判据钉死。
 * `keywords` / `pairs` 必须是**已过 sanitize** 的数组（端点负责清洗，测试直接给干净数据）。
 */
export function buildLexiconReport(
  terms: readonly GlossaryTerm[],
  protect: readonly string[],
  input: { keywords: readonly string[]; pairs: readonly UserTermPair[]; datasetTerms?: readonly string[] }
): LexiconReport {
  const config = getAsrConfig();
  const canonicalSet = new Set(terms.map((t) => t.canonical));
  const aliasOwner = new Map<string, string>();
  for (const t of terms) for (const a of t.aliases ?? []) if (!aliasOwner.has(a)) aliasOwner.set(a, t.canonical);
  const protectSet = new Set(protect);

  const byDomain: Record<string, number> = {};
  for (const t of terms) byDomain[t.domain] = (byDomain[t.domain] ?? 0) + 1;

  // 真实发送时上下文里还有数据集来的房间号/班级/课程 —— 预算判断必须把它们算进去，
  // 否则给用户的是"装得下"的乐观结论，而实际请求里那些词早被挤掉了。
  const datasetTerms = [...new Set((input.datasetTerms ?? []).map((s) => s.trim()).filter(Boolean))];
  const baseContext = buildContextText(terms, { maxChars: config.contextMaxChars, extraTerms: datasetTerms });
  // 带上用户常用词的上下文：谁被预算挤掉，两次一比就看出来（不靠"大概能装下"）
  const withUsers = buildContextText(terms, {
    maxChars: config.contextMaxChars,
    extraTerms: [...datasetTerms, ...input.keywords]
  });

  const keywords = input.keywords.map((word): LexiconReport['keywords'][number] => {
    // 主结论只有一个：这条词在**当前配置的偏置通道**里到底占没占上位置。
    // 热词长度是次要事实，放 hotwordFits 里附带说明，不拿来顶替主结论（否则默认协议下
    // 一个根本没走热词通道的词会被报成"太长"，用户以为是自己写错了）。
    const fits = hotwordFits(word);
    const why2 = fits ? '' : '；注意它超出官方热词长度上限（非 ASCII 15 字 / 纯 ASCII 7 段），换原生协议时不会进即时热词表';
    if (!config.contextEnabled) {
      return { word, verdict: 'bias-off', hotwordFits: fits, why: '服务端事前偏置当前是关的（ASR_CONTEXT_ENABLED=0），常用词不会发给模型' };
    }
    if (canonicalSet.has(word)) {
      return { word, verdict: 'already-in-builtin', hotwordFits: fits, why: '内置术语表本来就有这个词，重复登记不额外起作用' + why2 };
    }
    if (!withUsers.text.includes(word)) {
      return { word, verdict: 'dropped-by-budget', hotwordFits: fits, why: `上下文预算 ${config.contextMaxChars} 字已被表内词用满，这个词被挤掉了（可上调 ASR_CONTEXT_MAX_CHARS）` + why2 };
    }
    return { word, verdict: 'in-context', hotwordFits: fits, why: '已进入本次构造的上下文实体词表' + why2 };
  });

  const pairs = input.pairs.map((p): LexiconReport['pairs'][number] => {
    const owner = aliasOwner.get(p.from);
    if (protectSet.has(p.from)) {
      return { from: p.from, to: p.to, verdict: 'collides-with-protect', why: `「${p.from}」在常用词保护名单里，替换它会影响日常用语；要保留请确认你确实想改这个词` };
    }
    if (canonicalSet.has(p.from)) {
      return { from: p.from, to: p.to, verdict: 'rewrites-a-builtin-term', why: `「${p.from}」本身是内置表的正确写法，这条登记会把对的改成别的` };
    }
    if (owner && owner !== p.to) {
      return { from: p.from, to: p.to, verdict: 'overrides-builtin-alias', why: `内置表把「${p.from}」纠到「${owner}」，你的登记优先级更高（第零遍先占位），以后会按你说的改成「${p.to}」` };
    }
    if (owner && owner === p.to) {
      return { from: p.from, to: p.to, verdict: 'redundant-with-builtin', why: '内置表已经做同样的替换，这条登记不改变结果（留着也无害，可当备份）' };
    }
    return { from: p.from, to: p.to, verdict: 'active', why: '生效：识别结果里出现该写法时逐处替换' };
  });

  // 合并候选：常用词 + 词对的 to，凡内置表没有的都值得考虑进表（进了表就能走同音纠错，不再只靠提示）
  const seen = new Set<string>();
  const candidates: MergeCandidate[] = [];
  const needPinyin: string[] = [];
  const aliasByTarget = new Map<string, string[]>();
  for (const p of input.pairs) {
    const list = aliasByTarget.get(p.to) ?? [];
    if (!list.includes(p.from)) list.push(p.from);
    aliasByTarget.set(p.to, list);
  }
  for (const word of [...input.keywords, ...aliasByTarget.keys()]) {
    if (seen.has(word) || canonicalSet.has(word)) continue;
    seen.add(word);
    const syll = deriveSyllables(word, terms);
    if (!syll) {
      needPinyin.push(word);
      continue;
    }
    candidates.push({
      canonical: word,
      syll,
      aliases: aliasByTarget.get(word) ?? [],
      weight: 4,
      domain: 'user',
      blockAfter: []
    });
  }

  return {
    ok: true,
    builtIn: {
      terms: terms.length,
      fingerprint: glossaryFingerprint(terms, protect),
      protect: protectSet.size,
      ambiguousKeys: ambiguousSyllables(terms).size,
      byDomain
    },
    effective: {
      protocol: config.protocol,
      contextEnabled: config.contextEnabled,
      contextMaxChars: config.contextMaxChars,
      hotwordsEnabled: config.hotwordsEnabled,
      hotwordsMax: config.hotwordsMax,
      termCorrectEnabled: process.env.ASR_TERM_CORRECT !== '0',
      contextTerms: baseContext.termCount,
      contextChars: baseContext.chars,
      omittedFromBudget: baseContext.omitted
    },
    keywords,
    pairs,
    merge: { candidates, needPinyin }
  };
}

export async function handleAsrLexiconCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const actor = currentActor();
  if (!actor) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'authentication_required', message: '语音词汇体检需要登录身份' }));
    return;
  }
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    res.writeHead(body.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: body.code, message: body.message }));
    return;
  }
  const payload = (body.value ?? {}) as Record<string, unknown>;
  let glossary;
  try {
    glossary = loadGlossaryData();
  } catch (err) {
    // 内置表坏了要说清楚是哪一条，而不是给一份"看起来正常"的空体检报告
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: 'glossary_unavailable',
      message: `内置术语表读不出来，体检无法进行：${err instanceof Error ? err.message : String(err)}`
    }));
    return;
  }
  // 数据集封闭集合：预算够不够要按"真会发出去的那一份"算，拿不到就当空（结论会偏乐观，
  // 但那种情况下界面拿到的 effective 数字与请求里的一致，不会出现两套口径）
  let datasetTerms: string[] = [];
  try {
    datasetTerms = lexiconFromDataset(loadDataset()).map((entry) => entry.canonical);
  } catch {
    /* 数据集不可用：只按术语表算预算 */
  }
  const report = buildLexiconReport(glossary.terms, glossary.protect, {
    keywords: sanitizeKeywords(payload['keywords']),
    pairs: sanitizeTermPairs(payload['pairs']),
    datasetTerms
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(report, null, 2));
}
