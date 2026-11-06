<script setup lang="ts">
/**
 * 「登记常见误写」面板 —— 说话的人把自己的词交给系统，下次识别就用上
 * ============================================================================
 *  为什么需要它：术语表是**我们**维护的封闭集合，覆盖不到的词就只能靠运气。
 *  而"这个词被我念成什么样"只有本人知道 —— 所以给一个两栏输入，
 *  把判断权交回去：不需要拼音、不需要懂词典格式，写下来就生效。
 *
 *  生效范围与失败方向都在界面上说清楚：
 *   - 保存在**本机浏览器**，随每次转写请求带上去，服务端只用于本次纠正，不落盘、不影响他人；
 *   - 与词典改动共用"单次改动过多就整段不改"的预算（见 server/llm/asr-lexicon.ts 第零遍）；
 *   - 「本页不再自动调整术语」停的是系统的自动改动，**这些自己写的词对仍然生效** ——
 *     文案写"自动"，行为就必须只停"自动"。
 *
 *  PC 与移动共用本组件（同 VoiceCorrectionBar 的口径，不各写一遍）。
 */
import { computed, ref } from 'vue';
import { t as tr } from '../i18n';
import { useUserTerms } from '../composables/useUserTerms';

const { pairs, count, add, remove, clear } = useUserTerms();

const open = ref(false);
const from = ref('');
const to = ref('');
const notice = ref('');
const confirmClear = ref(false);

const full = computed(() => count.value >= 100);

function toggle(): void {
  open.value = !open.value;
  notice.value = '';
  confirmClear.value = false;
}

function submit(): void {
  const result = add(from.value, to.value);
  if (result.ok) {
    from.value = '';
    to.value = '';
    notice.value = '';
    return;
  }
  // 每条理由都是用户能自己改正的事，直接说清是什么、怎么办，不写成"输入无效"
  notice.value =
    result.reason === 'empty' ? tr('两边都要填内容')
      : result.reason === 'same' ? tr('两边一样就不用登记')
        : result.reason === 'tooShort' ? tr('「识别成」至少 2 个字：单字太容易误伤整句')
          : result.reason === 'tooLong' ? tr('一条最多 24 个字，太长的多半是粘了整句话')
            : result.reason === 'duplicate' ? tr('这个写法已经登记过，改它就行')
              : tr('已到 100 条上限，先删掉不用的');
}

function removeAt(at: number): void {
  remove(at);
  notice.value = '';
}

function clearAll(): void {
  if (!confirmClear.value) {
    confirmClear.value = true;
    return;
  }
  clear();
  confirmClear.value = false;
  notice.value = '';
}
</script>

<template>
  <div class="vtp">
    <button type="button" class="vtp__toggle" :aria-expanded="open" @click="toggle">
      <span class="vtp__toggle-label">{{ tr('登记常见误写') }}</span>
      <span v-if="count" class="vtp__count">{{ count }}</span>
      <span class="vtp__caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-if="open" class="vtp__body">
      <form class="vtp__form" @submit.prevent="submit">
        <label class="sr-only" for="vtp-from">{{ tr('识别成的样子') }}</label>
        <input id="vtp-from" v-model="from" maxlength="24" :placeholder="tr('识别成（例：一叶枪）')" autocomplete="off">
        <span class="vtp__arrow" aria-hidden="true">→</span>
        <label class="sr-only" for="vtp-to">{{ tr('应该是') }}</label>
        <input id="vtp-to" v-model="to" maxlength="24" :placeholder="tr('应该是（例：移液枪）')" autocomplete="off">
        <button type="submit" class="vtp__save" :disabled="full && !from.trim()">{{ tr('保存') }}</button>
      </form>
      <p v-if="notice" class="vtp__notice" role="alert">{{ notice }}</p>
      <p v-else-if="full" class="vtp__hint">{{ tr('已到 100 条上限，先删掉不用的') }}</p>

      <ul v-if="count" class="vtp__list">
        <li v-for="(pair, i) in pairs" :key="`${pair.from}-${i}`">
          <span class="vtp__from">{{ pair.from }}</span>
          <span class="vtp__arrow" aria-hidden="true">→</span>
          <span class="vtp__to">{{ pair.to }}</span>
          <button type="button" class="vtp__del" :aria-label="tr('删除这条登记') + `：${pair.from}`" @click="removeAt(i)">
            {{ tr('删除') }}
          </button>
        </li>
      </ul>
      <p v-else class="vtp__empty">{{ tr('还没有登记。写下的词下次说话就生效，保存在这台设备上。') }}</p>

      <p class="vtp__foot">
        {{ tr('保存后随每次语音请求带到服务端，只用于本次改写，并会逐条显示在提示条里。') }}
      </p>
      <button v-if="count" type="button" class="vtp__del vtp__del--all" @click="clearAll">
        {{ confirmClear ? tr('确认清除全部？') : tr('清除全部') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 细线 + 极轻分层，与 VoiceCorrectionBar 同一套克制风格：无渐变、无发光、无大圆角 */
.vtp {
  margin-top: var(--sp-1);
}
.vtp__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px var(--sp-2);
  cursor: pointer;
}
.vtp__toggle:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.vtp__toggle:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.vtp__count {
  color: var(--primary);
  font-variant-numeric: tabular-nums;
}
.vtp__caret {
  color: var(--text-faint);
  font-size: calc(var(--ui-font-size) * 0.84615);
}
.vtp__body {
  margin-top: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-left: 2px solid var(--primary-border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}
.vtp__form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
}
.vtp__form input {
  flex: 1 1 120px;
  min-width: 0;
  font: inherit;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 3px var(--sp-2);
}
.vtp__form input:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
  border-color: var(--primary-border);
}
.vtp__save {
  font: inherit;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 3px var(--sp-3);
  cursor: pointer;
}
.vtp__save:disabled {
  color: var(--text-faint);
  cursor: not-allowed;
}
.vtp__arrow {
  color: var(--text-faint);
}
.vtp__notice {
  margin: var(--sp-1) 0 0;
  color: var(--warn, #b45309);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.vtp__hint,
.vtp__empty,
.vtp__foot {
  margin: var(--sp-1) 0 0;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.vtp__foot {
  color: var(--text-faint);
}
.vtp__list {
  list-style: none;
  margin: var(--sp-2) 0 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.vtp__list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.vtp__from {
  color: var(--text-faint);
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.vtp__to {
  color: var(--text);
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.vtp__del {
  flex-shrink: 0;
  font: inherit;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1px var(--sp-2);
  cursor: pointer;
}
.vtp__del:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.vtp__del--all {
  margin-top: var(--sp-2);
}
@media (prefers-reduced-motion: no-preference) {
  .vtp__toggle,
  .vtp__del,
  .vtp__save {
    transition: border-color 120ms ease, color 120ms ease;
  }
}
</style>
