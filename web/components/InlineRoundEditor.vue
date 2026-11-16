<script setup lang="ts">
/**
 * 轮次内联编辑 / 回档轻量面板
 * ============================================================================
 *  · edit：在用户气泡位置直接改提问，发送 = 截断后续 + 可选退回业务操作 + 重发
 *  · rollback：只截断到本轮发起前、不重发；给一句简短确认，不铺开长解释
 *  · 只保留「同时退回本轮产生的业务操作」这一条决策；无法自动回退时给简短提醒
 */
import { nextTick, ref, watch } from 'vue';
import { t as tr } from '../i18n';

const props = defineProps<{
  mode: 'edit' | 'rollback';
  initialText: string;
  busy: boolean;
  error: string;
  /** 本轮牵涉业务写入：提醒"部分可能无法自动回退" */
  businessWrites: boolean;
}>();
const emit = defineEmits<{
  (e: 'cancel'): void;
  (e: 'submit', payload: { text: string; revertEffects: boolean }): void;
}>();

const text = ref(props.initialText);
const revertEffects = ref(true);
const box = ref<HTMLTextAreaElement | null>(null);

watch(
  () => props.mode,
  async () => {
    text.value = props.initialText;
    revertEffects.value = true;
    if (props.mode === 'edit') {
      await nextTick();
      box.value?.focus();
      box.value?.setSelectionRange(text.value.length, text.value.length);
    }
  },
  { immediate: true }
);

function submit(): void {
  if (props.busy) return;
  if (props.mode === 'edit' && !text.value.trim()) return;
  emit('submit', { text: text.value.trim(), revertEffects: revertEffects.value });
}
</script>

<template>
  <div class="ire" role="group" :aria-label="mode === 'edit' ? tr('修改并重新发起') : tr('回档到本轮发起前')">
    <textarea
      v-if="mode === 'edit'"
      ref="box"
      v-model="text"
      class="ire__text"
      rows="2"
      :disabled="busy"
      :placeholder="tr('修改这一轮要发送的内容…')"
      @keydown.ctrl.enter.prevent="submit"
      @keydown.meta.enter.prevent="submit"
    ></textarea>
    <p v-else class="ire__lead">{{ tr('将移除此轮及之后的对话') }}</p>

    <label class="ire__check">
      <input v-model="revertEffects" type="checkbox" :disabled="busy" />
      <span>{{ tr('同时退回本轮产生的业务操作') }}</span>
    </label>
    <p v-if="businessWrites" class="ire__warn">{{ tr('部分已提交到原系统的操作无法自动回退，需人工处理') }}</p>
    <p v-if="error" class="ire__err" role="alert">{{ error }}</p>

    <div class="ire__foot">
      <button type="button" class="ire__btn" :disabled="busy" @click="emit('cancel')">{{ tr('取消') }}</button>
      <button
        type="button"
        class="ire__btn ire__btn--primary"
        :disabled="busy || (mode === 'edit' && !text.trim())"
        @click="submit"
      >
        {{ tr(busy ? '处理中…' : mode === 'rollback' ? '确认回档' : '修改并发送') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ire {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
}
.ire__text {
  width: 100%;
  resize: vertical;
  font: inherit;
  line-height: 1.5;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
}
.ire__lead {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-muted);
}
.ire__check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text);
}
.ire__warn {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--warn);
}
.ire__err {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--danger);
}
.ire__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.ire__btn {
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  border-radius: var(--radius-sm);
  padding: 5px 14px;
  font-size: calc(var(--ui-font-size) * 0.92308);
  cursor: pointer;
}
.ire__btn:hover:not(:disabled) {
  background: var(--surface-3);
}
.ire__btn--primary {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--primary-contrast);
}
.ire__btn--primary:hover:not(:disabled) {
  background: var(--primary-hover);
}
.ire__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 触摸端：按钮拉高到拇指区，操作间距加大 */
@media (hover: none) {
  .ire__foot { gap: var(--sp-3); }
  .ire__btn { min-height: 40px; padding: 8px 18px; }
}
</style>
