/**
 * 语音识别（ASR）客户端 —— 语音输入的唯一模型通道
 * ============================================================================
 *  设计目标：前端录完音 → 服务端转文字，模型**只在这里接**（.env 三个变量即可切换）。
 *
 *  支持两种上游协议：
 *    1. transcriptions（默认）—— OpenAI 兼容 POST {base}/audio/transcriptions，
 *       multipart 上传音频文件，返回 {text}。以下服务开箱即用：
 *         · SiliconFlow  FunAudioLLM/SenseVoiceSmall（免费档，大陆直连，推荐首选）
 *         · Groq         whisper-large-v3-turbo（免费档大方，但大陆需代理）
 *         · OpenAI       whisper-1 / gpt-4o-mini-transcribe（付费）
 *    2. chat_audio —— 音频以 input_audio 进 OpenAI 兼容 /chat/completions，
 *       适配 DashScope 兼容模式的 qwen3-asr-flash 一类网关。
 *
 *  与聊天/任务两条主链路的关系：完全独立、密钥独立（ASR_API_KEY）。
 *  未配置 Key ⇒ 调用方拿到 asr_not_configured，如实降级——绝不借另一家 Key
 *  冒充、也不本地假装识别（与全局"诚实降级"人格一致）。
 *
 *  Key 只读于服务端，永不进日志；上游错误只回传状态码与脱敏片段。
 */

import { getConfig } from '../config.ts';

export type AsrProtocol = 'transcriptions' | 'chat_audio';

export interface AsrConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol: AsrProtocol;
  timeoutMs: number;
}

/** 音频解码后的大小上限（base64 6 MiB 请求体 ≈ 解码 4 MiB） */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
/** 太短的音频不可能是有效语音（防误触/空文件打上游） */
export const MIN_AUDIO_BYTES = 800;

/** 服务端接受的音频 MIME（MediaRecorder 实际产出的都在里面） */
const ALLOWED_MIME = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/mp3',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/aac', 'audio/flac'
]);

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 每次调用现读环境变量：.env 由 config.ts 在启动时装载，这里负责映射与默认值。
 *  默认直连阿里云百炼（DashScope 兼容模式）qwen3-asr-flash，**Key 回落复用
 *  DASHSCOPE_API_KEY**——聊天链与语音识别共用同一个百炼 Key，一处配置两处生效；
 *  想换供应商（SiliconFlow/Groq/OpenAI）时用 ASR_* 覆盖，互不影响聊天链。 */
export function getAsrConfig(): AsrConfig {
  getConfig(); // 幂等触发 .env 装载（避免绕过 config 直接读 env 时 .env 未加载）
  const env = process.env;
  const dashscopeKey = env.DASHSCOPE_API_KEY ?? '';
  const dashscopeBase = (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  return {
    apiKey: env.ASR_API_KEY || dashscopeKey,
    baseUrl: (env.ASR_BASE_URL || dashscopeBase).replace(/\/+$/, ''),
    model: env.ASR_MODEL || 'qwen3-asr-flash',
    protocol: env.ASR_PROTOCOL === 'transcriptions' ? 'transcriptions' : env.ASR_PROTOCOL === 'chat_audio' ? 'chat_audio' : 'chat_audio',
    timeoutMs: clampInt(env.ASR_TIMEOUT_MS, 30000, 3000, 120000)
  };
}

export function isAsrConfigured(): boolean {
  return Boolean(getAsrConfig().apiKey);
}

export type AsrResult =
  | { ok: true; text: string; model: string; protocol: AsrProtocol; elapsedMs: number }
  | { ok: false; code: 'asr_not_configured' | 'bad_audio' | 'empty' | 'upstream_error'; message: string; status?: number };

export interface TranscribeInput {
  /** 纯 base64（不带 data: 前缀） */
  base64: string;
  /** 浏览器 MediaRecorder 的 mimeType（可含 codecs 后缀，这里会归一化） */
  mime: string;
}

/** 把 MediaRecorder 的 mimeType 归一化为协议需要的基础类型 */
export function normalizeMime(mime: string): string {
  return (mime || '').split(';')[0].trim().toLowerCase();
}

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME.has(normalizeMime(mime));
}

/** MIME → 上游文件扩展名（multipart 文件名与 input_audio.format 都用它） */
export function extForMime(mime: string): string {
  const base = normalizeMime(mime);
  if (base === 'audio/mpeg' || base === 'audio/mp3') return 'mp3';
  if (base === 'audio/x-wav' || base === 'audio/wave') return 'wav';
  return base.replace('audio/', '');
}

export function validateAudioPayload(input: { base64: string; mime: string }): { ok: true; buffer: Buffer } | { ok: false; code: 'bad_audio'; message: string } {
  if (typeof input.base64 !== 'string' || input.base64.length < 32) {
    return { ok: false, code: 'bad_audio', message: '缺少音频数据' };
  }
  if (!isAllowedMime(input.mime)) {
    return { ok: false, code: 'bad_audio', message: `不支持的音频格式：${normalizeMime(input.mime) || '(空)'}` };
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.base64, 'base64');
  } catch {
    return { ok: false, code: 'bad_audio', message: '音频 base64 解码失败' };
  }
  if (buffer.length < MIN_AUDIO_BYTES) {
    return { ok: false, code: 'bad_audio', message: '音频过短，无法识别' };
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    return { ok: false, code: 'bad_audio', message: `音频超过 ${Math.floor(MAX_AUDIO_BYTES / 1024)} KiB 上限，请缩短录音` };
  }
  return { ok: true, buffer };
}

function buildTranscriptionsRequest(config: AsrConfig, buffer: Buffer, mime: string): { url: string; init: RequestInit } {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: normalizeMime(mime) }), `audio.${extForMime(mime)}`);
  form.append('model', config.model);
  return {
    url: `${config.baseUrl}/audio/transcriptions`,
    init: { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form }
  };
}

function buildChatAudioRequest(config: AsrConfig, base64: string, mime: string): { url: string; init: RequestInit } {
  // DashScope 兼容模式实测（2026-10-29，真实 Key）：input_audio.data 必须是完整
  // data URI（data:audio/wav;base64,xxx）——裸 base64 会被网关当 URL 解析而报
  // "The provided URL does not appear to be valid"。
  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: `data:${normalizeMime(mime)};base64,${base64}`, format: extForMime(mime) } }]
        }]
      })
    }
  };
}

/** 从 chat/completions 的回复里取纯文本（content 可能是 string，也可能是分段数组） */
function textFromChatCompletion(payload: unknown): string {
  const root = payload as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = root?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
      .trim();
  }
  return '';
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 容错 JSON 解析：上游偶发截断/HTML 错误页时不抛异常 */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {} as unknown;
  }
}

/** 主入口：音频 base64 → 文本。网络/5xx/429 自动重试一次，超时可配。 */
export async function transcribeAudio(input: TranscribeInput): Promise<AsrResult> {
  const config = getAsrConfig();
  if (!config.apiKey) {
    return {
      ok: false,
      code: 'asr_not_configured',
      message: '语音识别未配置：在服务端 .env 设置 ASR_API_KEY（可选 ASR_BASE_URL / ASR_MODEL / ASR_PROTOCOL）后重启服务端即可启用'
    };
  }
  const payload = validateAudioPayload(input);
  if (!payload.ok) return { ok: false, code: payload.code, message: payload.message };

  const request = config.protocol === 'chat_audio'
    ? buildChatAudioRequest(config, input.base64, input.mime)
    : buildTranscriptionsRequest(config, payload.buffer, input.mime);

  const startedAt = Date.now();
  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(config.timeoutMs) });
      lastStatus = response.status;
      // 先完整读 body 再解析（响应含完整 JSON；截断会让 JSON.parse 假性失败）
      const bodyText = await response.text().catch(() => '');
      if (response.ok) {
        const text = config.protocol === 'chat_audio'
          ? textFromChatCompletion(safeJson(bodyText))
          : String((safeJson(bodyText) as { text?: unknown }).text ?? '').trim();
        if (!text) {
          return { ok: false, code: 'empty', message: '没有听清，请靠近一点再说一次', status: lastStatus };
        }
        return { ok: true, text, model: config.model, protocol: config.protocol, elapsedMs: Date.now() - startedAt };
      }
      lastBody = bodyText.slice(0, 300);
      // 429 / 5xx 换一次机会；其余状态码（4xx）是请求本身的问题，重试无意义
      if (response.status !== 429 && response.status < 500) break;
    } catch (err) {
      lastBody = err instanceof Error ? err.message : String(err);
      lastStatus = lastStatus || 0;
    }
    if (attempt === 0) await delay(400);
  }

  return {
    ok: false,
    code: 'upstream_error',
    message: `识别服务暂不可用（HTTP ${lastStatus || '网络错误'}）${lastBody ? '：' + lastBody : ''}，请稍后重试`,
    status: lastStatus || undefined
  };
}
