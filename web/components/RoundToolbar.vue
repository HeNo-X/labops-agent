<script setup lang="ts">
/**
 * 轮次操作条（0.6.0）
 * ============================================================================
 *  · 挂在每一轮对话上，hover / 键盘聚焦时浮现（触摸端常显，见 App.vue 的媒体查询）
 *  · 「删除本轮」两种模式都有；「回档 / 修改」只在工作模式出现 ——
 *    聊天模式不产生业务写入，回档与删除语义重合，多一个入口只会让人误以为能撤销什么
 *  · 运行中一律禁用：结构被改动而回答仍在追写，是历史与内存最容易脱节的一刻
 */
defineProps<{
  index: number;
  /** 工作模式（task）才提供回档/修改 */
  canRewind: boolean;
  /** 会话正在执行：任何破坏性操作都禁用 */
  busy: boolean;
  /** 该轮没有起始 user 消息（历史异常）时不提供操作 */
  actionable: boolean;
}>();
const emit = defineEmits<{ remove: []; rollback: []; edit: [] }>();
</script>

<template>
  <div class="roundtool" :data-round="index">
    <span class="roundtool__idx">第 {{ index }} 轮</span>
    <button
      v-if="canRewind && actionable"
      type="button"
      class="roundtool__btn"
      :disabled="busy"
      :title="`回到第 ${index} 轮发起前（可一并回退本轮业务写入）`"
      :aria-label="`回档到第 ${index} 轮发起前`"
      @click="emit('rollback')"
    >
      回档
    </button>
    <button
      v-if="canRewind && actionable"
      type="button"
      class="roundtool__btn"
      :disabled="busy"
      :title="`修改第 ${index} 轮的提问并重新发起`"
      :aria-label="`修改第 ${index} 轮的提问并重新发起`"
      @click="emit('edit')"
    >
      修改
    </button>
    <button
      v-if="actionable"
      type="button"
      class="roundtool__btn roundtool__btn--danger"
      :disabled="busy"
      :title="`删除第 ${index} 轮的提问与回答（不影响其他轮次）`"
      :aria-label="`删除第 ${index} 轮`"
      @click="emit('remove')"
    >
      删除本轮
    </button>
  </div>
</template>

<style scoped>
.roundtool {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-height: 18px;
}
.roundtool__idx {
  font-size: 11px;
  color: var(--text-faint);
  margin-right: auto;
  letter-spacing: 0.02em;
}
.roundtool__btn {
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.4;
  border-radius: var(--radius-sm);
  padding: 1px 8px;
  cursor: pointer;
}
.roundtool__btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-2);
}
.roundtool__btn--danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}
.roundtool__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
