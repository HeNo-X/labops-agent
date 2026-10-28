import { getConfig, type AppConfig } from '../config.ts';
import type { Logger } from '../obs/trace.ts';

/**
 * 视觉理解通道（多模态证据）。
 *
 * 与任务/聊天两条主链路**完全分开**：主链路模型不接图，图只走这一条受控通道，
 * 且只产出**结构化观察**而非自由文本。原因是自由文本的视觉描述会诱导模型把
 * "看起来像"当成"已确认"，进而写进工单或验收结论。
 *
 * 未配置 Key 时直接抛错，由工具层如实转述"视觉未启用"——
 * 绝不用规则引擎伪造一份看图结果（与 run.ts 的诚实降级同一条纪律）。
 */

export interface StructuredObservation {
  deviceType: string;
  visibleSymptoms: string[];
  nameplateText: string;
  severityGuess: 'unknown' | 'minor' | 'moderate' | 'severe';
  confidence: number;
  whatNotVisible: string[];
}

export interface VisionImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;
}

export class VisionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.retryable = retryable;
  }
}

const SEVERITIES = ['unknown', 'minor', 'moderate', 'severe'] as const;

const SYSTEM_PROMPT = `你是实验室设备照片的**初判观察员**，不是维修结论的出具人。
只报告画面中**确实可见**的事实，不推断故障原因、不推测维修方案、不判断是否已修复。
铭牌文字只转录你能清楚看到的字符，看不清就写"未识别"，绝不补全或猜测型号。
画面里没有的东西必须列入 whatNotVisible（例如"看不到电源指示灯状态""看不到铭牌"）。
只输出一个 JSON 对象，不要 Markdown 代码块、不要解释文字。字段：
{"deviceType":"设备类型或 unknown","visibleSymptoms":["可见征象"],"nameplateText":"铭牌可见文字或 未识别","severityGuess":"unknown|minor|moderate|severe","confidence":0到1的小数,"whatNotVisible":["画面无法确认的事项"]}`;

/** 只允许 HTTPS 出口；本地回环例外。VISION_BASE_URL 可由环境配置，不校验就成了带 Key 的 SSRF 出口 */
export function assertSafeEndpoint(url: URL): void {
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new VisionError('vision_endpoint_unsafe', '视觉服务地址必须使用 HTTPS', false);
  if (url.username || url.password || url.search || url.hash) throw new VisionError('vision_endpoint_unsafe', '视觉服务地址无效', false);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** 模型偶尔会包一层 ```json；取第一个 { 到最后一个 } 之间，再失败则退回原文 */
function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* 继续试切片 */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new VisionError('vision_bad_json', '视觉模型未返回可解析的结构化观察', true);
    }
  }
  throw new VisionError('vision_bad_json', '视觉模型未返回可解析的结构化观察', true);
}

function normalize(raw: unknown): StructuredObservation {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()).slice(0, 12) : [];
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const guess = text(o.severityGuess, 16).toLowerCase();
  return {
    deviceType: text(o.deviceType, 80) || 'unknown',
    visibleSymptoms: list(o.visibleSymptoms),
    nameplateText: text(o.nameplateText, 300) || '未识别',
    severityGuess: (SEVERITIES as readonly string[]).includes(guess) ? (guess as StructuredObservation['severityGuess']) : 'unknown',
    confidence: clampNumber(o.confidence, 0, 1, 0),
    whatNotVisible: list(o.whatNotVisible)
  };
}

export function isVisionConfigured(): boolean {
  return getConfig().vision.apiKey !== '';
}

/** 仅给启动日志与 /api/agent/health 用，绝不返回 Key */
export function visionStatus(): { configured: boolean; model: string; baseUrl: string } {
  const { apiKey, model, baseUrl } = getConfig().vision;
  return { configured: apiKey !== '', model, baseUrl };
}

export async function analyzeImages(
  images: VisionImage[],
  focus: string,
  log?: Logger,
  /** 仅供测试注入替身配置；生产路径不传，走服务端缓存配置 */
  override?: Partial<Pick<AppConfig['vision'], 'apiKey' | 'model' | 'baseUrl' | 'timeoutMs'>>
): Promise<{ observation: StructuredObservation; model: string; ms: number }> {
  const c = { ...getConfig().vision, ...(override ?? {}) };
  if (!c.apiKey) throw new VisionError('vision_not_configured', '未配置视觉模型 Key，无法理解照片内容', false);
  if (!images.length) throw new VisionError('vision_no_image', '没有可分析的图像', false);
  if (images.length > c.maxImages) throw new VisionError('vision_too_many_images', `单次最多分析 ${c.maxImages} 张照片`, false);

  const endpoint = new URL('/chat/completions', c.baseUrl + '/');
  assertSafeEndpoint(endpoint);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `关注点：${focus || '设备当前可见状态'}。请按要求只输出 JSON。` },
              ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.dataBase64}` } }))
            ]
          }
        ]
      }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!res.ok) {
      throw new VisionError('vision_upstream', `视觉服务返回 ${res.status}`, res.status >= 500 || res.status === 429);
    }
    const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content ?? '';
    const observation = normalize(extractJson(text));
    log?.info?.('vision_analyzed', {
      model: c.model,
      images: images.length,
      ms: Date.now() - startedAt,
      symptoms: observation.visibleSymptoms.length,
      confidence: observation.confidence
    });
    return { observation, model: c.model, ms: Date.now() - startedAt };
  } catch (e) {
    if (e instanceof VisionError) throw e;
    const aborted = (e as Error).name === 'AbortError';
    throw new VisionError(aborted ? 'vision_timeout' : 'vision_unavailable', aborted ? '视觉分析超时' : '视觉服务不可用', true);
  } finally {
    clearTimeout(timer);
  }
}
