import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { PendingInput, PendingInputMode } from '../lib/pending-input';
import { enqueuePending } from '../lib/pending-input';

/**
 * 待发送输入的唯一持有者（放在 store 而非组件：切换会话时状态要能带过去）。
 * ★ 它只是"暂存意图"，**不参与 inputLocked 判断**，也不构成第二条并发流：
 *   真正发出仍走 App.onSubmit 的单一入口与同步提交锁。
 */
export const usePendingInputStore = defineStore('pendingInput', () => {
  const pending = ref<PendingInput | null>(null);
  /** 最近一次排入是否覆盖了上一条（UI 需明示，不能静默丢弃用户输入） */
  const replaced = ref(false);

  function enqueue(conversationId: string, mode: PendingInputMode, text: string): void {
    const r = enqueuePending(pending.value, {
      conversationId,
      mode,
      text,
      createdAt: new Date().toISOString()
    });
    pending.value = r.pending;
    replaced.value = r.replaced;
  }

  /** 取消待发送：无任何发送副作用 */
  function clear(): void {
    pending.value = null;
    replaced.value = false;
  }

  /** 只取走属于该会话的待发送（其它会话的保持原样） */
  function takeFor(conversationId: string | null): PendingInput | null {
    const cur = pending.value;
    if (!cur || !conversationId || cur.conversationId !== conversationId) return null;
    pending.value = null;
    replaced.value = false;
    return cur;
  }

  return { pending, replaced, enqueue, clear, takeFor };
});
