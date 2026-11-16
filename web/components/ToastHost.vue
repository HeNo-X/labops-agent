<script setup lang="ts">
/**
 * Toast 宿主 —— 渲染 feedback.ts 中的瞬态提示。
 * 样式在 mobile.css（.m-toast-wrap / .m-toast）；动画遵守 reduced-motion。
 */
import { useFeedback } from '../mobile/feedback';

const { state, dismissToast } = useFeedback();

function run(id: number, action?: () => void): void {
  action?.();
  dismissToast(id);
}
</script>

<template>
  <div class="m-toast-wrap" aria-live="polite">
    <div v-for="t in state.toasts" :key="t.id" class="m-toast" role="status">
      <span>{{ t.text }}</span>
      <button v-if="t.actionLabel" type="button" @click="run(t.id, t.action)">{{ t.actionLabel }}</button>
    </div>
  </div>
</template>
