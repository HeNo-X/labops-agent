<script setup lang="ts">
/**
 * 任务轨迹 —— 只展示**可观察**的事件
 * ============================================================================
 * 第一阶段提示词第 3 条：「展示"正在查询课表""已获得结果""查询失败"等可观察事件。
 *  **不要展示、模拟或要求模型输出内部思维链。**」
 *  所以这里的每一行都来自真实 SSE 事件（run_started / tool_started / tool_result /
 *  run_completed / run_failed），没有任何一行是"假装模型在想"的内容。
 */
import { useRunStore } from '../stores/run';
import type { TraceStep } from '../stores/run';
import StatusTag from './StatusTag.vue';
import type { Tone } from './ui-types';

const store = useRunStore();

function toneOf(s: TraceStep): Tone {
  if (s.status === 'failed') return 'danger';
  if (s.status === 'running') return 'info';
  if (s.status === 'cancelled') return 'neutral';
  return 'ok';
}

function glyphOf(s: TraceStep): string {
  if (s.status === 'failed') return '✕';
  if (s.status === 'running') return '◌';
  if (s.status === 'cancelled') return '⏹';
  if (s.kind === 'done') return '✓';
  if (s.kind === 'tool') return '▣';
  return '✓';
}

function labelOf(s: TraceStep): string {
  if (s.status === 'failed') return '失败';
  if (s.status === 'running') return '进行中';
  if (s.status === 'cancelled') return '已取消';
  return '完成';
}
</script>

<template>
  <section class="trace" aria-labelledby="trace-h">
    <header class="trace__head">
      <h2 id="trace-h">任务轨迹</h2>
      <p class="trace__sub">只记录可观察的步骤（服务端事件），不含模型内部推理。</p>
    </header>

    <ol v-if="store.trace.length" class="steps">
      <li v-for="s in store.trace" :key="s.id" class="step" :class="`step--${s.status}`">
        <span class="step__rail" aria-hidden="true"></span>
        <div class="step__body">
          <div class="step__title">
            <span class="step__name">{{ s.title }}</span>
            <StatusTag :tone="toneOf(s)" :glyph="glyphOf(s)" :label="labelOf(s)" />
            <span v-if="s.ms !== undefined" class="step__ms">{{ s.ms }} ms</span>
          </div>
          <p v-if="s.detail" class="step__detail">{{ s.detail }}</p>
          <details v-if="s.argsText || s.summaryFull" class="step__more">
            <summary>调用参数与完整摘要</summary>
            <p v-if="s.argsText" class="step__mono">参数：{{ s.argsText }}</p>
            <p v-if="s.summaryFull" class="step__mono">摘要：{{ s.summaryFull }}</p>
          </details>
        </div>
      </li>
    </ol>

    <p v-else class="trace__empty">
      还没有任务。在下方命令栏输入一句话开始，例如「{{ store.exampleQuestions[0] }}」。
    </p>

    <p v-if="store.runStatus === 'running'" class="trace__timer" aria-live="polite">
      已用时 {{ (store.elapsedMs / 1000).toFixed(1) }} 秒…
    </p>
  </section>
</template>

<style scoped>
.trace {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-1);
}
.trace__head h2 {
  margin: 0 0 var(--sp-1);
  font-size: 15px;
}
.trace__sub {
  margin: 0 0 var(--sp-3);
  color: var(--text-faint);
  font-size: 12px;
}
.trace__empty {
  margin: 0;
  padding: var(--sp-4) 0;
  color: var(--text-faint);
  font-size: 13px;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
}
.step {
  position: relative;
  display: flex;
  gap: var(--sp-3);
  padding: 0 0 var(--sp-3) 0;
}
.step:last-child {
  padding-bottom: 0;
}
.step__rail {
  flex: 0 0 10px;
  position: relative;
  margin-top: 5px;
}
.step__rail::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 10px;
  bottom: -14px;
  width: 2px;
  background: var(--border);
}
.step:last-child .step__rail::before {
  display: none;
}
.step__rail::after {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  background: var(--surface);
}
.step--done .step__rail::after {
  border-color: var(--ok);
  background: var(--ok);
}
.step--failed .step__rail::after {
  border-color: var(--danger);
  background: var(--danger);
}
.step--running .step__rail::after {
  border-color: var(--info);
  background: var(--info);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.step__body {
  flex: 1;
  min-width: 0;
}
.step__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.step__name {
  font-size: 13px;
  font-weight: 600;
}
.step__ms {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
}
.step__detail {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-word;
}
.step__more {
  margin-top: 4px;
  font-size: 11px;
}
.step__more summary {
  cursor: pointer;
  color: var(--text-faint);
  user-select: none;
}
.step__more[open] summary {
  margin-bottom: 2px;
}
.step__mono {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  color: var(--text-muted);
  word-break: break-word;
}
.step--cancelled .step__rail::after {
  border-color: var(--border-strong);
  background: var(--border-strong);
}
.trace__timer {
  margin: var(--sp-3) 0 0;
  font-size: 12px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
</style>
