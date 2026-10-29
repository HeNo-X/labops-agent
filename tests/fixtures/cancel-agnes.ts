/**
 * 测试替身：只替换 streamChat，用于验证 router 的**记账时机**。
 *  · CANCEL_STUB_MODE=cancel（默认）⇒ 抛 run_cancelled，模拟用户取消
 *  · CANCEL_STUB_MODE=upstream-500 ⇒ 抛可重试的上游错误，模拟真实故障
 *
 * 刻意不 import server/llm/agnes.ts —— 本文件正是用来顶替它的，import 会绕回自己。
 * router 只按 `err.code` 判定，故用同名同形的轻量错误即可。
 */

export const cancelCalls: string[] = [];

class StubAgnesError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'AgnesError';
    this.code = code;
    this.retryable = retryable;
  }
}

// router.ts 里 `import { streamChat, AgnesError } from './agnes.ts'`，替身必须同名导出
export const AgnesError = StubAgnesError;

export async function* streamChat(opts: { provider?: { model?: string } }): AsyncGenerator<never> {
  cancelCalls.push(opts.provider?.model ?? 'unknown');
  const mode = process.env.CANCEL_STUB_MODE ?? 'cancel';
  if (mode === 'cancel') throw new StubAgnesError('run_cancelled', '任务已被取消。', false);
  throw new StubAgnesError('upstream_500', '上游不可用', true);
}

export type AgnesStreamEvent = never;
export type StreamOptions = { provider?: { model?: string }; messages?: unknown; signal?: AbortSignal };
