<script setup lang="ts">
/**
 * 常驻命令栏 —— 任务的唯一入口
 * ============================================================================
 *  · 中文自然语言输入，Enter 提交（Shift+Enter 换行）
 *  · 示例问题来自真实数据（房间号取自 /api/state，演示日期由 termStart 推导），
 *    不是写死的字符串
 *  · 运行中禁止二次提交（避免并发覆盖 store 里的任务状态），但允许取消
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useRunStore } from '../stores/run';
import StatusTag from './StatusTag.vue';

const store = useRunStore();
const text = ref('');
const inputEl = ref<HTMLTextAreaElement | null>(null);

const canSubmit = computed(() => text.value.trim().length > 0 && store.phase !== 'running');
const busy = computed(() => store.phase === 'running');

const emit = defineEmits<{ submit: [string]; cancel: [] }>();

function submit(): void {
  if (!canSubmit.value) return;
  emit('submit', text.value.trim());
}

function useExample(q: string): void {
  text.value = q;
  void nextTick(() => inputEl.value?.focus());
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}

watch(
  () => store.phase,
  (p) => {
    if (p !== 'running') void nextTick(() => inputEl.value?.focus());
  }
);
</script>

<template>
  <section class="bar" aria-labelledby="bar-h">
    <h2 id="bar-h" class="sr-only">命令栏</h2>

    <div class="bar__examples">
      <span class="bar__examples-label">示例：</span>
      <button
        v-for="q in store.exampleQuestions"
        :key="q"
        type="button"
        class="chip"
        :disabled="busy"
        @click="useExample(q)"
      >
        {{ q }}
      </button>
    </div>

    <div class="bar__row">
      <label class="sr-only" for="cmd">输入你的实验室问题</label>
      <textarea
        id="cmd"
        ref="inputEl"
        v-model="text"
        class="bar__input"
        rows="1"
        placeholder="用一句话问，例如：E310 2026-09-30 有哪些课？"
        :disabled="busy"
        @keydown="onKeydown"
      />
      <button v-if="!busy" type="button" class="bar__btn" :disabled="!canSubmit" @click="submit">发起任务</button>
      <button v-else type="button" class="bar__btn bar__btn--ghost" @click="emit('cancel')">取消</button>
    </div>

    <p class="bar__hint">
      <StatusTag
        v-if="busy"
        tone="info"
        glyph="◌"
        label="查询中"
        title="正在处理，请稍候"
      />
      <span v-if="store.demoDate" class="bar__hint-text">
        提示：当前学期第 4 教学周的周三是 <b>{{ store.demoDate }}</b>；说「今天」「下周三」「9月30日」都可以。
      </span>
    </p>
  </section>
</template>

<style scoped>
.bar {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-3) var(--sp-4);
  box-shadow: var(--shadow-2);
}
.bar__examples {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.bar__examples-label {
  font-size: 12px;
  color: var(--text-faint);
}
.chip {
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 12px;
  padding: 2px 10px;
  cursor: pointer;
}
.chip:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary-border);
  background: var(--primary-weak);
}
.chip:disabled {
  opacity: 0.5;
  cursor: default;
}
.bar__row {
  display: flex;
  gap: var(--sp-2);
  align-items: stretch;
}
.bar__input {
  flex: 1;
  min-width: 0;
  resize: vertical;
  min-height: 40px;
  max-height: 140px;
  padding: 9px var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
}
.bar__input:disabled {
  opacity: 0.6;
}
.bar__btn {
  flex: 0 0 auto;
  padding: 0 var(--sp-5);
  border: 1px solid var(--primary);
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  min-height: 40px;
}
.bar__btn:hover:not(:disabled) {
  background: var(--primary-hover);
}
.bar__btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.bar__btn--ghost {
  background: transparent;
  color: var(--text-muted);
  border-color: var(--border-strong);
}
.bar__btn--ghost:hover {
  background: var(--surface-3);
  color: var(--text);
}
.bar__hint {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-2) 0 0;
  font-size: 12px;
  color: var(--text-faint);
  flex-wrap: wrap;
}
.bar__hint-text b {
  color: var(--text-muted);
  font-family: var(--font-mono);
}

@media (max-width: 640px) {
  .bar {
    padding: var(--sp-2) var(--sp-3);
  }
  /* 示例问题改成单行横向滚动 —— 换行会把这个吸底栏撑到 250px+，挡住正文 */
  .bar__examples {
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;
  }
  .bar__examples::-webkit-scrollbar {
    display: none;
  }
  .bar__examples-label {
    flex: 0 0 auto;
  }
  .chip {
    flex: 0 0 auto;
  }
  .bar__row {
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .bar__input {
    flex: 1 1 100%;
    min-height: 38px;
    padding: 7px var(--sp-3);
  }
  .bar__btn {
    flex: 1 1 100%;
    min-height: 38px;
  }
  /* 提示长句在手机上不显示：吸底栏的每一像素都要留给输入本身 */
  .bar__hint-text {
    display: none;
  }
  .bar__hint {
    margin-top: var(--sp-1);
  }
}
</style>
