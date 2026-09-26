<script setup lang="ts">
/**
 * 状态标签 —— 无障碍硬要求：**不能只用颜色区分状态**
 * 每个状态三重编码：① 形状符号（✓ ▲ ✕ ● ○）② 文字标签 ③ 边框样式（实线/虚线/双线）
 * 颜色只是补充。色盲用户、单色打印、黑白截图都能分清。
 */
import { computed } from 'vue';
import { TONE_GLYPH, TONE_SHAPE } from './ui-types';
import type { Tone } from './ui-types';

const props = defineProps<{
  tone: Tone;
  label: string;
  /** 覆盖默认符号 */
  glyph?: string;
  /** 覆盖默认边框样式 */
  shape?: 'solid' | 'dashed' | 'double';
  title?: string;
}>();

const classes = computed(() => [`tag--${props.tone}`, `tag--${props.shape ?? TONE_SHAPE[props.tone]}`]);
const symbol = computed(() => props.glyph ?? TONE_GLYPH[props.tone]);
</script>

<template>
  <span class="tag" :class="classes" :title="title">
    <span class="tag__glyph" aria-hidden="true">{{ symbol }}</span>
    <span class="tag__label">{{ label }}</span>
  </span>
</template>

<style scoped>
.tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  border-width: 1px;
  border-style: solid;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  font-weight: 500;
}
.tag__glyph {
  font-size: 11px;
  line-height: 1;
}
.tag--solid {
  border-style: solid;
}
.tag--dashed {
  border-style: dashed;
}
.tag--double {
  border-style: double;
  border-width: 3px;
  padding: 1px 7px;
}
.tag--ok {
  color: var(--ok);
  background: var(--ok-bg);
  border-color: var(--ok-border);
}
.tag--warn {
  color: var(--warn);
  background: var(--warn-bg);
  border-color: var(--warn-border);
}
.tag--danger {
  color: var(--danger);
  background: var(--danger-bg);
  border-color: var(--danger-border);
}
.tag--info {
  color: var(--info);
  background: var(--info-bg);
  border-color: var(--info-border);
}
.tag--neutral {
  color: var(--neutral);
  background: var(--neutral-bg);
  border-color: var(--neutral-border);
}
</style>
