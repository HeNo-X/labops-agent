/**
 * 上下文预算决策 —— 确定性、可解释、可一键关闭
 * ============================================================================
 *  明确不做 LLM 摘要压缩（成本高、新增幻觉面）。这里只回答一个问题：
 *  「这一轮该不该精简上下文？为什么？」并给出可观测的决策对象。
 *
 *  照抄两条关键设计：
 *   ① **分母先扣输出预留**：模型的 context window 是 input+output 共享窗口，
 *      自动精简只能让出输入侧，所以阈值必须按 (window - reserve) 算，
 *      否则会算出一个"看起来没超、实际已经挤掉输出"的假安全值。
 *   ② **连续失败达阈值后置 circuit_breaker 并停止再处理**：避免每一步都白算一遍。
 *
 *  ⚠️ token 数是**估算**（中文字符≈1 token 的保守系数，按字符计，偏保守 ——
 *  宁可早精简）。它绝不冒充 provider 的真实 usage，也绝不会被当作 usage 上报或展示。
 *
 *  纯函数、无运行时依赖 —— 前后端共用，可直接单测。
 */

export type BudgetReason = 'disabled' | 'not_enough_turns' | 'below_threshold' | 'above_threshold' | 'circuit_breaker';

export interface TrimmedCounts {
  toolResultsDropped: number;
  historyTurnsDropped: number;
}

export interface BudgetDecision {
  shouldTrim: boolean;
  reason: BudgetReason;
  /** 本轮只有估算；拿不到 provider usage 就写 estimate，禁止假称精确 */
  tokenSource: 'estimate';
  estimatedTokens: number;
  threshold: number;
  contextWindow: number;
  outputReserveTokens: number;
  /** = contextWindow - min(reserve, contextWindow)，永不为负 */
  effectiveContextWindow: number;
  /** 本次决策**已**精简掉的条数（shouldTrim=false 时通常为 0） */
  trimmed: TrimmedCounts;
}

export interface BudgetInput {
  /** CONTEXT_TRIM_ENABLED */
  enabled: boolean;
  contextWindow: number;
  outputReserveTokens: number;
  /** 阈值占有效窗口的比例（0–1） */
  thresholdRatio: number;
  estimatedTokens: number;
  /** 可精简的历史轮数（工具结果条数由 trimmed 反映实际精简量） */
  historyTurns: number;
  /** 连续失败次数（含"精简后仍超阈值"） */
  consecutiveFailures: number;
  circuitBreakerAfter: number;
  /** 达到熔断阈值前就判定为可精简时的实际精简结果 */
  trimmed?: TrimmedCounts;
}

/** 保守估算：中日韩字符按 1 token/字，其余按 4 字符≈1 token。偏保守即"宁可早截断"。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0x3000 && code <= 0x303f) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export const EMPTY_TRIM: TrimmedCounts = { toolResultsDropped: 0, historyTurnsDropped: 0 };

export function decideContextBudget(input: BudgetInput): BudgetDecision {
  const contextWindow = Math.max(1, Math.floor(input.contextWindow));
  // 输出预留不能超过窗口本身，否则有效窗口会被算成负数
  const outputReserveTokens = Math.min(Math.max(0, Math.floor(input.outputReserveTokens)), contextWindow);
  const effectiveContextWindow = contextWindow - outputReserveTokens;
  const ratio = Math.min(1, Math.max(0, input.thresholdRatio || 0));
  const threshold = Math.floor(effectiveContextWindow * ratio);
  const estimatedTokens = Math.max(0, Math.floor(input.estimatedTokens));
  const trimmed = input.trimmed ?? EMPTY_TRIM;

  const base = {
    tokenSource: 'estimate' as const,
    estimatedTokens,
    threshold,
    contextWindow,
    outputReserveTokens,
    effectiveContextWindow
  };

  if (!input.enabled) {
    return { ...base, shouldTrim: false, reason: 'disabled', trimmed: EMPTY_TRIM };
  }
  // 没有可精简的历史时，精简无意义（连一条工具结果都没有就没得瘦身）
  if (input.historyTurns <= 0 && trimmed.toolResultsDropped === 0 && estimatedTokens <= threshold) {
    return { ...base, shouldTrim: false, reason: 'not_enough_turns', trimmed: EMPTY_TRIM };
  }
  // 熔断：连续失败够了就停止再处理，但**如实报告**当前估算与阈值
  if (input.consecutiveFailures >= Math.max(1, input.circuitBreakerAfter)) {
    return { ...base, shouldTrim: false, reason: 'circuit_breaker', trimmed: EMPTY_TRIM };
  }
  if (estimatedTokens <= threshold) {
    return { ...base, shouldTrim: false, reason: 'below_threshold', trimmed: EMPTY_TRIM };
  }
  return { ...base, shouldTrim: true, reason: 'above_threshold', trimmed };
}

/** 给界面/日志用的一行说明（中文，走 tr() 展示） */
export function describeBudget(d: BudgetDecision): string {
  const trimmedTotal = d.trimmed.toolResultsDropped + d.trimmed.historyTurnsDropped;
  const head = `上下文：估算 ${d.estimatedTokens} / 阈值 ${d.threshold} token（${d.tokenSource}）`;
  switch (d.reason) {
    case 'disabled':
      return `上下文：精简已关闭（估算 ${d.estimatedTokens} token）`;
    case 'not_enough_turns':
      return `上下文：无可精简内容（估算 ${d.estimatedTokens} / 阈值 ${d.threshold}）`;
    case 'below_threshold':
      return `${head} · 未超阈值`;
    case 'circuit_breaker':
      return `${head} · 已连续精简失败，停止再处理`;
    default:
      return `${head} · 已精简 ${trimmedTotal} 条工具结果`;
  }
}
