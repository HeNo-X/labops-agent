/**
 * Agnes 3.0 Flash 适配器 —— 独立一层，可整体替换
 * ============================================================================
 *  接口事实（已核对官方文档 agnes-ai.com/zh-Hans/docs/agnes-30-flash，非凭记忆）：
 *    Base URL          https://api.agnes-ai.cn/v1
 *                      （⚠️ 2026-09-28 实测：旧写的 apihub.agnes-ai.com 对本项目 Key 返回 401，
 *                        正确的端点是 api.agnes-ai.cn；改前先用 /v1/models 验一次）
 *    Chat Completions  POST /v1/chat/completions   （OpenAI 兼容结构）
 *    模型名称          agnes-3.0-flash
 *    请求字段          model / messages / temperature / top_p / max_tokens
 *                      / stream / tools / tool_choice / chat_template_kwargs
 *    响应结构          choices[].message.{content, tool_calls}，usage.{prompt_tokens,...}
 *    上下文 512K，最大输出 65,536 Token
 *  官方明确写了：执行完工具后要把工具结果追加回 messages，再发起下一次请求。
 *
 *  C4 要求落在这里：显式超时数值 + 重试（次数/指数退避/抖动）+ 失败降级路径。
 *  C6 要求落在这里：API Key 只在服务端内存里，不进日志、不进响应。
 *
 *  ⚠️ 重试边界：只在**尚未产生任何输出**时重试。流一旦开始吐字就不再重试，
 *     否则会把重复内容拼进回答里（这是流式最容易翻的车）。
 */

import { setTimeout as delay } from 'node:timers/promises';
import { getConfig } from '../config.ts';
import { loggerFor } from '../obs/trace.ts';
import type { Logger } from '../obs/trace.ts';
import type { ToolSpec } from '../../shared/types.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AgnesStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; finishReason: string };

export class AgnesError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  /** A10：出错的是哪条链（dashscope=聊天 / agnes=任务）。错误文案与修复提示都按它区分，聊天模式不得出现"Agnes"字样 */
  provider?: string;
  constructor(code: string, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'AgnesError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** A10：用户可见的供应商称谓——错误消息里必须说清是哪条链出问题 */
export function providerLabel(name?: string): string {
  return name === 'dashscope' ? '聊天模型（DashScope）' : name === 'agnes' ? '工作模型（Agnes）' : '大模型';
}

/**
 * A6 配额感知（2026-10-30 部署实测教训）：账号级配额/额度耗尽（403 +
 * AllocationQuota.FreeTierOnly 等）与"鉴权失败"是两回事 —— 密钥是好的，
 * 重试与换模型都不会自愈，提示必须指路充值/调整配额模式，而不是让用户
 * 去检查 KEY。签名覆盖实测案例与两家供应商的常见措辞。
 */
const QUOTA_BODY_RE = /AllocationQuota|FreeTierOnly|Arrearage|quota[_. ]?(exhaust|exceed|used[_ ]?up)|insufficient[_. ]?quota|欠费|额度已?用?(尽|完)/i;

/** 纯函数判定（供 classify 与单测共用） */
export function isQuotaExhaustedResponse(status: number, body: string): boolean {
  return status === 403 && QUOTA_BODY_RE.test(body);
}

function classify(status: number, body: string, provider?: { name: string; model: string }): AgnesError {
  const snippet = body.slice(0, 400);
  const label = providerLabel(provider?.name);
  const keyName = provider?.name === 'dashscope' ? 'DASHSCOPE_API_KEY' : 'AGNES_API_KEY';
  if (isQuotaExhaustedResponse(status, body)) {
    return new AgnesError('agnes_quota_exhausted', `${label}账号配额/额度已用尽（HTTP 403）。这不是网络或密钥问题。${snippet}`, status, false);
  }
  if (status === 401 || status === 403) {
    return new AgnesError('agnes_auth_failed', `${label}鉴权失败（HTTP ${status}）：请检查 ${keyName} 是否有效。${snippet}`, status, false);
  }
  if (status === 404) {
    return new AgnesError('agnes_model_not_found', `${label} 返回 404：模型名或 Base URL 可能不对（当前模型 ${provider?.model ?? getConfig().agnes.model}）。${snippet}`, status, false);
  }
  if (status === 400 || status === 422) {
    return new AgnesError('agnes_bad_request', `${label}拒绝了请求（HTTP ${status}）：请求参数不符合接口要求。${snippet}`, status, false);
  }
  if (status === 429) {
    return new AgnesError('agnes_rate_limited', `${label}限流（HTTP 429）。${snippet}`, status, true);
  }
  if (status >= 500) {
    return new AgnesError('agnes_upstream_error', `${label}服务端错误（HTTP ${status}）。${snippet}`, status, true);
  }
  return new AgnesError('agnes_http_error', `${label}返回未预期的状态码 ${status}。${snippet}`, status, false);
}

/**
 * 从上游 400 正文里认出"这个模型不支持某个采样参数"，返回参数名。
 *
 * 真实案例（2026-10-31，kimi-k3 走百炼兼容端点）：
 *   HTTP 400 InternalError.Algo.InvalidParameter:
 *   Parameter 'temperature'=0.3 is not supported for kimi-k3 model.
 * 若照原样抛错，模型链会把它当成"这个模型坏了"直接跳过 —— 实际上只差一个参数。
 *
 * 只允许降级**采样类**参数：tools / tool_choice / messages 一律不碰，
 * 那几个被删掉是功能缺失（工具调用会直接失效），不能"顺手"降级。
 */
const DEGRADABLE_PARAMS = new Set([
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'seed',
  'stop',
  'chat_template_kwargs',
  'enable_thinking'
]);

export function unsupportedParam(body: string): string | null {
  const patterns = [
    /Parameter\s+'([A-Za-z0-9_]+)'\s*=/i,
    /[Uu]nsupported\s+parameter[:\s]+'?([A-Za-z0-9_]+)'?/,
    /[Uu]nknown\s+parameter[:\s]+'?([A-Za-z0-9_]+)'?/,
    /'([A-Za-z0-9_]+)'\s+is\s+not\s+supported/i
  ];
  for (const re of patterns) {
    const m = re.exec(body);
    const name = m?.[1];
    if (name && DEGRADABLE_PARAMS.has(name)) return name;
  }
  return null;
}

export interface StreamOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  /**
   * 可选：覆盖默认（Agnes）的调用目标 —— 由 server/llm/router.ts 按会话模式注入。
   * 其余参数（超时/重试/maxTokens/温度）仍沿用 AGNES_* 的统一配置，避免两套口径。
   */
  provider?: { name: string; apiKey: string; baseUrl: string; model: string };
}

export function isAgnesConfigured(): boolean {
  return getConfig().agnes.apiKey.length > 0;
}

/** 仅暴露给启动日志与 /api/agent/health 用，绝不返回 Key 本身 */
export function agnesStatus(): { configured: boolean; model: string; baseUrl: string } {
  const c = getConfig().agnes;
  return { configured: isAgnesConfigured(), model: c.model, baseUrl: c.baseUrl };
}

/**
 * 流式对话。产出 text 增量、tool_calls（累积完成后一次性给）、usage、done。
 * 抛出的 AgnesError 的 code 会被上层直接映射成 run_failed.code，不做二次包装。
 */
export async function* streamChat(opts: StreamOptions, log?: Logger): AsyncGenerator<AgnesStreamEvent> {
  const base = getConfig().agnes;
  // provider 由 router 按会话模式注入（聊天模式=DashScope / 任务模式=Agnes）；
  // 未注入时行为与改造前完全一致（默认 Agnes），保证任务模式零变化。
  const c = opts.provider
    ? { ...base, apiKey: opts.provider.apiKey, baseUrl: opts.provider.baseUrl, model: opts.provider.model }
    : base;
  if (!c.apiKey) {
    const e = new AgnesError(
      'agnes_not_configured',
      `未配置${providerLabel(opts.provider?.name)}的 API Key（${opts.provider?.name === 'dashscope' ? 'DASHSCOPE_API_KEY' : 'AGNES_API_KEY'}），无法调用。`,
      null,
      false
    );
    e.provider = opts.provider?.name ?? 'agnes';
    throw e;
  }

  const url = `${c.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: c.model,
    messages: opts.messages,
    stream: true,
    temperature: c.temperature,
    max_tokens: c.maxTokens
  };
  if (opts.tools && opts.tools.length) {
    body['tools'] = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    // 第一阶段只有 1 个工具，用 auto 让模型自己决定要不要查；强制 required 会在
    // 寒暄类问题上逼它乱调工具，反而更糟。
    body['tool_choice'] = 'auto';
  }
  // Thinking 默认关闭：第一阶段不展示内部推理，且思考 token 会挤占正文预算
  if (c.enableThinking) body['chat_template_kwargs'] = { enable_thinking: true };

  let payload = JSON.stringify(body);
  const logger = log ?? loggerFor('agnes');
  /** 已经因为"该模型不支持"而摘掉的参数（每个参数只摘一次，摘满 3 个就认命报错） */
  const degraded = new Set<string>();

  let lastError: AgnesError | null = null;
  for (let attempt = 0; attempt <= c.maxRetries; attempt++) {
    const ac = new AbortController();
    const onOuterAbort = (): void => ac.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (opts.signal?.aborted) ac.abort();
    const timer = setTimeout(() => ac.abort(), c.timeoutMs);

    let started = false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`
        },
        body: payload,
        signal: ac.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 该模型不认某个采样参数（如 kimi-k3 不认 temperature）→ 摘掉该参数重发，
        // 而不是把整个模型判死换下一个。这是"适配"，不该被 router 记成一次故障。
        const bad = unsupportedParam(text);
        if (bad && bad in body && !degraded.has(bad) && degraded.size < 3) {
          degraded.add(bad);
          delete body[bad];
          payload = JSON.stringify(body);
          logger.warn('llm_param_degraded', {
            model: c.model,
            param: bad,
            status: res.status,
            reason: '上游明确声明该模型不支持此参数，已摘掉后重发（不换模型、不记熔断）'
          });
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onOuterAbort);
          attempt -= 1; // 抵消本轮 for 自增：降级重发不计入重试次数
          continue;
        }
        // A10：错误消息与 provider 标注按实际调用链（聊天=DashScope / 任务=Agnes）
        const e = classify(res.status, text, { name: opts.provider?.name ?? 'agnes', model: c.model });
        e.provider = opts.provider?.name ?? 'agnes';
        throw e;
      }
      if (!res.body) {
        const e = new AgnesError('agnes_empty_body', `${providerLabel(opts.provider?.name)}返回了空响应体，无法流式读取。`, res.status, true);
        e.provider = opts.provider?.name ?? 'agnes';
        throw e;
      }

      started = true;
      yield* parseSseStream(res.body, ac.signal);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
      return;
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);

      const aborted = ac.signal.aborted;
      const outerAborted = Boolean(opts.signal?.aborted);
      let e: AgnesError;
      if (err instanceof AgnesError) {
        e = err;
      } else if (outerAborted) {
        e = new AgnesError('run_cancelled', '任务已被取消。', null, false);
      } else if (aborted) {
        e = new AgnesError('agnes_timeout', `${providerLabel(opts.provider?.name)}调用超时（>${c.timeoutMs} ms）。`, null, true);
      } else {
        e = new AgnesError('agnes_network_error', `${providerLabel(opts.provider?.name)}网络错误：${(err as Error).message}`, null, true);
      }
      e.provider = opts.provider?.name ?? 'agnes';

      lastError = e;
      const canRetry = e.retryable && !started && !outerAborted && attempt < c.maxRetries;
      logger.warn('agnes_attempt_failed', {
        attempt: attempt + 1,
        of: c.maxRetries + 1,
        code: e.code,
        status: e.status,
        started,
        willRetry: canRetry
      });
      if (!canRetry) throw e;

      // 指数退避 + 抖动
      const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await delay(backoff, undefined, {signal:opts.signal});
    }
  }
  throw lastError ?? new AgnesError('agnes_unknown', 'Agnes 调用失败（无更多信息）。', null, false);
}

/**
 * 解析 OpenAI 兼容的 SSE 流。
 * 用 TextDecoder({stream:true}) 增量解码 —— 中文 UTF-8 会被任意切断，逐块 toString()
 * 一定出乱码（难点 6 第 3 条）。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<AgnesStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  /** tool_calls 在流式里是分片到达的，必须按 index 累积后再一次性交给上层 */
  const partialCalls = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | null = null;
  let sawDone = false;
  let usage: TokenUsage | null = null;

  try {
    while (true) {
      if (signal.aborted) throw new AgnesError('run_cancelled', '任务已被取消。', null, false);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { sawDone = true; break; }

        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          throw new AgnesError('invalid_stream','模型响应含损坏的数据片段',null,false);
        }

        if (json['error']) throw new AgnesError('upstream_stream_error','模型流返回错误',null,false);
        const choices = (json['choices'] as Record<string, unknown>[]) ?? [];
        const choice = choices[0];
        if (choice) {
          const fr = choice['finish_reason'];
          if (typeof fr === 'string' && fr) finishReason = fr;
          const delta = (choice['delta'] ?? {}) as Record<string, unknown>;

          const text = delta['content'];
          if (typeof text === 'string' && text) yield { type: 'text', text };

          const tc = delta['tool_calls'];
          if (Array.isArray(tc)) {
            for (const raw of tc as Record<string, unknown>[]) {
              const i = Number(raw['index'] ?? 0);
              const cur = partialCalls.get(i) ?? { id: '', name: '', args: '' };
              if (typeof raw['id'] === 'string' && raw['id']) cur.id = raw['id'];
              const fn = (raw['function'] ?? {}) as Record<string, unknown>;
              if (typeof fn['name'] === 'string' && fn['name']) cur.name += fn['name'];
              if (typeof fn['arguments'] === 'string') cur.args += fn['arguments'];
              partialCalls.set(i, cur);
            }
          }
        }

        const u = json['usage'] as Record<string, unknown> | undefined;
        if (u) {
          usage = {
            promptTokens: Number(u['prompt_tokens'] ?? 0),
            completionTokens: Number(u['completion_tokens'] ?? 0),
            totalTokens: Number(u['total_tokens'] ?? 0)
          };
        }
      }
      if (sawDone) break;
    }
    if (!sawDone || !finishReason) throw new AgnesError('incomplete_stream','模型响应断流，未取得完整结束标记',null,false);
    if (finishReason !== 'stop' && finishReason !== 'tool_calls') throw new AgnesError('truncated_response',`模型响应未正常完成（${finishReason}）`,null,false);
    if (partialCalls.size && finishReason !== 'tool_calls') throw new AgnesError('incomplete_tool_call','模型工具调用未完成',null,false);

    // 流结束：一次性交付完整工具调用
    if (partialCalls.size) {
      const calls: ToolCall[] = [...partialCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v], i) => ({
          id: v.id || `call_${i}`,
          type: 'function' as const,
          function: { name: v.name, arguments: v.args || '{}' }
        }));
      yield { type: 'tool_calls', calls };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', finishReason };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
  }
}
