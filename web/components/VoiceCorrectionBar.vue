<script setup lang="ts">
/**
 * 语音术语纠错提示条 —— 让"被改了字"这件事可见、可还原、可叫停
 * ============================================================================
 *  为什么必须存在：纠错层现在敢改 2 字词，收益变大，风险也变大。
 *  只靠"我们自测误改率为 0"不足以让用户信任 —— 所以每一次改动都要摊开，
 *  并且留两条退路：还原原文、本轮别再改。缺了这两条，就不该放宽短词门槛。
 *
 *  PC 与移动共用本组件（本仓库已被"同一能力两端各写一遍"坑过多次）。
 */
import { computed } from 'vue';
import { t as tr } from '../i18n';
import type { VoiceCorrection } from '../composables/useVoiceInput';

const props = defineProps<{
  corrections: VoiceCorrection[];
  /** 服务端回传的上游原文，还原动作用它，不在前端重新猜 */
  originalText?: string;
}>();

const emit = defineEmits<{
  (e: 'restore', original: string): void;
  (e: 'suppress'): void;
}>();

const MAX_SHOWN = 3;
const shown = computed(() => props.corrections.slice(0, MAX_SHOWN));
const hidden = computed(() => Math.max(0, props.corrections.length - MAX_SHOWN));
const canRestore = computed(() => typeof props.originalText === 'string' && props.originalText !== '');

function restore(): void {
  if (!canRestore.value) return;
  emit('restore', props.originalText ?? '');
}
</script>

<template>
  <p v-if="corrections.length" class="vcb" role="status" aria-live="polite">
    <span class="vcb__mark" aria-hidden="true">⌁</span>
    <span class="vcb__text">
      {{ tr('语音识别按实验室术语表调整了 {n} 处', { n: corrections.length }) }}
      <span v-for="(c, i) in shown" :key="`${c.from}-${i}`" class="vcb__pair">
        <span class="vcb__from">{{ c.from }}</span>
        <span class="vcb__arrow" aria-hidden="true">→</span>
        <span class="vcb__to">{{ c.to }}</span>
      </span>
      <span v-if="hidden">{{ tr('另有 {n} 处未列出', { n: hidden }) }}</span>
    </span>
    <span class="vcb__actions">
      <button type="button" class="vcb__btn" :disabled="!canRestore" @click="restore">{{ tr('还原原文') }}</button>
      <button type="button" class="vcb__btn vcb__btn--ghost" @click="emit('suppress')">{{ tr('本轮不要调整术语') }}</button>
    </span>
  </p>
</template>

<style scoped>
/* 细线 + 极轻分层：不用渐变、不用发光、不用大圆角、不用重投影 */
.vcb {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--sp-2);
  margin: var(--sp-2) 0 0;
  padding: var(--sp-1) 0 var(--sp-1) var(--sp-3);
  border-left: 2px solid var(--primary-border);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
  line-height: 1.5;
}
.vcb__mark {
  color: var(--primary);
  font-size: calc(var(--ui-font-size) * 0.84615);
}
.vcb__text {
  flex: 1 1 240px;
  min-width: 0;
}
.vcb__pair {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  margin-right: var(--sp-2);
  white-space: nowrap;
}
.vcb__from {
  color: var(--text-faint);
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.vcb__arrow {
  color: var(--text-faint);
}
.vcb__to {
  color: var(--text);
}
.vcb__actions {
  display: inline-flex;
  gap: var(--sp-1);
}
.vcb__btn {
  font: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px var(--sp-2);
  cursor: pointer;
}
.vcb__btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--surface-2);
}
.vcb__btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.vcb__btn:disabled {
  color: var(--text-faint);
  cursor: not-allowed;
}
.vcb__btn--ghost {
  color: var(--text-muted);
  background: transparent;
}
@media (prefers-reduced-motion: no-preference) {
  .vcb__btn {
    transition: border-color 120ms ease, background 120ms ease;
  }
}
</style>
