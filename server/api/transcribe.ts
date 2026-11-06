/**
 * POST /api/agent/transcribe —— 语音输入的转写端点
 * ============================================================================
 *  前端 useVoiceInput 录音 → base64 JSON → 这里 → server/llm/asr.ts → 文本。
 *  音频**只做临时转写、用后即弃**：不落盘、不入证据库、不进会话历史
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
import { transcribeAudio } from '../llm/asr.ts';
import { loadDataset } from '../data/store.ts';
import {
  correctTranscript,
  lexiconFromDataset,
  type Correction,
  type LexiconEntry
} from '../llm/asr-lexicon.ts';
import {
  loadGlossaryData,
  glossaryToLexicon,
  glossaryFingerprint,
  charSyllableTable,
  ambiguousSyllables
} from '../llm/asr-glossary.ts';

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const DEFAULT_HOURLY_LIMIT = 60;

/**
 * 纠错词典 = Tier A（数据集来的封闭集合）∪ Tier B（人工术语表，带音节键）。
 * 缓存在"数据集版本 + 术语表指纹"上：改了词表立刻生效，不会"改了但没跑"。
 * 任一侧取不到就退化成另一侧；两侧都没有就是不纠错 —— 纠错是增强，
 * 绝不能让语音输入整体失败，也绝不因为词典没加载上而假装纠过。
 */
interface CorrectBundle {
  key: string;
  entries: LexiconEntry[];
  syllables: Map<string, string>;
  protect: Set<string>;
  ambiguous: Set<string>;
}
let bundleCache: CorrectBundle | null = null;

function currentBundle(): CorrectBundle {
  let glossary;
  try {
    glossary = loadGlossaryData();
  } catch {
    glossary = { terms: [], protect: [] };
  }
  const fingerprint = glossaryFingerprint(glossary.terms, glossary.protect);
  let tierA: LexiconEntry[] = [];
  let datasetKey = 'no-dataset';
  try {
    const ds = loadDataset();
    datasetKey = `${ds.loadedAt}|${ds.labs.length}|${ds.openLabs.length}|${ds.timetable.length}`;
    tierA = lexiconFromDataset(ds);
  } catch {
    /* 数据集拿不到：只靠人工术语表 */
  }
  const key = `${datasetKey}+${fingerprint}`;
  if (bundleCache?.key === key) return bundleCache;
  const tierB = glossaryToLexicon(glossary.terms);
  const bundle: CorrectBundle = {
    key,
    entries: [...tierA, ...tierB],
    syllables: charSyllableTable(glossary.terms),
    protect: new Set(glossary.protect),
    ambiguous: ambiguousSyllables(glossary.terms)
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

  const result = await transcribeAudio({ base64: audio, mime });
  if (!result.ok) {
    reply(res, result.code === 'asr_not_configured' ? 503 : result.code === 'bad_audio' ? 400 : 502, {
      error: result.code,
      message: result.message
    });
    return;
  }

  // 专有名词纠错：Tier A 封闭集合走字符距离，Tier B 实验室术语走完全同音。
  // 不依赖模型侧热词（当前 chat_audio 没有 vocabulary 参数），也不改前端契约。
  // 用户点过「本轮不要调整术语」时按请求级别跳过 —— 决定权在说话的人手里，不在词典手里。
  const raw = result.text;
  let text = raw;
  let corrections: Correction[] = [];
  const skipped = payload['skipTermCorrect'] === true;
  if (raw && !skipped && process.env['ASR_TERM_CORRECT'] !== '0') {
    const bundle = currentBundle();
    const fixed = correctTranscript(raw, bundle.entries, {
      syllables: bundle.syllables,
      protect: bundle.protect,
      ambiguous: bundle.ambiguous
    });
    text = fixed.text;
    corrections = fixed.corrections;
  }

  reply(res, 200, {
    ok: true,
    text,
    // 只有真的改过才回传原文与改动清单，未改动时响应体与旧版完全一致
    ...(corrections.length ? { originalText: raw, corrections } : {}),
    // 用户主动叫停时如实标注，不让人以为"这个词表没生效"是故障
    ...(skipped ? { termCorrectSkipped: true } : {}),
    model: result.model,
    protocol: result.protocol,
    elapsedMs: result.elapsedMs
  });
}
