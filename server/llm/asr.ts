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
  /** 音频语种。空字符串 = 不发 language（混合语种时官方建议不设） */
  language: string;
  /** 逆文本规范化：口语数字→阿拉伯数字。默认关，实测达标再开 */
  enableItn: boolean;
  /** 是否把术语表当上下文发给模型（事前偏置） */
  contextEnabled: boolean;
  /** 上下文字符上限；超出按权重丢弃并如实计数 */
  contextMaxChars: number;
}

/**
 * 上游参数支持的保守默认。
 * 依据阿里云《非实时语音识别（Qwen-ASR）API 参考》：qwen3-asr-flash 的 OpenAI 兼容模式
 * 支持「首位 system 消息作为 Context（可用于实体词表）」与 asr_options{language,enable_itn}，
 * 且**不支持传统系统提示词** —— 所以那条消息只放词、不放指令。
 */
const DEFAULT_ASR_LANGUAGE = 'zh';
const DEFAULT_CONTEXT_MAX_CHARS = 1200;
/**
 * transcriptions 协议走 Whisper 系，`prompt` 只有 **224 token** 窗口（官方 Whisper prompting guide）。
 * 这里没有分词器，用字符数保守近似上限；宁可少放也不能让请求被拒。
 */
const WHISPER_PROMPT_MAX_CHARS = 480;

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
/**
 * 启动时一次性触发 .env 装载（幂等；.env 不存在则跳过，不报错）。
 * ⚠️ 不能放进 getAsrConfig() 里每次调用：那样运行时/测试里被清掉的环境变量
 *    会被 .env 反复灌回来 —— 测试删了 DASHSCOPE_API_KEY 却仍判定"已配置"，
 *    「诚实降级」就无从验证（实测踩过）。装载只做一次，之后只读 process.env。
 */
getConfig();

export function getAsrConfig(): AsrConfig {
  const env = process.env;
  const dashscopeKey = env.DASHSCOPE_API_KEY ?? '';
  const dashscopeBase = (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  return {
    apiKey: env.ASR_API_KEY || dashscopeKey,
    baseUrl: (env.ASR_BASE_URL || dashscopeBase).replace(/\/+$/, ''),
    model: env.ASR_MODEL || 'qwen3-asr-flash',
    protocol: env.ASR_PROTOCOL === 'transcriptions' ? 'transcriptions' : env.ASR_PROTOCOL === 'chat_audio' ? 'chat_audio' : 'chat_audio',
    timeoutMs: clampInt(env.ASR_TIMEOUT_MS, 30000, 3000, 120000),
    // 显式置空（ASR_LANGUAGE=）表示"不发 language"，与"未设置=用默认 zh"是两种意思
    language: env.ASR_LANGUAGE === undefined ? DEFAULT_ASR_LANGUAGE : env.ASR_LANGUAGE.trim(),
    enableItn: env.ASR_ENABLE_ITN === '1',
    contextEnabled: env.ASR_CONTEXT_ENABLED !== '0',
    contextMaxChars: clampInt(env.ASR_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_CHARS, 0, 20000)
  };
}

export function isAsrConfigured(): boolean {
  return Boolean(getAsrConfig().apiKey);
}

/** 本次请求实际带上了哪些可选参数 —— 失败降级后必须让人看得见，不许静默假装生效 */
export type AsrApplied = {
  context: boolean;
  options: boolean;
  language: string;
  itn: boolean;
  contextChars: number;
  /** 真为"上游不收这些参数，已降级重发"。不许静默假装增强生效 */
  degraded: boolean;
};

/** 上游回报的用量。上下文偏置会增加 input token，代价必须可核对而不是"感觉不贵" */
export type AsrUsage = {
  promptTokens?: number;
  completionTokens?: number;
  audioTokens?: number;
  seconds?: number;
};

export type AsrResult =
  | { ok: true; text: string; model: string; protocol: AsrProtocol; elapsedMs: number; applied: AsrApplied; usage: AsrUsage }
  | { ok: false; code: 'asr_not_configured' | 'bad_audio' | 'empty' | 'upstream_error'; message: string; status?: number };

export interface TranscribeInput {
  /** 纯 base64（不带 data: 前缀） */
  base64: string;
  /** 浏览器 MediaRecorder 的 mimeType（可含 codecs 后缀，这里会归一化） */
  mime: string;
  /**
   * 术语表上下文文本，由 API 层构造好传进来。
   * 本模块不认识词典：保持 llm 层可单测，也不让它反向依赖数据层。
   */
  contextText?: string;
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

/**
 * 一次上游请求的可选增强开关。降级阶梯就是按顺序试这几组：
 *   ①{上下文+参数} → ②{只参数} → ③{裸请求}
 * 先摘 asr_options（那是非标准的顶层字段，最容易被兼容网关拒绝），再摘 system 上下文。
 */
interface RequestVariant {
  withContext: boolean;
  withOptions: boolean;
}

function buildTranscriptionsRequest(
  config: AsrConfig,
  buffer: Buffer,
  mime: string,
  variant: RequestVariant,
  contextText: string
): { url: string; init: RequestInit; applied: Omit<AsrApplied, 'degraded'> } {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: normalizeMime(mime) }), `audio.${extForMime(mime)}`);
  form.append('model', config.model);
  // Whisper 系的 prompt 有 224 token 窗口，只能放权重最高的一小撮，超了会被拒或失效
  const prompt = variant.withContext && contextText ? contextText.slice(0, WHISPER_PROMPT_MAX_CHARS) : '';
  if (prompt) form.append('prompt', prompt);
  if (variant.withOptions && config.language) form.append('language', config.language);
  return {
    url: `${config.baseUrl}/audio/transcriptions`,
    init: { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form },
    applied: {
      context: Boolean(prompt),
      options: Boolean(variant.withOptions && config.language),
      language: variant.withOptions ? config.language : '',
      itn: false, // transcriptions 协议没有 enable_itn，别谎报
      contextChars: prompt.length
    }
  };
}

function buildChatAudioRequest(
  config: AsrConfig,
  base64: string,
  mime: string,
  variant: RequestVariant,
  contextText: string
): { url: string; init: RequestInit; applied: Omit<AsrApplied, 'degraded'> } {
  const messages: unknown[] = [];
  // 官方文档：这条 system 消息**必须在第一位**，且只用于背景文本与实体词表，
  // "不支持设置模型角色等传统系统提示词"。所以内容只有词表，没有任何指令句。
  // 形态照官方示例用 [{type:'text',text}]，不用裸字符串。
  if (variant.withContext && contextText) {
    messages.push({ role: 'system', content: [{ type: 'text', text: contextText }] });
  }
  // DashScope 兼容模式实测（2026-10-29，真实 Key）：input_audio.data 必须是完整
  // data URI（data:audio/wav;base64,xxx）——裸 base64 会被网关当 URL 解析而报
  // "The provided URL does not appear to be valid"。
  messages.push({
    role: 'user',
    content: [{ type: 'input_audio', input_audio: { data: `data:${normalizeMime(mime)};base64,${base64}`, format: extForMime(mime) } }]
  });

  const body: Record<string, unknown> = { model: config.model, messages };
  const asrOptions: Record<string, unknown> = {};
  if (config.language) asrOptions['language'] = config.language;
  if (config.enableItn) asrOptions['enable_itn'] = true;
  const sendOptions = variant.withOptions && Object.keys(asrOptions).length > 0;
  if (sendOptions) body['asr_options'] = asrOptions; // Node 侧作为请求体顶层参数（官方文档）

  return {
    url: `${config.baseUrl}/chat/completions`,
    init: { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    applied: {
      context: variant.withContext && Boolean(contextText),
      options: sendOptions,
      language: sendOptions && config.language ? config.language : '',
      itn: sendOptions && config.enableItn,
      contextChars: variant.withContext && contextText ? contextText.length : 0
    }
  };
}

function buildRequest(
  config: AsrConfig,
  input: TranscribeInput,
  buffer: Buffer,
  variant: RequestVariant,
  contextText: string
): { url: string; init: RequestInit; applied: Omit<AsrApplied, 'degraded'> } {
  return config.protocol === 'chat_audio'
    ? buildChatAudioRequest(config, input.base64, input.mime, variant, contextText)
    : buildTranscriptionsRequest(config, buffer, input.mime, variant, contextText);
}

/**
 * 上游 4xx 是否长得像"参数不认识"。只有这类错误值得摘参数重发；
 * 音频格式、鉴权、体积之类换个参数也不会好，退一次是白费额度。
 */
function looksLikeParameterRejection(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const text = body.toLowerCase();
  return /unknown (field|parameter|property)|unrecognized (key|field|argument)|unexpected key|extra inputs|not supported|unsupported param|invalid (param|body|request)|field required|input_schema_error|invalid_parameter/.test(text);
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

/**
 * 取上游用量。两种形态都要认：OpenAI 兼容的 usage.prompt_tokens /
 * prompt_tokens_details.audio_tokens，与 DashScope 原生的 input_tokens_details + seconds。
 * 拿不到就留空 —— 缺数据要看得见，不许填 0 冒充测过。
 */
function parseUsage(payload: unknown): AsrUsage {
  const root = payload as {
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      seconds?: unknown;
      prompt_tokens_details?: { audio_tokens?: unknown };
      input_tokens_details?: { text_tokens?: unknown };
    };
  } | null;
  const u = root?.usage;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const usage: AsrUsage = {};
  const prompt = num(u?.prompt_tokens);
  if (prompt !== undefined) usage.promptTokens = prompt;
  const completion = num(u?.completion_tokens);
  if (completion !== undefined) usage.completionTokens = completion;
  const audio = num(u?.prompt_tokens_details?.audio_tokens);
  if (audio !== undefined) usage.audioTokens = audio;
  const seconds = num(u?.seconds);
  if (seconds !== undefined) usage.seconds = seconds;
  return usage;
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

/**
 * 主入口：音频 base64 → 文本。
 * 网络/5xx/429 自动重试一次；4xx 里只有"像参数不认识"的才摘掉增强重发下一档，
 * 其余（鉴权、格式、体积）换参数也不会好，直接结束 —— 免得白烧上游额度。
 */
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

  const contextText = config.contextEnabled ? (input.contextText ?? '').trim().slice(0, config.contextMaxChars) : '';
  // 降级阶梯与 RequestVariant 注释同序：先摘 asr_options（非标准顶层字段，最容易被兼容网关拒），
  // 再摘 system 上下文，最后退回改造前的裸请求。
  const ladder: RequestVariant[] = [{ withContext: Boolean(contextText), withOptions: true }];
  if (contextText) ladder.push({ withContext: true, withOptions: false });
  ladder.push({ withContext: false, withOptions: false });

  const startedAt = Date.now();
  let lastStatus = 0;
  let lastBody = '';

  for (let i = 0; i < ladder.length; i += 1) {
    const variant = ladder[i]!;
    const request = buildRequest(config, input, payload.buffer, variant, contextText);
    let retryWithLess = false;
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
          return {
            ok: true,
            text,
            model: config.model,
            protocol: config.protocol,
            elapsedMs: Date.now() - startedAt,
            applied: { ...request.applied, degraded: i > 0 },
            usage: parseUsage(safeJson(bodyText))
          };
        }
        lastBody = bodyText.slice(0, 300);
        // 429 是配额/限流，不是"参数不认识"，必须留给同参数的网络重试（改造前就是这个口径）
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          retryWithLess = i + 1 < ladder.length && looksLikeParameterRejection(response.status, bodyText);
          break; // 其余 4xx：同参数重试没有意义
        }
      } catch (err) {
        lastBody = err instanceof Error ? err.message : String(err);
        lastStatus = lastStatus || 0;
      }
      if (attempt === 0) await delay(400);
    }
    if (!retryWithLess) break;
  }

  return {
    ok: false,
    code: 'upstream_error',
    message: `识别服务暂不可用（HTTP ${lastStatus || '网络错误'}）${lastBody ? '：' + lastBody : ''}，请稍后重试`,
    status: lastStatus || undefined
  };
}
