import { clientFetch } from '../client';
import { actorHeaders } from '../actor';
import type { RunSnapshot } from '@shared/types';

/**
 * 运行快照回查（只读）。断线后把一轮收敛到服务端真实终态，替代"请手工回查"。
 * ★ 只发 GET：恢复路径**绝不**重发原消息（消息本身的幂等由 clientRequestId 保证，
 *   但不该在恢复时试探性地重放请求）。
 */
export async function fetchRunSnapshot(
  conversationId: string,
  runId: string,
  signal?: AbortSignal
): Promise<{ ok: true; snapshot: RunSnapshot } | { ok: false; code: string; message: string }> {
  try {
    const res = await clientFetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/run-snapshot?runId=${encodeURIComponent(runId)}`,
      { headers: actorHeaders(), signal }
    );
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = `快照回查失败（HTTP ${res.status}）`;
      try {
        const j = (await res.json()) as Record<string, unknown>;
        if (typeof j['error'] === 'string') code = j['error'];
        if (typeof j['message'] === 'string') message = j['message'];
      } catch {
        /* 保留默认文案 */
      }
      return { ok: false, code, message };
    }
    return { ok: true, snapshot: (await res.json()) as RunSnapshot };
  } catch (e) {
    return { ok: false, code: 'network_error', message: `快照回查失败：${(e as Error).message}` };
  }
}

/** 由服务端起止时间差出耗时（只在两者都可解析时给数字，否则 null） */
export function snapshotMs(snapshot: Pick<RunSnapshot, 'startedAt' | 'endedAt'>): number | null {
  if (!snapshot.startedAt || !snapshot.endedAt) return null;
  const a = Date.parse(snapshot.startedAt);
  const b = Date.parse(snapshot.endedAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

/** 终态 → 助手消息状态（UI 口径与历史轮一致） */
export function messageStatusOf(terminal: RunSnapshot['terminal']): 'completed' | 'failed' | 'cancelled' | 'interrupted' {
  if (terminal === 'completed') return 'completed';
  if (terminal === 'cancelled') return 'cancelled';
  if (terminal === 'interrupted') return 'interrupted';
  return 'failed';
}

/**
 * 是否应把快照当作"已收敛"：必须拿到明确终态。
 * phase=awaiting_confirm 而 terminal=null 时**不得**当作完成（负向断言）。
 */
export function isConverged(snapshot: RunSnapshot): boolean {
  return snapshot.terminal !== null;
}
