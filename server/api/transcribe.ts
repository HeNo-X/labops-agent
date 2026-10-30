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

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const DEFAULT_HOURLY_LIMIT = 60;

/**
 * 专有名词词典按数据集版本缓存。
 * 数据集在一次部署内不可变，所以只在 loadedAt / 表量变化时重建。
 * 取不到数据集时退化为"不纠错"——纠错是增强，绝不能让语音输入整体失败。
 */
let lexiconCache: { key: string; entries: LexiconEntry[] } | null = null;
function currentLexicon(): LexiconEntry[] {
  try {
    const ds = loadDataset();
    const key = `${ds.loadedAt}|${ds.labs.length}|${ds.openLabs.length}|${ds.timetable.length}`;
    if (lexiconCache?.key !== key) lexiconCache = { key, entries: lexiconFromDataset(ds) };
    return lexiconCache.entries;
  } catch {
    return [];
  }
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

  // 专有名词纠错：房间号/班级名/课程名这类封闭集合，用本地词典确定性纠正。
  // 不依赖模型侧热词（当前 chat_audio 协议没有热词参数），也不改前端。
  const raw = result.text;
  let text = raw;
  let corrections: Correction[] = [];
  if (raw && process.env['ASR_TERM_CORRECT'] !== '0') {
    const fixed = correctTranscript(raw, currentLexicon());
    text = fixed.text;
    corrections = fixed.corrections;
  }

  reply(res, 200, {
    ok: true,
    text,
    // 只有真的改过才回传原文与改动清单，未改动时响应体与旧版完全一致
    ...(corrections.length ? { originalText: raw, corrections } : {}),
    model: result.model,
    protocol: result.protocol,
    elapsedMs: result.elapsedMs
  });
}
