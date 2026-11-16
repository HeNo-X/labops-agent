/**
 * POST /api/agent/transcribe —— 语音输入的转写端点
 * ============================================================================
 *  前端 useVoiceInput 录音 → base64 JSON → 这里 → server/llm/asr.ts → 文本。
 *  音频**只做转写、用后即弃**：不落盘、不入证据库、不进会话历史
 *  （证据附件管线按魔数只收 PNG/JPEG/WebP/PDF/文本，audio/* 本来就进不去）。
 *
 *  请求体上限 6 MiB（base64 的 4 MiB 音频 ≈ 5.33 MiB 字符 + JSON 开销），
 *  远小于 nginx 的 client_max_body_size 10m，无需动部署配置。
 *
 *  鉴权：与 /api/agent/chat 同层（withHttpIdentity 统一包裹），仅登录的
 *  管理员/志愿者可用；另加每账号每小时配额，防止长按误触把上游免费额度烧光。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody } from './agent-chat.ts';
import { currentActor } from '../security/context.ts';
import { transcribeAudio, getAsrConfig } from '../llm/asr.ts';
import { loadDataset } from '../data/store.ts';
import {
  correctTranscript,
  lexiconFromDataset,
  sanitizeTermPairs,
  type Correction,
  type LexiconEntry
} from '../llm/asr-lexicon.ts';
import {
  loadGlossaryData,
  glossaryToLexicon,
  glossaryFingerprint,
  hotwordVocabulary,
  withKeywordHotwords,
  sanitizeKeywords,
  charSyllableTable,
  ambiguousSyllables,
  buildContextText
} from '../llm/asr-glossary.ts';

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const DEFAULT_HOURLY_LIMIT = 60;

/**
 * 纠错词典 = Tier A（数据集来的封闭集合）∪ Tier B（人工术语表，带音节键）。
 * 缓存在"数据集版本 + 术语表指纹"上：改了词表立刻生效，不会"改了但没跑"。
 * 任一侧取不到就退化成另一侧；两侧都没有就是不纠错 —— 纠错是增强，
 * 绝不能让语音输入整体失败，也绝不因为词典没加载上就声称已纠错。
 */
interface CorrectBundle {
  key: string;
  entries: LexiconEntry[];
  syllables: Map<string, string>;
  protect: Set<string>;
  ambiguous: Set<string>;
  /** 事前偏置用的上下文文本（构造一次缓存复用；预算由 ASR_CONTEXT_MAX_CHARS 控制） */
  contextText: string;
  contextOmitted: number;
  contextTerms: number;
  /** 即时热词（仅 dashscope_native 会用；其它协议发了也没人收，所以不构造） */
  hotwords: Record<string, number>;
  /** 本次参与构造偏置的用户常用词（已清洗）。留着是为了能把"登记了几条"如实回传 */
  keywords: readonly string[];
}
let bundleCache: CorrectBundle | null = null;

function currentBundle(keywords: readonly string[] = []): CorrectBundle {
  let glossary;
  try {
    glossary = loadGlossaryData();
  } catch {
    glossary = { terms: [], protect: [] };
  }
  const fingerprint = glossaryFingerprint(glossary.terms, glossary.protect);
  const config = getAsrConfig();
  let tierA: LexiconEntry[] = [];
  let datasetKey = 'no-dataset';
  try {
    const ds = loadDataset();
    datasetKey = `${ds.loadedAt}|${ds.labs.length}|${ds.openLabs.length}|${ds.timetable.length}`;
    tierA = lexiconFromDataset(ds);
  } catch {
    /* 数据集拿不到：只靠人工术语表 */
  }
  // 用户常用词也进缓存键：同一套词不重复构造，换一套词立刻重来（不许"改了但没生效"）
  const key = `${datasetKey}+${fingerprint}+${config.contextMaxChars}+${config.protocol}+${config.hotwordsMax}+${keywords.join('\u0001')}`;
  if (bundleCache?.key === key) return bundleCache;
  const tierB = glossaryToLexicon(glossary.terms);
  // 常用词和 Tier A 一样只走 extraTerms：它们是"展示串"，不参与音节/编辑距离判定。
  // 排在一起交给 buildContextText 按预算取舍，超预算的数量在 omittedFromBudget 里看得见。
  const context = buildContextText(glossary.terms, {
    maxChars: config.contextMaxChars,
    extraTerms: [...tierA.map((entry) => entry.canonical), ...keywords]
  });
  const bundle: CorrectBundle = {
    key,
    entries: tierB.length ? [...tierA, ...tierB] : tierA,
    syllables: charSyllableTable(glossary.terms),
    protect: new Set(glossary.protect),
    ambiguous: ambiguousSyllables(glossary.terms),
    contextText: context.text,
    contextOmitted: context.omitted,
    contextTerms: context.termCount,
    keywords,
    // 只有原生协议收 vocabulary；其它协议构造了也是死数据，不如不给
    hotwords: config.protocol === 'dashscope_native'
      ? withKeywordHotwords(hotwordVocabulary(glossary.terms, config.hotwordsMax), keywords, config.hotwordsMax)
      : {}
  };
  bundleCache = bundle;
  return bundle;
}

/** 每账号小时配额（进程内计数即可：转写是短时操作，重启清零无妨） */
const quota = new Map<string, { windowStart: number; used: number }>();
function withinQuota(actorId: string): boolean {
  const limit = Math.max(1, Number(process.env.LABOPS_TRANSCRIBE_PER_HOUR) || DEFAULT_HOURLY_LIMIT);
  const now = Date.now();
  const entry = quota.get(actorId);
  if (!entry || now - entry.windowStart >= 3600_000) {
    quota.set(actorId, { windowStart: now, used: 1 });
    return true;
  }
  entry.used += 1;
  return entry.used <= limit;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

export async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const actor = currentActor();
  if (!actor) {
    reply(res, 401, { error: 'authentication_required', message: '语音转写需要登录身份' });
    return;
  }

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    reply(res, body.status, { error: body.code, message: body.message });
    return;
  }

  const payload = (body.value ?? {}) as Record<string, unknown>;
  const audio = typeof payload['audio'] === 'string' ? payload['audio'] : '';
  const mime = typeof payload['mime'] === 'string' ? payload['mime'] : '';
  if (!audio || !mime) {
    reply(res, 400, { error: 'missing_audio', message: '请求体需要 { "audio": "<base64>", "mime": "audio/webm" }' });
    return;
  }

  if (!withinQuota(actor.id)) {
    reply(res, 429, { error: 'rate_limited', message: '语音转写已达每小时配额，请稍后再试' });
    return;
  }

  const skipped = payload['skipTermCorrect'] === true;
  // 说话的人自己登记的写法：「识别成 → 应该是」词对（第零遍精确替换）与常用词（只影响事前偏置）。
  // 词对不受"叫停"影响（那是用户明确写的规则），常用词受影响（它和词典偏置是同一类"系统在影响
  // 这句话怎么被听出来"的东西，叫停就得一起停，否则界面会出现解释不清的中间态）。
  const userPairs = sanitizeTermPairs(payload['termPairs']);
  const keywords = skipped ? [] : sanitizeKeywords(payload['extraTerms']);
  const bundle = currentBundle(keywords);
  // 用户点过「本页不再自动调整术语」→ 事前偏置（上下文与热词）与词典自动纠错一起停。
  const contextText = skipped ? '' : bundle.contextText;
  const hotwords = skipped ? {} : bundle.hotwords;

  const result = await transcribeAudio({ base64: audio, mime, contextText, hotwords });
  if (!result.ok) {
    reply(res, result.code === 'asr_not_configured' ? 503 : result.code === 'bad_audio' ? 400 : 502, {
      error: result.code,
      message: result.message
    });
    return;
  }

  // 事后纠错：Tier A 封闭集合走字符距离，Tier B 实验室术语走完全同音（四道闸门，见 asr-lexicon），
  // 第零遍是说话的人自己登记的写法（精确替换，优先级最高）。
  // 事前偏置：实体词表作为首位 system 上下文发给模型（官方支持，不是热词参数）。
  // 决定权在说话的人手里：他可以叫停系统的自动调整，但不该被禁止使用他自己写下的规则。
  const raw = result.text;
  let text = raw;
  let corrections: Correction[] = [];
  if (raw && process.env['ASR_TERM_CORRECT'] !== '0' && (!skipped || userPairs.length)) {
    const fixed = correctTranscript(raw, bundle.entries, {
      syllables: bundle.syllables,
      protect: bundle.protect,
      ambiguous: bundle.ambiguous,
      userPairs,
      skipLexicon: skipped
    });
    text = fixed.text;
    corrections = fixed.corrections;
  }

  reply(res, 200, {
    ok: true,
    text,
    // 只有真的改过才回传原文与改动清单，未改动时不返回这两项
    ...(corrections.length ? { originalText: raw, corrections } : {}),
    // 用户主动叫停时如实标注，不让人以为"这个词表没生效"是故障
    ...(skipped ? { termCorrectSkipped: true } : {}),
    // 事前偏置的真实状态：发了多少词、被预算挤掉多少、上游收不收、是否降级重发。
    // 只报"开了"不够，degraded 与 omitted 都必须看得见；
    // 没发出去（开关关着 / 用户叫停 / 上游拒收后摘掉了）就照实报 0，不拿"备好但没用上"充数。
    bias: {
      ...result.applied,
      termsInContext: result.applied.context ? bundle.contextTerms : 0,
      omittedFromBudget: result.applied.context ? bundle.contextOmitted : 0,
      hotwordsAvailable: Object.keys(bundle.hotwords).length,
      // 用户常用词的登记数。它们只走"事前"这两条有出处的通道（上下文实体词表 / 原生 vocabulary），
      // 到底发没发出去看同一份 applied 里的 context 与 hotwords —— 不得用登记数代替已生效数量。
      userKeywordsRegistered: bundle.keywords.length,
      suppressedByUser: skipped
    },
    // 上游用量原样转述，缺就缺（上下文会增加 input token，代价要能被核对）
    usage: result.usage,
    model: result.model,
    protocol: result.protocol,
    elapsedMs: result.elapsedMs
  });
}
