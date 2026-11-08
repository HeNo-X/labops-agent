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
import { selectableProviders, recordFailure, recordSuccess, circuitStatus } from './circuit.ts';
import { streamChat, AgnesError, type AgnesStreamEvent, type StreamOptions } from './agnes.ts';
import type { Logger } from '../obs/trace.ts';

/** 提供方标识。`dashscope/agnes` 是主链，`bigmodel/xfyun` 是 2026-10-31 新增的备用链。 */
export type ProviderName = 'dashscope' | 'agnes' | 'bigmodel' | 'xfyun';

export interface LlmProviderSpec {
  /** 提供方标识（用于日志与前端展示的 engine 字段） */
  name: ProviderName;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const TASK_ENGINE = 'agnes' as const;
export const CHAT_ENGINE = 'dashscope' as const;

/** 备用链的构造（两处共用）：只有配了 Key 的提供方才入链，不留空壳 */
function fallbackSpecs(role: 'chat' | 'task'): LlmProviderSpec[] {
  const c = getConfig();
  const big: LlmProviderSpec[] = c.bigmodel.apiKey
    ? [{ name: 'bigmodel', apiKey: c.bigmodel.apiKey, baseUrl: c.bigmodel.baseUrl, model: c.bigmodel.model }]
    : [];
  const spark = (model: string): LlmProviderSpec[] =>
    c.xfyun.apiKey ? [{ name: 'xfyun', apiKey: c.xfyun.apiKey, baseUrl: c.xfyun.baseUrl, model }] : [];
  // 去重：任务链里 spark(taskModel) 与 spark(chatModel) 可能是同一个模型
  // （现实里常见——比如 4b 那个没额度、两个槽位都指向同一个可用模型），
  // 不去重就会对同一个端点连续打两次，白白多消耗一次失败/一次配额。
  const merged = role === 'chat' ? [...big, ...spark(c.xfyun.chatModel)] : [...spark(c.xfyun.taskModel), ...big, ...spark(c.xfyun.chatModel)];
  const seen = new Set<string>();
  return merged.filter((p) => {
    const key = `${p.baseUrl}::${p.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 按会话模式给出**按调用顺序**排列的提供方/模型链；未配置返回空数组。
 *
 * 2026-10-31 起是"主链 + 备用链"：
 *   chat：DashScope 五模型 → BigModel(glm-4.7-flash) → 星火(spark-x2.6-4b)
 *   task：Agnes → 星火(spark-x2.6，第一备用) → BigModel → 星火(spark-x2.6-4b)
 * 两条链仍然**互不串用**：chat 链里永远不会出现 agnes，task 链的第一位永远是 agnes（配了 Key 时）。
 */
export function providersForMode(mode: 'chat' | 'task'): LlmProviderSpec[] {
  const c = getConfig();
  if (mode === 'chat') {
    const primary = c.dashscope.apiKey
      ? c.dashscope.models.map((model) => ({
          name: CHAT_ENGINE as ProviderName,
          apiKey: c.dashscope.apiKey,
          baseUrl: c.dashscope.baseUrl,
          model
        }))
      : [];
    return [...primary, ...fallbackSpecs('chat')];
  }
  const primary: LlmProviderSpec[] = c.agnes.apiKey
    ? [{ name: TASK_ENGINE, apiKey: c.agnes.apiKey, baseUrl: c.agnes.baseUrl, model: c.agnes.model }]
    : [];
  return [...primary, ...fallbackSpecs('task')];
}

/** 该模式是否已有可用的大模型（否则上层走规则引擎） */
export function isLlmConfigured(mode: 'chat' | 'task'): boolean {
  return providersForMode(mode).length > 0;
}

/**
 * 该模式对应的 engine 标识（写进 run_started / run_completed，供前端展示）。
 * ⚠️ 备用链里的 bigmodel / xfyun 统一归到 `dashscope` 这一"OpenAI 兼容端点族"——
 *    engine 只是粗粒度归类，**用户看到的是 model 字段**（真实模型 id），
 *    这样不必为了两个备用提供方去改前后端的 EngineType 联合类型。
 */
export function engineForMode(mode: 'chat' | 'task'): 'dashscope' | 'agnes' | 'demo' {
  const list = providersForMode(mode);
  if (!list.length) return 'demo';
  return list[0]!.name === 'agnes' ? 'agnes' : 'dashscope';
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
  onAttempt?: (spec: LlmProviderSpec) => void,
  /** 方案B 多模型重答：从链上第 N 个模型开始（跳过前面已试错/答偏的） */
  startIndex = 0
): AsyncGenerator<AgnesStreamEvent> {
  const list = providersForMode(mode).slice(Math.max(0, startIndex));
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

  // 冷却中的模型直接跳过；全链都在冷却时按原链放行（熔断不得成为新的不可用来源）
  const { ready, skipped, allCooling } = selectableProviders(list);
  if (skipped.length) {
    log?.warn('llm_circuit_skip', { mode, skipped, allCooling });
  }

  let lastError: unknown = null;
  for (let i = 0; i < ready.length; i += 1) {
    const provider = ready[i]!;
    onAttempt?.(provider);
    let emitted = false;
    try {
      for await (const ev of streamChat({ ...opts, provider }, log)) {
        emitted = true;
        yield ev;
      }
      recordSuccess(provider);
      return;
    } catch (err) {
      lastError = err;
      // 用户取消不是模型故障：既不记熔断，也不该继续把链上其余模型逐个"试一遍"
      // （signal 已 abort，后面每个都会秒抛秒记账，取消 3 次就能把健康模型冷却掉）
      if (opts.signal?.aborted || (err as AgnesError)?.code === 'run_cancelled') throw err;
      if (emitted) {
        // 已经吐过内容 → 不换模型，直接把错误抛给上层；
        // 也**不记熔断**：中途断流多半与本次回答有关，不该让该模型替后续所有请求背锅
        throw err;
      }
      // A6：账号级配额/额度耗尽对链上**所有**模型同样生效——逐个换模型只会
      // 白烧一遍（2026-10-30 实测 7 个模型全 403 AllocationQuota.FreeTierOnly）。
      // 短路整条链并如实上报；记一次熔断让 /health 能看到该模型不可用。
      if ((err as AgnesError)?.code === 'agnes_quota_exhausted') {
        recordFailure(provider);
        log?.warn('llm_quota_exhausted', { mode, provider: provider.name, model: provider.model });
        throw err;
      }
      recordFailure(provider);
      log?.warn('llm_provider_failed', {
        mode,
        provider: provider.name,
        model: provider.model,
        attempt: i + 1,
        of: ready.length,
        error: (err as Error)?.message ?? String(err)
      });
    }
  }
  throw lastError ?? new AgnesError('llm_unavailable', '大模型链上模型均不可用。', null, true);
}

/** 熔断现状（不含密钥）—— 供 /api/agent/health 与界面提示"某模型暂时跳过" */
export function circuitHealth(mode: 'chat' | 'task') {
  return { mode, providers: circuitStatus(providersForMode(mode)) };
}
