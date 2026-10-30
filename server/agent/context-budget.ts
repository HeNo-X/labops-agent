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
import { decideContextBudget, estimateTokens, type BudgetDecision, type TrimmedCounts } from '@shared/context-budget';

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

function slimToolMessage(m: ChatMessage): ChatMessage {
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  if (content.length <= TOOL_RESULT_KEEP_CHARS) return m;
  return {
    role: 'tool',
    tool_call_id: m.tool_call_id,
    content: `${content.slice(0, TOOL_RESULT_KEEP_CHARS)}…[已精简：原始长度 ${content.length} 字，完整依据见工具结果卡]`
  };
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
