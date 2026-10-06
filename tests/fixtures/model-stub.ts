/**
 * 离线模型替身 —— 只服务于测试，不参与生产。
 * ============================================================================
 *  为什么需要它：runAgnesEngine 的**终态**逻辑（工具失败后如何收尾）此前完全
 *  没有测试覆盖 —— 因为真实模型不可控，用真模型测终态等于没有测试。
 *  这里用一个"照剧本演"的假模型替换 `server/llm/router.ts`，
 *  让「工具失败 → 无可靠结论」这条路径可以被确定性地断言。
 *
 *  接线方式见 tests/tool-failure-report.test.ts 里的 registerHooks。
 */

export type StubTurn =
  /** 模型本轮要求调用某个工具 */
  | { kind: 'tool'; name: string; args: unknown }
  /** 模型本轮只说话，不再调用工具（循环就此结束） */
  | { kind: 'text'; text: string }
  /** 模型本轮什么都不输出 */
  | { kind: 'none' };

export type StubEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { type: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: 'done'; finishReason: string };

/** 剧本：第 N 轮模型想做什么。测试通过 resetScript() 设置。 */
export const script: StubTurn[] = [];

export function resetScript(turns: StubTurn[]): void {
  script.length = 0;
  script.push(...turns);
}

export function engineForMode(mode: 'chat' | 'task'): string {
  return mode === 'task' ? 'agnes' : 'agnes';
}

/**
 * 签名与 server/llm/router.ts 的 streamChatWithFallback 对齐。
 * 轮次判定：run.ts 每执行完一轮就把 assistant 消息 push 回上下文，
 * 所以「上下文里 assistant 消息的条数」就是当前是第几轮。
 */
export async function* streamChatWithFallback(
  opts: { messages: Array<{ role: string }>; tools?: unknown; signal?: AbortSignal },
  _mode?: 'chat' | 'task',
  _log?: unknown
): AsyncGenerator<StubEvent> {
  const turn = opts.messages.filter((m) => m.role === 'assistant').length;
  const step: StubTurn = script[turn] ?? { kind: 'none' };

  if (step.kind === 'tool') {
    yield {
      type: 'tool_calls',
      calls: [
        {
          id: `stub-turn-${turn}`,
          type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.args ?? {}) }
        }
      ]
    };
  } else if (step.kind === 'text') {
    yield { type: 'text', text: step.text };
  }

  yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  yield { type: 'done', finishReason: step.kind === 'tool' ? 'tool_calls' : 'stop' };
}
