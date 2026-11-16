import { getConfig } from '../config.ts';

/**
 * 模型熔断器
 * ============================================================================
 *  问题：providersForMode 是顺序 fallback 链。若链上第一个模型持续 5xx 或鉴权失效，
 *  在**下一个模型可用**的情况下每一轮请求仍会先白等它一次 —— 表现为持续卡顿。
 *
 *  做法：连续失败达到阈值后让该模型进入冷却期，冷却期内直接跳过；
 *  冷却按失败次数指数退避并封顶，避免"永久拉黑"——上游恢复后应能自动回到链路。
 *
 *  两条刻意的保守约束：
 *   1. **只统计"未吐出任何内容前"的失败**。已经开始输出后再断，多半与本次回答有关
 *      （超时、内容触发拦截），不该让该模型替所有后续请求背锅；
 *   2. 全链都在冷却时**照常放行**（见 selectableProviders）。
 *      熔断是优化，不能变成新的不可用来源。
 */

interface State {
  failures: number;
  openUntil: number;
  lastFailureAt: number;
}

const states = new Map<string, State>();

function keyOf(provider: { baseUrl: string; model: string }): string {
  return `${provider.baseUrl}::${provider.model}`;
}

function limits() {
  const c = getConfig().circuit;
  return { threshold: c.failureThreshold, baseMs: c.cooloffMs, maxMs: c.maxCooloffMs, enabled: c.enabled };
}

/** 该模型当前是否在冷却中 */
export function isCoolingDown(provider: { baseUrl: string; model: string }, now = Date.now()): boolean {
  const s = states.get(keyOf(provider));
  return !!s && s.openUntil > now;
}

/** 冷却剩余毫秒；未在冷却返回 0 */
export function cooloffRemaining(provider: { baseUrl: string; model: string }, now = Date.now()): number {
  const s = states.get(keyOf(provider));
  if (!s) return 0;
  return Math.max(0, s.openUntil - now);
}

/**
 * 从链上挑出可立即尝试的模型。
 * 全部在冷却时返回原链 —— 宁可慢一次，也不要因为熔断器把自己锁死。
 */
export function selectableProviders<T extends { baseUrl: string; model: string }>(
  chain: T[],
  now = Date.now()
): { ready: T[]; skipped: Array<{ model: string; retryInMs: number }>; allCooling: boolean } {
  const { enabled } = limits();
  if (!enabled) return { ready: chain, skipped: [], allCooling: false };
  const ready: T[] = [];
  const skipped: Array<{ model: string; retryInMs: number }> = [];
  for (const p of chain) {
    const left = cooloffRemaining(p, now);
    if (left > 0) skipped.push({ model: p.model, retryInMs: left });
    else ready.push(p);
  }
  if (!ready.length) return { ready: chain, skipped, allCooling: true };
  return { ready, skipped, allCooling: false };
}

export function recordFailure(provider: { baseUrl: string; model: string }, now = Date.now()): void {
  const { threshold, baseMs, maxMs, enabled } = limits();
  if (!enabled) return;
  const key = keyOf(provider);
  const s = states.get(key) ?? { failures: 0, openUntil: 0, lastFailureAt: 0 };
  s.failures += 1;
  s.lastFailureAt = now;
  if (s.failures >= threshold) {
    const steps = s.failures - threshold;
    const cool = Math.min(maxMs, baseMs * 2 ** Math.min(steps, 5));
    s.openUntil = now + cool;
  }
  states.set(key, s);
}

export function recordSuccess(provider: { baseUrl: string; model: string }): void {
  states.delete(keyOf(provider));
}

/** 给运维/界面看：哪些模型正在冷却、还剩多久。不含密钥 */
export function circuitStatus(chain: Array<{ baseUrl: string; model: string }>, now = Date.now()) {
  return chain.map((p) => {
    const s = states.get(keyOf(p));
    return {
      model: p.model,
      consecutiveFailures: s?.failures ?? 0,
      coolingDown: isCoolingDown(p, now),
      retryInMs: cooloffRemaining(p, now)
    };
  });
}

export function resetCircuitForTests(): void {
  states.clear();
}
