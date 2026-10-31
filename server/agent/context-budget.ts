/**
 * 上下文预算在 Agent 侧的落地：估算 → 决策 → 按优先级确定性精简
 * ============================================================================
 *  精简优先级（只在超阈值时执行，绝不预先删东西）：
 *    ① 最旧的工具结果全文（保留 summary 短句，丢弃大块结构化内容）
 *    ② 更早的历史事实（system 里的 authorizedHistoricalFacts）
 *    ③ 保留 system + 最近 N 轮 + 当前问
 *  **永不精简**：权限作用域、已确认提案的 scopeKey/version、服务端时间基准 ——
 *  这些是"事实与权限"，剪掉会让模型拿旧授权作答。
 */
import type { ChatMessage } from '../llm/agnes.ts';
// ⚠️ 服务端一律用**相对路径**引用 shared：Node 直接跑 TS 时没有 @shared 别名
//    （web 侧的打包器才有），用别名会让所有加载本文件的测试在 import 阶段崩掉。
import { decideContextBudget, estimateTokens, type BudgetDecision, type TrimmedCounts } from '../../shared/context-budget.ts';

export interface BudgetConfig {
  enabled: boolean;
  window: number;
  outputReserve: number;
  circuitBreakerAfter: number;
  thresholdRatio: number;
}

/** 工具结果消息的识别：loop 里以 role:'tool' push 的消息 */
function isToolMessage(m: ChatMessage): boolean {
  return m.role === 'tool';
}

export interface BudgetApplyResult {
  messages: ChatMessage[];
  decision: BudgetDecision;
}

/** 单条工具结果瘦身：只保留前若干字符（那是模型真正需要的结论段） */
const TOOL_RESULT_KEEP_CHARS = 1200;
/**
 * A3 结构感知窗口（借鉴 SWE-agent ACI 的 observation windowing）：
 * 数组字段截到前 TOOL_ARRAY_WINDOW 项，并用 dataNote 如实告知
 * 「共几条、省了几条、下一步怎么拿」——绝不在记录中间盲切（旧实现会把
 * JSON 腰斩成残缺记录，模型既看不到总数，也不知道数据被切过）。
 */
const TOOL_ARRAY_WINDOW = 8;

/** 解析工具消息正文；非 JSON 对象返回 null（调用方回退到字符截断） */
function parseToolContent(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string') return null;
  try {
    const v = JSON.parse(content) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 递归开窗：超长数组截前 TOOL_ARRAY_WINDOW 项，路径与省略量记入 notes；depth 限 2 层 */
function windowArrays(value: unknown, path: string, depth: number, notes: string[]): unknown {
  if (Array.isArray(value)) {
    if (value.length > TOOL_ARRAY_WINDOW) {
      notes.push(`${path}（共 ${value.length} 条，已省略 ${value.length - TOOL_ARRAY_WINDOW} 条）`);
      return value.slice(0, TOOL_ARRAY_WINDOW);
    }
    return value;
  }
  if (value && typeof value === 'object' && depth > 0) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = windowArrays(v, `${path}.${k}`, depth - 1, notes);
    }
    return out;
  }
  return value;
}

export function slimToolMessage(m: ChatMessage): ChatMessage {
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  if (content.length <= TOOL_RESULT_KEEP_CHARS) return m;

  const parsed = parseToolContent(m.content);
  // A4（借鉴 Manus「keep the wrong stuff in」）：失败消息**豁免瘦身**——
  // code/message/suggestions/instruction 是模型换路与如实交代的依据，
  // 砍掉它等于把模型的学习信号剪掉；失败消息本来就小，不构成预算压力。
  if (parsed && parsed['ok'] === false) return m;
  if (!parsed) {
    // 回退旧行为：非 JSON 内容只能按字符截断，但必须如实标注
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id,
      content: `${content.slice(0, TOOL_RESULT_KEEP_CHARS)}…[已精简：原始长度 ${content.length} 字，完整依据见工具结果卡]`
    };
  }

  const notes: string[] = [];
  const next: Record<string, unknown> = { ...parsed, data: windowArrays(parsed['data'], 'data', 2, notes) };
  if (notes.length) {
    next['dataNote'] = `结果较大已开窗：${notes.join('；')}。如需更多请缩小查询范围（更具体的房间/日期/类型）后重新查询。`;
  }
  let out = JSON.stringify(next);
  if (out.length > TOOL_RESULT_KEEP_CHARS) {
    // 开窗后仍超长（例如巨大的字符串字段）→ 才按字符截断兜底
    out = `${out.slice(0, TOOL_RESULT_KEEP_CHARS)}…[已精简：原始长度 ${content.length} 字，完整依据见工具结果卡]`;
  }
  return { role: 'tool', tool_call_id: m.tool_call_id, content: out };
}

/**
 * 在**每次调用模型前**执行。返回新的 messages 数组与决策对象；
 * 决策对象必须能被上层原样带进 run_completed 供界面展示，不允许再加工。
 */
export function applyContextBudget(
  messages: ChatMessage[],
  cfg: BudgetConfig,
  failures: { consecutive: number }
): BudgetApplyResult {
  const total = messages.reduce((n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);

  const provisional = decideContextBudget({
    enabled: cfg.enabled,
    contextWindow: cfg.window,
    outputReserveTokens: cfg.outputReserve,
    thresholdRatio: cfg.thresholdRatio,
    estimatedTokens: total,
    historyTurns: 0,
    consecutiveFailures: failures.consecutive,
    circuitBreakerAfter: cfg.circuitBreakerAfter
  });

  if (!provisional.shouldTrim) {
    // 达到熔断且确实超阈值时计一次失败，供下次决策参考（由调用方累加）
    return { messages, decision: provisional };
  }

  // ---- ① 最旧的工具结果先瘦身（保留 system 与 user/assistant 正文）----
  const trimmed: TrimmedCounts = { toolResultsDropped: 0, historyTurnsDropped: 0 };
  const out = messages.map((m) => {
    if (!isToolMessage(m)) return m;
    const slimmed = slimToolMessage(m);
    if (slimmed !== m) trimmed.toolResultsDropped += 1;
    return slimmed;
  });

  const after = out.reduce((n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);

  const decision = decideContextBudget({
    enabled: cfg.enabled,
    contextWindow: cfg.window,
    outputReserveTokens: cfg.outputReserve,
    thresholdRatio: cfg.thresholdRatio,
    estimatedTokens: total,
    historyTurns: 0,
    consecutiveFailures: failures.consecutive,
    circuitBreakerAfter: cfg.circuitBreakerAfter,
    trimmed
  });

  // 精简后仍超阈值 → 计入"失败"（调用方累加），并在决策里如实反映（估算值仍是精简前）
  if (after > decision.threshold) failures.consecutive += 1;
  else failures.consecutive = 0;

  return { messages: out, decision };
}
