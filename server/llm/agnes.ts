/**
 * Agnes 3.0 Flash 适配器 —— 独立一层，可整体替换
 * ============================================================================
 *  接口事实（已核对官方文档 agnes-ai.com/zh-Hans/docs/agnes-30-flash，非凭记忆）：
 *    Base URL          https://apihub.agnes-ai.com/v1
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
  constructor(code: string, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'AgnesError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function classify(status: number, body: string): AgnesError {
  const snippet = body.slice(0, 400);
  if (status === 401 || status === 403) {
    return new AgnesError('agnes_auth_failed', `Agnes 鉴权失败（HTTP ${status}）：请检查 AGNES_API_KEY 是否有效。${snippet}`, status, false);
  }
  if (status === 404) {
    return new AgnesError('agnes_model_not_found', `Agnes 返回 404：模型名或 Base URL 可能不对（当前模型 ${getConfig().agnes.model}）。${snippet}`, status, false);
  }
  if (status === 400 || status === 422) {
    return new AgnesError('agnes_bad_request', `Agnes 拒绝了请求（HTTP ${status}）：请求参数不符合接口要求。${snippet}`, status, false);
  }
  if (status === 429) {
    return new AgnesError('agnes_rate_limited', `Agnes 限流（HTTP 429）。${snippet}`, status, true);
  }
  if (status >= 500) {
    return new AgnesError('agnes_upstream_error', `Agnes 服务端错误（HTTP ${status}）。${snippet}`, status, true);
  }
  return new AgnesError('agnes_http_error', `Agnes 返回未预期的状态码 ${status}。${snippet}`, status, false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface StreamOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
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
  const c = getConfig().agnes;
  if (!c.apiKey) {
    throw new AgnesError('agnes_not_configured', '未配置 AGNES_API_KEY，无法调用 Agnes。', null, false);
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

  const payload = JSON.stringify(body);
  const logger = log ?? loggerFor('agnes');

  let lastError: AgnesError | null = null;
  for (let attempt = 0; attempt <= c.maxRetries; attempt++) {
    const ac = new AbortController();
    const onOuterAbort = (): void => ac.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
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
        throw classify(res.status, text);
      }
      if (!res.body) {
        throw new AgnesError('agnes_empty_body', 'Agnes 返回了空响应体，无法流式读取。', res.status, true);
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
        e = new AgnesError('agnes_timeout', `调用 Agnes 超时（>${c.timeoutMs} ms）。`, null, true);
      } else {
        e = new AgnesError('agnes_network_error', `调用 Agnes 时发生网络错误：${(err as Error).message}`, null, true);
      }

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
      await sleep(backoff);
    }
  }
  throw lastError ?? new AgnesError('agnes_unknown', 'Agnes 调用失败（无更多信息）。', null, false);
}

/**
 * 解析 OpenAI 兼容的 SSE 流。
 * 用 TextDecoder({stream:true}) 增量解码 —— 中文 UTF-8 会被任意切断，逐块 toString()
 * 一定出乱码（难点 6 第 3 条）。
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<AgnesStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  /** tool_calls 在流式里是分片到达的，必须按 index 累积后再一次性交给上层 */
  const partialCalls = new Map<number, { id: string; name: string; args: string }>();
  let finishReason = 'stop';
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
        if (!data || data === '[DONE]') continue;

        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          // 单个分片坏掉不该毁掉整个回答，记一条继续（这里没有 logger，交给上层统计）
          continue;
        }

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
    }

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
    reader.releaseLock?.();
  }
}
