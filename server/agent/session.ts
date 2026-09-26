/**
 * 会话上下文表 —— 「那 E312 呢？」的承接能力（阶段 2A 首片）
 * ============================================================================
 *  定位：**内存中的有界最近意图表**。不落盘、不含任何用户身份信息，
 *  只记录"这个会话最近一次问到的房间号 / 日期 / 节次"，供下一问缺省时显式沿用。
 *
 *  边界（必须遵守）：
 *    · 容量上限 + TTL，超限即淘汰最旧的 —— 防止长驻进程内存无界增长
 *    · 换 sessionId 就拿不到旧上下文（前端「新会话」按钮会重新生成 id）
 *    · 沿用上一问的值**必须留痕**：resolvedHint.source 要写明「沿用上一问」，
 *      绝不能把承接来的值伪装成本轮独立识别的结果
 */

export interface SessionIntent {
  labName: string | null;
  date: string | null;
  periodKey: string | null;
  /** 最近一次问题原文（截断，仅用于排查，不进界面） */
  question: string;
  updatedAt: number;
}

const MAX_SESSIONS = 200;
const TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, SessionIntent>();

/** 清理过期会话；Map 按插入序淘汰最旧 */
function sweep(now: number): void {
  for (const [k, v] of sessions) {
    if (now - v.updatedAt > TTL_MS) sessions.delete(k);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function getSession(sessionId: string | null | undefined): SessionIntent | null {
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return s;
}

export function rememberSession(
  sessionId: string | null | undefined,
  intent: { labName: string | null; date: string | null; periodKey: string | null; question: string }
): void {
  if (!sessionId) return;
  sweep(Date.now());
  sessions.set(sessionId, {
    labName: intent.labName,
    date: intent.date,
    periodKey: intent.periodKey,
    question: intent.question.slice(0, 200),
    updatedAt: Date.now()
  });
}

export function forgetSession(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  sessions.delete(sessionId);
}

/** 仅供测试 */
export function resetSessionsForTest(): void {
  sessions.clear();
}
