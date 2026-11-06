import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { PendingInput, PendingInputMode } from '../lib/pending-input';
import { PENDING_QUEUE_MAX, enqueueQueue, shiftQueueFor } from '../lib/pending-input';

/**
 * 运行中待发送输入的持有者（放在 store 而非组件：切换会话时状态要能带过去）。
 * ============================================================================
 *  2026-11-06 由"单条覆盖"改为"最多 3 条队列"：
 *   · 队首（pending）保持旧语义，模板与消费逻辑无需大改；
 *   · 队列满时**拒收并置 rejected**，UI 必须提示，不能静默丢；
 *   · 仍然只是"暂存意图"，不参与 inputLocked 判断，不构成第二条并发流。
 */
export const usePendingInputStore = defineStore('pendingInput', () => {
  const queue = ref<PendingInput[]>([]);
  const rejected = ref(false);
  /** 兼容旧模板字段：多队列下不再有"覆盖"语义 */
  const replaced = ref(false);
  const pending = computed<PendingInput | null>(() => queue.value[0] ?? null);

  function enqueue(conversationId: string, mode: PendingInputMode, text: string): void {
    const r = enqueueQueue(queue.value, {
      conversationId,
      mode,
      text,
      createdAt: new Date().toISOString()
    });
    queue.value = r.queue;
    rejected.value = r.rejected;
  }

  function clear(): void {
    queue.value = [];
    rejected.value = false;
  }

  function dropAt(index: number): void {
    queue.value = queue.value.filter((_, i) => i !== index);
    rejected.value = false;
  }

  /** 只取走属于该会话的队首（其它会话的保持原样） */
  function takeFor(conversationId: string | null): PendingInput | null {
    const { head, rest } = shiftQueueFor(queue.value, conversationId);
    if (!head) return null;
    queue.value = rest;
    rejected.value = false;
    return head;
  }

  return { queue, pending, replaced, rejected, max: PENDING_QUEUE_MAX, enqueue, clear, dropAt, takeFor };
});
