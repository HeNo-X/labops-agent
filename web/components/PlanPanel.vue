<script setup lang="ts">
import { t as tr } from '../i18n';
/**
 * 任务计划面板 —— 模型自己的工作步骤（plan_updated / meta.plan）
 * ============================================================================
 *  · 数据是模型的工作记录，不是业务事实（工具结果里已声明，这里不强调业务口径）；
 *  · PC 与移动端共用本组件（共享组件不做平台分支）；
 *  · 无渐变/无发光/细边框，状态用字形与文字双编码（不只靠颜色）。
 */
import type { TaskPlanStep } from '@shared/types';

const props = defineProps<{ steps: TaskPlanStep[] }>();

const GLYPHS: Record<TaskPlanStep['status'], string> = { pending: '○', done: '✓', dropped: '—' };
function statusLabel(s: TaskPlanStep['status']): string {
  if (s === 'done') return tr('已完成');
  if (s === 'dropped') return tr('已放弃');
  return tr('待办');
}
</script>

<template>
  <section class="plan" data-testid="task-plan" aria-labelledby="plan-title">
    <h4 id="plan-title" class="plan__title">{{ tr('任务计划') }}</h4>
    <ol class="plan__steps">
      <li v-for="s in props.steps" :key="s.id" class="plan__step" :class="`plan__step--${s.status}`">
        <span class="plan__glyph" aria-hidden="true">{{ GLYPHS[s.status] ?? '○' }}</span>
        <span class="plan__text">{{ s.text }}</span>
        <span class="plan__status">{{ statusLabel(s.status) }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.plan {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  padding: var(--sp-2) var(--sp-3);
  margin: var(--sp-2) 0;
  background: var(--surface-2, transparent);
}
.plan__title {
  margin: 0 0 var(--sp-1);
  font-size: calc(var(--ui-font-size) * 0.84615);
  font-weight: 600;
  color: var(--text-muted);
}
.plan__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.plan__step {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.plan__glyph {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
}
.plan__step--done .plan__glyph {
  color: var(--ok);
}
.plan__step--dropped .plan__glyph {
  color: var(--border-strong);
}
.plan__step--done .plan__text {
  color: var(--text-muted);
}
.plan__step--dropped .plan__text {
  color: var(--text-faint);
  text-decoration: line-through;
}
.plan__text {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}
.plan__status {
  flex: 0 0 auto;
  font-size: calc(var(--ui-font-size) * 0.76923);
  color: var(--text-faint);
}
</style>
