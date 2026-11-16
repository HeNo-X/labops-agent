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
 *  未配置 Key ⇒ 调用方拿到 asr_not_configured，如实降级——不借用其他供应商的 Key，
 *  也不在本地伪造识别结果。
 *
 *  Key 只读于服务端，永不进日志；上游错误只回传状态码与脱敏片段。
 */

import { getConfig } from '../config.ts';

export type AsrProtocol = 'transcriptions' | 'chat_audio' | 'dashscope_native';

export interface AsrConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol: AsrProtocol;
  timeoutMs: number;
  /** 音频语种。空字符串 = 不发 language（混合语种时官方建议不设） */
  language: string;
  /** 逆文本规范化：口语数字→阿拉伯数字。默认关，验证达标后再开启 */
  enableItn: boolean;
  /** 是否把术语表当上下文发给模型（事前偏置） */
  contextEnabled: boolean;
  /** 上下文字符上限；超出按权重丢弃并如实计数 */
  contextMaxChars: number;
  /**
   * 原生协议下的热词表（vocabulary）开关与条数上限。
   * 仅 `dashscope_native` 支持：即时热词是 `parameters.vocabulary`，
   * OpenAI 兼容的 chat_audio **没有这个参数**（只有 context 通道）。
   */
  hotwordsEnabled: boolean;
  hotwordsMax: number;
  /** 原生协议的服务地址（WorkspaceId 形态与兼容模式不同，不能直接复用 baseUrl） */
  nativeBaseUrl: string;
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
 * 即时热词条数上限。官方：Qwen-Audio 系每张表 ≤2000 词，Fun-ASR/Paraformer ≤500。
 * 这里保守取 500 —— 换到哪条模型线都不会超限，而超限时上游是直接报错而不是静默截断。
 */
const DEFAULT_HOTWORDS_MAX = 500;
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
 *    降级路径就无从验证。装载只做一次，之后只读 process.env。
 */
getConfig();

/**
 * 从兼容模式地址派生原生协议地址。三种写法都要收敛到 `/api/v1`，
 * 否则会拼出"看着像对、实际 404"的地址：
 *   https://x/compatible-mode/v1 → https://x/api/v1
 *   https://x/v1                 → https://x/api/v1
 *   https://x/api/v1             → 原样
 * WorkspaceId 形态请显式配 ASR_NATIVE_BASE_URL —— 不猜租户号，猜错只会得到一个难懂的 404。
 */
function deriveNativeBase(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  if (/\/api\/v1$/.test(clean)) return clean;
  if (/\/compatible-mode\/v1$/.test(clean)) return `${clean.slice(0, -'/compatible-mode/v1'.length)}/api/v1`;
  if (/\/v1$/.test(clean)) return `${clean.slice(0, -'/v1'.length)}/api/v1`;
  return clean;
}

export function getAsrConfig(): AsrConfig {
  const env = process.env;
  const dashscopeKey = env.DASHSCOPE_API_KEY ?? '';
  const dashscopeBase = (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const baseUrl = (env.ASR_BASE_URL || dashscopeBase).replace(/\/+$/, '');
  const protocol: AsrProtocol =
    env.ASR_PROTOCOL === 'transcriptions' ? 'transcriptions'
      : env.ASR_PROTOCOL === 'dashscope_native' ? 'dashscope_native'
        : 'chat_audio';
  return {
    apiKey: env.ASR_API_KEY || dashscopeKey,
    baseUrl,
    model: env.ASR_MODEL || 'qwen3-asr-flash',
    protocol,
    timeoutMs: clampInt(env.ASR_TIMEOUT_MS, 30000, 3000, 120000),
    // 显式置空（ASR_LANGUAGE=）表示"不发 language"，与"未设置=用默认 zh"是两种意思
    language: env.ASR_LANGUAGE === undefined ? DEFAULT_ASR_LANGUAGE : env.ASR_LANGUAGE.trim(),
    enableItn: env.ASR_ENABLE_ITN === '1',
    // 默认**关**。理由有两边：一是参考词表上下文的效果尚未在真实录音上验证，
    // 二是上游会"把参考词表整段念回来"（静音样本，两种协议都如此）。
    // 未验证收益的能力不默认开启 —— 要试就显式设 ASR_CONTEXT_ENABLED=1，跑 --mode=live 对比再定。
    contextEnabled: env.ASR_CONTEXT_ENABLED === '1',
    contextMaxChars: clampInt(env.ASR_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_CHARS, 0, 20000),
    hotwordsEnabled: env.ASR_HOTWORDS !== '0',
    hotwordsMax: clampInt(env.ASR_HOTWORDS_MAX, DEFAULT_HOTWORDS_MAX, 1, 2000),
    // 原生协议的路径前缀与兼容模式不同，统一交给 deriveNativeBase 收敛
    nativeBaseUrl: deriveNativeBase(env.ASR_NATIVE_BASE_URL ? env.ASR_NATIVE_BASE_URL.trim() : baseUrl)
  };
}

export function isAsrConfigured(): boolean {
  return Boolean(getAsrConfig().apiKey);
}

/** 本次请求实际带上了哪些可选参数 —— 失败降级后必须让人看得见，结果里如实体现 */
export type AsrApplied = {
  context: boolean;
  options: boolean;
  /** 即时热词（parameters.vocabulary）是否真的发出；非原生协议恒 false，不含糊 */
  hotwords: boolean;
  hotwordCount: number;
  /**
   * parameters.format 是否真的发出。只有原生协议有这个字段；另两种协议的容器信息由
   * multipart 文件名 / data URI 前缀承载，不存在"没发"的问题，所以如实写 false。
   */
  format: boolean;
  language: string;
  itn: boolean;
  contextChars: number;
  /** 真为"上游不收这些参数，已降级重发"。降级状态必须在结果里如实体现 */
  degraded: boolean;
};

/** 上游回报的用量。上下文偏置会增加 input token，代价必须可核对而不是"感觉不贵" */
export type AsrUsage = {
  promptTokens?: number;
  completionTokens?: number;
  audioTokens?: number;
  /** 上下文词表占的文本 token：原生协议用它记上下文的代价，兼容模式则体现在 promptTokens */
  textTokens?: number;
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
  /**
   * 即时热词（词 → 权重 1～5），仅 dashscope_native 协议使用。
   * 同样由 API 层从术语表派生后传入，llm 层不认识词典。
   */
  hotwords?: Record<string, number>;
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
 * 一次上游请求的可选增强开关。上游 4xx 报"参数不认识"时**一次只摘一个**再重发，
 * 摘的顺序按"最可能被拒的先摘"：
 *   原生协议：vocabulary → parameters.format → parameters.asr_options → 上下文
 *   兼容协议：asr_options（非标准顶层字段）→ 上下文
 *   transcriptions：language → prompt
 * 依据是各参数的"标准化程度"：越是本协议没有文档承诺的字段，越可能被判 unknown parameter。
 * 上游若点名了具体字段（PARAM_HINTS），先摘被点名的那个 —— 否则就是拿"摘错的那个"再烧一次额度。
 * `withFormat` 只有原生协议用得到：官方示例里 format 属于 parameters（Qwen-Audio 系），
 * 而 qwen3-asr-flash 的原生参数表只列了 asr_options，所以它必须可摘，不能卡死退路。
 */
interface RequestVariant {
  withContext: boolean;
  withOptions: boolean;
  withHotwords: boolean;
  withFormat: boolean;
}

function dropOrderFor(protocol: AsrProtocol): Array<keyof RequestVariant> {
  return protocol === 'dashscope_native'
    ? ['withHotwords', 'withFormat', 'withOptions', 'withContext']
    : ['withOptions', 'withContext'];
}

/**
 * 就地关掉一个还开着的增强项：上游点名了就先关它，没点名就按顺序关第一个还开着的。
 * 全关着还失败时返回 false —— 裸请求都被拒，那不是参数问题，不许再退。
 */
function dropVariant(variant: RequestVariant, order: readonly (keyof RequestVariant)[], named?: keyof RequestVariant): boolean {
  if (named && variant[named]) {
    variant[named] = false;
    return true;
  }
  for (const key of order) {
    if (variant[key]) {
      variant[key] = false;
      return true;
    }
  }
  return false;
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
      hotwords: false, // vocabulary 是原生协议独有，兼容/transcriptions 都不支持，不谎报
      hotwordCount: 0,
      format: false, // 这两种协议没有 parameters.format，容器信息在文件名 / data URI 里
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
  // DashScope 兼容模式要求：input_audio.data 必须是完整
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
      hotwords: false, // chat_audio 没有 vocabulary 参数；只有原生那条路能发热词
      hotwordCount: 0,
      format: false, // 同上：兼容模式没有 parameters，容器信息在 data URI 前缀里
      language: sendOptions && config.language ? config.language : '',
      itn: sendOptions && config.enableItn,
      contextChars: variant.withContext && contextText ? contextText.length : 0
    }
  };
}

/**
 * DashScope 原生协议：唯一支持 `parameters.vocabulary`（即时热词）的一条路。
 * 形态照官方《非实时语音识别（Qwen-ASR）API 参考》+《提升识别准确率》：
 *   body = { model, input:{ messages }, parameters:{ asr_options, format, vocabulary } }
 *   音频在 content 的 audio 键里（data URI），可选参数全在 parameters，顶层没有 asr_options。
 * 热词权重官方区间 1～5（建议 4 起步），超级热词（权重 50）本表暂未使用。
 *
 * ⚠ 有意**不发 sample_rate**：我们不做重采样，浏览器 MediaRecorder 给的是 44.1k/48k，
 *   照着文档示例写 16000 等于对上游谎报采样率。要用 16k 通道请显式配
 *   ASR_NATIVE_SAMPLE_RATE（并且自己保证音频确实是那个采样率）。
 */
function buildNativeRequest(
  config: AsrConfig,
  input: TranscribeInput,
  variant: RequestVariant,
  contextText: string,
  hotwords: Record<string, number>
): { url: string; init: RequestInit; applied: Omit<AsrApplied, 'degraded'> } {
  const messages: unknown[] = [];
  // 原生协议的 content 部件用裸键名（{text}/{audio}），不是兼容模式的 {type:'text',...}
  if (variant.withContext && contextText) {
    messages.push({ role: 'system', content: [{ text: contextText }] });
  }
  // 原生形态：content 里直接给 audio（URL 或 base64 data URI，官方示例同款），
  // 不是兼容模式那套 type:input_audio —— 写错了上游当没有音频，返回空而不是报错。
  messages.push({ role: 'user', content: [{ audio: `data:${normalizeMime(input.mime)};base64,${input.base64}` }] });

  // 官方：可选参数全在 parameters 里（asr_options / format / sample_rate / vocabulary），
  // 请求体顶层没有 asr_options。
  const parameters: Record<string, unknown> = {};
  const sampleRate = Number(process.env.ASR_NATIVE_SAMPLE_RATE ?? '');
  if (variant.withFormat) parameters['format'] = extForMime(input.mime);
  // 没发 format 时单发 sample_rate 没有意义（format 都不认的网关更不会认它）
  if (parameters['format'] && Number.isInteger(sampleRate) && sampleRate > 0) parameters['sample_rate'] = sampleRate;

  const asrOptions: Record<string, unknown> = {};
  if (config.language) asrOptions['language'] = config.language;
  if (config.enableItn) asrOptions['enable_itn'] = true;
  const sendOptions = variant.withOptions && Object.keys(asrOptions).length > 0;
  if (sendOptions) parameters['asr_options'] = asrOptions;

  const sent: Record<string, number> = {};
  if (variant.withHotwords) {
    for (const [word, weight] of Object.entries(hotwords)) {
      sent[word] = Math.min(5, Math.max(1, Math.round(weight))); // 官方：普通热词 1～5
      if (Object.keys(sent).length >= config.hotwordsMax) break;
    }
  }
  if (Object.keys(sent).length) parameters['vocabulary'] = sent;

  const body: Record<string, unknown> = { model: config.model, input: { messages }, parameters };

  return {
    url: `${config.nativeBaseUrl}/services/aigc/multimodal-generation/generation`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'disable'
      },
      body: JSON.stringify(body)
    },
    applied: {
      context: variant.withContext && Boolean(contextText),
      options: sendOptions,
      hotwords: Boolean(parameters['vocabulary']),
      hotwordCount: Object.keys(sent).length,
      format: Boolean(parameters['format']),
      language: sendOptions && config.language ? config.language : '',
      itn: sendOptions && config.enableItn,
      contextChars: variant.withContext && contextText ? contextText.length : 0
    }
  };
}

/** 原生协议的回复文本：output.choices[].message.content 可能是字符串或 [{text}] */
function parseNativeText(payload: unknown): string {
  const root = payload as {
    output?: {
      text?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
  } | null;
  const content = root?.output?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
      .trim();
    if (joined) return joined;
  }
  return typeof root?.output?.text === 'string' ? root.output.text.trim() : '';
}

function buildRequest(
  config: AsrConfig,
  input: TranscribeInput,
  buffer: Buffer,
  variant: RequestVariant,
  contextText: string,
  hotwords: Record<string, number>
): { url: string; init: RequestInit; applied: Omit<AsrApplied, 'degraded'> } {
  if (config.protocol === 'dashscope_native') {
    return buildNativeRequest(config, input, variant, contextText, hotwords);
  }
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

/**
 * 上游点名了哪个字段 → 对应哪个开关。报错文本里带字段名是这两家网关的常见写法
 * （`Unknown parameter: 'vocabulary'.` / `system role is not supported`），
 * 认出来就能一步退到位，不必拿"摘错了的那个"再烧一次额度。认不出就交给梯子顺序。
 */
const PARAM_HINTS: Array<[RegExp, keyof RequestVariant]> = [
  [/vocabulary|hotword/i, 'withHotwords'],
  [/\bformat\b|sample_rate/i, 'withFormat'],
  [/asr_options|enable_itn|\blanguage\b/i, 'withOptions'],
  [/\bsystem\b|context|prompt\b/i, 'withContext']
];

function namedParam(body: string): keyof RequestVariant | undefined {
  for (const [re, key] of PARAM_HINTS) if (re.test(body)) return key;
  return undefined;
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
 * prompt_tokens_details.audio_tokens，与 DashScope 原生的 input_tokens_details /
 * output_tokens_details / seconds（官方明确原生没有 prompt_tokens 这套名字）。
 * 拿不到就留空 —— 缺数据要看得见，不许填 0 当作已测量。
 */
function parseUsage(payload: unknown): AsrUsage {
  const root = payload as {
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
      seconds?: unknown;
      prompt_tokens_details?: { audio_tokens?: unknown };
      input_tokens_details?: { text_tokens?: unknown; audio_tokens?: unknown };
    };
  } | null;
  const u = root?.usage;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const usage: AsrUsage = {};
  const prompt = num(u?.prompt_tokens) ?? num(u?.input_tokens);
  if (prompt !== undefined) usage.promptTokens = prompt;
  const completion = num(u?.completion_tokens) ?? num(u?.output_tokens);
  if (completion !== undefined) usage.completionTokens = completion;
  const audio = num(u?.prompt_tokens_details?.audio_tokens) ?? num(u?.input_tokens_details?.audio_tokens);
  if (audio !== undefined) usage.audioTokens = audio;
  const text = num(u?.input_tokens_details?.text_tokens);
  if (text !== undefined) usage.textTokens = text;
  const seconds = num(u?.seconds);
  if (seconds !== undefined) usage.seconds = seconds;
  return usage;
}

/**
 * 上下文偏置的反噬：模型会把我们发的参考词表整段当识别结果念出来。
 * chat_audio 与原生协议**都**可能把
 * 「实验室管理领域参考词（中文）：\n器材 投影仪 服务器」原样返回，官方社区也有
 * 同款报告（aliyun/alibabacloud-bailian-speech-demo#50「无故输出全部 corpus」）。
 * 词表首行是我们自己写的标题，说话的人不可能念它 —— 它一出现就说明模型在念提示词，
 * 宁可判"没听清"，也绝不能把 1200 字词表灌进用户的草稿里。
 */
function looksLikeContextEcho(text: string, contextText: string): boolean {
  if (!contextText) return false;
  const head = (contextText.split('\n')[0] ?? '').trim();
  if (head.length < 6) return false; // 标题太短就没有区分度，不配当判据
  return text.includes(head) || text.includes(head.replace(/[：:]\s*$/, ''));
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
  const hotwords = config.protocol === 'dashscope_native' && config.hotwordsEnabled ? input.hotwords ?? {} : {};
  const variant: RequestVariant = {
    withContext: Boolean(contextText),
    withOptions: true,
    withHotwords: Object.keys(hotwords).length > 0,
    withFormat: config.protocol === 'dashscope_native'
  };
  const dropOrder = dropOrderFor(config.protocol);

  const startedAt = Date.now();
  let lastStatus = 0;
  let lastBody = '';
  let degraded = false;

  for (;;) {
    const request = buildRequest(config, input, payload.buffer, variant, contextText, hotwords);
    let dropNext = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(config.timeoutMs) });
        lastStatus = response.status;
        // 先完整读 body 再解析（响应含完整 JSON；截断会让 JSON.parse 假性失败）
        const bodyText = await response.text().catch(() => '');
        if (response.ok) {
          const parsed = safeJson(bodyText);
          const text = config.protocol === 'chat_audio'
            ? textFromChatCompletion(parsed)
            : config.protocol === 'dashscope_native'
              ? parseNativeText(parsed)
              : String((parsed as { text?: unknown }).text ?? '').trim();
          if (!text) {
            return { ok: false, code: 'empty', message: '没有听清，请靠近一点再说一次', status: lastStatus };
          }
          if (looksLikeContextEcho(text, contextText)) {
            return {
              ok: false,
              code: 'empty',
              message: '没有听清，请再说一次（模型把参考词表当成了识别内容，已按未识别处理）',
              status: lastStatus
            };
          }
          return {
            ok: true,
            text,
            model: config.model,
            protocol: config.protocol,
            elapsedMs: Date.now() - startedAt,
            applied: { ...request.applied, degraded },
            usage: parseUsage(parsed)
          };
        }
        lastBody = bodyText.slice(0, 300);
        // 429 是配额/限流，不是"参数不认识"，必须留给同参数的网络重试（保持同一口径）
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          // 只有"像参数不认识"的 4xx 才值得摘一个重发；裸请求仍被拒就是真失败，不再退
          dropNext = looksLikeParameterRejection(response.status, bodyText)
            && dropVariant(variant, dropOrder, namedParam(bodyText));
          break; // 其余 4xx：同参数重试没有意义
        }
      } catch (err) {
        lastBody = err instanceof Error ? err.message : String(err);
        lastStatus = lastStatus || 0;
      }
      if (attempt === 0) await delay(400);
    }
    if (!dropNext) break;
    degraded = true;
  }

  return {
    ok: false,
    code: 'upstream_error',
    message: `识别服务暂不可用（HTTP ${lastStatus || '网络错误'}）${lastBody ? '：' + lastBody : ''}，请稍后重试`,
    status: lastStatus || undefined
  };
}
