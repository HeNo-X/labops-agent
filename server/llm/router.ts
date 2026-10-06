/**
 * 大模型分流（2026-10-05 按负责人要求新增）
 * ============================================================================
 *  规则：**聊天模式**走阿里 DashScope（多模型按顺序 fallback）；
 *        **任务模式（工作模式）**走 Agnes。
 *
 *  · DashScope 与 Agnes 都是 OpenAI 兼容端点，请求体格式一致 →
 *    复用 server/llm/agnes.ts 的同一套客户端，仅覆盖 baseUrl / apiKey / model。
 *  · fallback 语义：链上任何一个模型**在吐出任何内容之前**失败（鉴权/模型不存在/超时/5xx），
 *    就换下一个；**一旦已经开始输出内容就不再换**（否则会把半截回答再答一遍，结果错乱）。
 *  · 未配置时返回空数组 → 上层按既有的 demo 规则引擎兜底，不会静默假装用了大模型。
 */
import { getConfig } from '../config.ts';
import { streamChat, AgnesError, type AgnesStreamEvent, type StreamOptions } from './agnes.ts';
import type { Logger } from '../obs/trace.ts';

export interface LlmProviderSpec {
  /** 提供方标识（用于日志与前端展示的 engine 字段） */
  name: 'dashscope' | 'agnes';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const TASK_ENGINE = 'agnes' as const;
export const CHAT_ENGINE = 'dashscope' as const;

/** 按会话模式给出**按调用顺序**排列的提供方/模型链；未配置返回空数组 */
export function providersForMode(mode: 'chat' | 'task'): LlmProviderSpec[] {
  const c = getConfig();
  if (mode === 'chat') {
    if (!c.dashscope.apiKey) return [];
    return c.dashscope.models.map((model) => ({
      name: CHAT_ENGINE,
      apiKey: c.dashscope.apiKey,
      baseUrl: c.dashscope.baseUrl,
      model
    }));
  }
  if (!c.agnes.apiKey) return [];
  return [{ name: TASK_ENGINE, apiKey: c.agnes.apiKey, baseUrl: c.agnes.baseUrl, model: c.agnes.model }];
}

/** 该模式是否已有可用的大模型（否则上层走规则引擎） */
export function isLlmConfigured(mode: 'chat' | 'task'): boolean {
  return providersForMode(mode).length > 0;
}

/** 该模式对应的 engine 标识（写进 run_started / run_completed，供前端展示） */
export function engineForMode(mode: 'chat' | 'task'): 'dashscope' | 'agnes' | 'demo' {
  const list = providersForMode(mode);
  return list.length ? list[0]!.name : 'demo';
}

/** 该模式**计划**使用的模型（首个）；未配置返回 null。给 run_started 与健康检查用，不含密钥 */
export function modelForMode(mode: 'chat' | 'task'): string | null {
  return providersForMode(mode)[0]?.model ?? null;
}

/** 分模式的模型清单（模型 id，不含密钥）—— /api/agent/health 暴露给运维核对分流是否生效 */
export function modelPlan(): { chat: string[]; task: string[] } {
  return {
    chat: providersForMode('chat').map((p) => p.model),
    task: providersForMode('task').map((p) => p.model)
  };
}

/**
 * 带 fallback 的流式调用。
 * ⚠️ 只在"尚未输出任何内容"时换模型；已输出则原样抛出，避免重复回答。
 *
 * `onAttempt` 在每次真正发起请求前回调 —— 上层据此知道自己实际用的是哪个提供方/模型
 * （fallback 发生后会被下一次覆盖，因此它反映的是"最终真正产出这次回答的那个"）。
 */
export async function* streamChatWithFallback(
  opts: StreamOptions,
  mode: 'chat' | 'task',
  log?: Logger,
  onAttempt?: (spec: LlmProviderSpec) => void
): AsyncGenerator<AgnesStreamEvent> {
  const list = providersForMode(mode);
  if (!list.length) {
    throw new AgnesError(
      'llm_not_configured',
      mode === 'chat'
        ? '未配置 DASHSCOPE_API_KEY，聊天模式无法调用大模型。'
        : '未配置 AGNES_API_KEY，任务模式无法调用大模型。',
      null,
      false
    );
  }

  let lastError: unknown = null;
  for (let i = 0; i < list.length; i += 1) {
    const provider = list[i]!;
    onAttempt?.(provider);
    let emitted = false;
    try {
      for await (const ev of streamChat({ ...opts, provider }, log)) {
        emitted = true;
        yield ev;
      }
      return;
    } catch (err) {
      lastError = err;
      if (emitted) throw err; // 已经吐过内容 → 不换模型，直接把错误抛给上层
      log?.warn('llm_provider_failed', {
        mode,
        provider: provider.name,
        model: provider.model,
        attempt: i + 1,
        of: list.length,
        error: (err as Error)?.message ?? String(err)
      });
    }
  }
  throw lastError ?? new AgnesError('llm_unavailable', '大模型链上全部模型均不可用。', null, true);
}
