/**
 * 运行中待发送输入（单条、会话隔离）—— 纯决策逻辑，可单测
 * ============================================================================
 *  要解决的问题：本轮还在跑时，用户最自然的动作是"补一句"，而直接禁用输入框
 *  无法满足。这里只做**单条暂存意图**，绝不构成第二条并发流：
 *   · inputLocked 的语义与 6 处消费点完全不变（本模块不参与锁判断）；
 *   · 暂存随 conversationId 隔离 —— A 会话排的句子切到 B 会话不会自动发出；
 *   · 终态到达时若草稿已被用户写了新内容，**不覆盖、不自动发送**，而是填回草稿
 *     让用户自己确认（"草稿冲突不猜测"）。
 */

export type PendingInputMode = 'chat' | 'task';

export interface PendingInput {
  conversationId: string;
  mode: PendingInputMode;
  text: string;
  createdAt: string;
}

export interface EnqueueResult {
  pending: PendingInput | null;
  /** 覆盖了上一条待发送（UI 要明示，不能静默丢弃用户输入） */
  replaced: boolean;
}

/** 排入待发送：运行中重复提交只保留最后一条，并标记"已替换" */
export function enqueuePending(prev: PendingInput | null, next: PendingInput): EnqueueResult {
  const text = next.text.trim();
  if (!text) return { pending: prev, replaced: false };
  const replaced = Boolean(prev && prev.conversationId === next.conversationId && prev.text !== text);
  return { pending: { ...next, text }, replaced };
}

/**
 * 终态后的处置决策。四选一，互斥：
 *   send      —— 是当前会话、草稿为空 → 自动发出
 *   refill    —— 是当前会话、草稿非空 → 不发送，文本填回草稿待用户确认
 *   none      —— 其它会话排的 / 仍在运行 / 没有待发送
 */
export type PendingOutcome =
  | { action: 'send'; text: string }
  | { action: 'refill'; text: string }
  | { action: 'none'; reason: 'empty' | 'other_conversation' | 'still_running' };

export function resolvePendingOnTerminal(input: {
  pending: PendingInput | null;
  conversationId: string | null;
  running: boolean;
  draft: string;
}): PendingOutcome {
  const { pending, conversationId, running, draft } = input;
  if (!pending || !pending.text.trim()) return { action: 'none', reason: 'empty' };
  if (running) return { action: 'none', reason: 'still_running' };
  if (!conversationId || pending.conversationId !== conversationId) {
    return { action: 'none', reason: 'other_conversation' };
  }
  if (draft.trim()) return { action: 'refill', text: pending.text };
  return { action: 'send', text: pending.text };
}

/**
 * 用户已经切走、在原会话外等它结束时：**不自动发到原会话**（"回落到原会话"是惊喜而非帮助），
 * 把意图折回该会话自己的草稿 —— 切回去时它就躺在输入框里，可改可取消。
 */
export function resolvePendingOnSwitchAway(input: {
  pending: PendingInput | null;
  activeConversationId: string | null;
}): { action: 'fold_to_draft'; conversationId: string; text: string } | { action: 'none' } {
  const { pending, activeConversationId } = input;
  if (!pending || !pending.text.trim()) return { action: 'none' };
  if (activeConversationId === pending.conversationId) return { action: 'none' };
  return { action: 'fold_to_draft', conversationId: pending.conversationId, text: pending.text };
}

/** 草稿合并：不覆盖用户已有内容，另起一行追加（与语音输入"并入而非覆盖"同一口径） */
export function mergeDraft(prevDraft: string, text: string): string {
  const head = prevDraft.replace(/\s+$/, '');
  const tail = text.trim();
  if (!tail) return prevDraft;
  return head ? `${head}\n${tail}` : tail;
}

/**
 * 多条队列：上限 3 条，超出**拒绝入队**并给出提示，
 * 而不是静默丢弃或覆盖前一条 —— 用户的输入不能被偷偷吞掉。
 */
export const PENDING_QUEUE_MAX = 3;

export interface QueueEnqueueResult {
  queue: PendingInput[];
  accepted: boolean;
  /** 队列已满被拒（UI 必须提示） */
  rejected: boolean;
}

export function enqueueQueue(queue: PendingInput[], next: PendingInput, max = PENDING_QUEUE_MAX): QueueEnqueueResult {
  const text = next.text.trim();
  if (!text) return { queue, accepted: false, rejected: false };
  const duplicated = queue.some((i) => i.conversationId === next.conversationId && i.text === text);
  if (duplicated) return { queue, accepted: false, rejected: false };
  if (queue.length >= max) return { queue, accepted: false, rejected: true };
  return { queue: [...queue, { ...next, text }], accepted: true, rejected: false };
}

/** 取走队首（仅当属于该会话）：自动按序执行时的唯一出口 */
export function shiftQueueFor(queue: PendingInput[], conversationId: string | null): { head: PendingInput | null; rest: PendingInput[] } {
  const head = queue[0];
  if (!head || !conversationId || head.conversationId !== conversationId) return { head: null, rest: queue };
  return { head, rest: queue.slice(1) };
}
