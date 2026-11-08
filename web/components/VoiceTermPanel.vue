<script setup lang="ts">
/**
 * 「常用语音热词」面板 —— 说话的人把自己的词交给系统，下次识别就用上
 * 入口挂在 设置 → 个性化：它是一份长期生效的个人配置，贴在输入条下方容易被当成一次性提示。
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
import { lastAsrBias, lastAsrProtocol } from '../composables/useVoiceInput';

const props = defineProps<{
  /**
   * 嵌入态（挂在 设置 → 个性化 里）：折叠头由设置的分栏承担，面板直接摊开内容。
   * 独立态（默认）留给其它调用点，保持原来的"收起只占一行"行为。
   */
  embedded?: boolean;
}>();

const { pairs, count, add, remove, clear, keywords, keywordCount, addKeyword, removeKeyword, clearKeywords } = useUserTerms();

// 独立态默认收起（这是它当初的设计：不占输入区空间）；嵌入设置时由 embedded 直接摊开
const open = ref(false);
const from = ref('');
const to = ref('');
const notice = ref('');
const confirmClear = ref(false);
const word = ref('');
const wordNotice = ref('');
const confirmClearWords = ref(false);

const full = computed(() => count.value >= 100);

/**
 * 常用词的真实去向。四种说法对应四种事实，绝不用"已保存"糊弄成"已生效"：
 *   没成功识别过 / 开关关着没发 / 发出去了（含降级与预算挤掉）/ 用户自己叫停了。
 */
const keywordStatus = computed(() => {
  const n = keywordCount.value;
  if (!n) return tr('还没有登记常用词。');
  const bias = lastAsrBias.value;
  if (!bias) return tr('已登记 {n} 个常用词，但还没有一次成功的识别可以依据。', { n });
  if (bias.suppressedByUser === true) return tr('本页已叫停自动调整，{n} 个常用词这次没有发给模型。', { n });
  const sent = bias.context === true;
  if (!sent) return tr('已登记 {n} 个常用词，但本次未发给模型：服务端事前偏置当前是关的（收益未量化）。', { n });
  const parts = [
    tr('本次已把常用词连同内置词表发给模型：上下文 {chars} 字、{terms} 个词', {
      chars: String(Number(bias.contextChars ?? 0)),
      terms: String(Number(bias.termsInContext ?? 0))
    })
  ];
  const omitted = Number(bias.omittedFromBudget ?? 0);
  if (omitted > 0) parts.push(tr('预算挤掉 {n} 个', { n: String(omitted) }));
  if (bias.degraded === true) parts.push(tr('上游不收增强参数，已降级重发'));
  if (bias.hotwords === true) {
    parts.push(tr('即时热词已发出 {n} 条（该字段实测被上游接受，但权重区间未证实）', {
      n: String(Number(bias.hotwordCount ?? 0))
    }));
  } else if (lastAsrProtocol.value === 'dashscope_native') {
    parts.push(tr('即时热词本次未发'));
  } else {
    parts.push(tr('当前协议没有热词通道'));
  }
  return parts.join('；') + '。';
});

function toggle(): void {
  if (props.embedded) return; // 嵌入态没有折叠头，防键盘触发出一条不存在的交互
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
        : result.reason === 'tooShort' ? tr('「错误词」至少 2 个字：单字太容易误伤整句')
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

function submitWord(): void {
  const result = addKeyword(word.value);
  if (result.ok) {
    word.value = '';
    wordNotice.value = '';
    return;
  }
  wordNotice.value =
    result.reason === 'empty' ? tr('先写一个词')
      : result.reason === 'tooShort' ? tr('单个字不必登记：想确定生效，请用上面的「错误纠正示例」')
        : result.reason === 'tooLong' ? tr('一个词最多 24 个字')
          : result.reason === 'duplicate' ? tr('这个词已经在列表里')
            : tr('已到 100 条上限，先删掉不用的');
}

function removeWordAt(at: number): void {
  removeKeyword(at);
  wordNotice.value = '';
}

function clearWords(): void {
  if (!confirmClearWords.value) {
    confirmClearWords.value = true;
    return;
  }
  clearKeywords();
  confirmClearWords.value = false;
  wordNotice.value = '';
}
</script>

<template>
  <div class="vtp" :class="{ 'vtp--embedded': embedded }">
    <button v-if="!embedded" type="button" class="vtp__toggle" :aria-expanded="open" @click="toggle">
      <span class="vtp__toggle-label">{{ tr('常用语音热词') }}</span>
      <span v-if="count" class="vtp__count">{{ count }}</span>
      <span class="vtp__caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-if="open || embedded" class="vtp__body">
      <p class="vtp__intro">{{ tr('这里放两份词：一份确定改写识别结果，一份只是提醒模型该听成什么。两份都存在本机浏览器，随每次语音请求带到服务端，不保存音频，也不影响其他人。') }}</p>
      <p class="vtp__lead">{{ tr('改这里只影响之后的语音输入；文字输入不受影响，识别出的音频内容也不会被留存。') }}</p>
      <p class="vtp__section-title">{{ tr('错误纠正示例') }}</p>
      <p class="vtp__lead">{{ tr('识别时把「错误词」整串换成「纠正词」，确定生效；每条都能单独删除。') }}</p>
      <form class="vtp__form" @submit.prevent="submit">
        <label class="vtp__field" for="vtp-from">{{ tr('错误词') }}
          <input id="vtp-from" v-model="from" maxlength="24" :placeholder="tr('（例：第五幺七）')" autocomplete="off">
        </label>
        <span class="vtp__arrow" aria-hidden="true">→</span>
        <label class="vtp__field" for="vtp-to">{{ tr('纠正词') }}
          <input id="vtp-to" v-model="to" maxlength="24" :placeholder="tr('（例：D517）')" autocomplete="off">
        </label>
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
        {{ tr('下一次长按说话就生效；提示条会逐条列出改了哪几处，也可以一键还原原文。') }}
      </p>
      <button v-if="count" type="button" class="vtp__del vtp__del--all" @click="clearAll">
        {{ confirmClear ? tr('确认清除全部？') : tr('清除全部') }}
      </button>

      <div class="vtp__section">
        <p class="vtp__section-title">{{ tr('常用词（只填正确写法）') }}</p>
        <p class="vtp__lead">{{ tr('这类词不改写已经识别出来的字，只是提醒模型该听成什么。收益没在真实录音上量化过，所以服务端事前偏置默认关着：关着时它们不会发给模型，下面的状态行会照实说明发没发。') }}</p>
        <form class="vtp__form" @submit.prevent="submitWord">
          <label class="sr-only" for="vtp-word">{{ tr('常用词') }}</label>
          <input id="vtp-word" v-model="word" maxlength="24" :placeholder="tr('例：E310、巡查、巡检')" autocomplete="off">
          <button type="submit" class="vtp__save">{{ tr('添加') }}</button>
        </form>
        <p v-if="wordNotice" class="vtp__notice" role="alert">{{ wordNotice }}</p>
        <ul v-if="keywordCount" class="vtp__chips">
          <li v-for="(item, i) in keywords" :key="`${item}-${i}`">
            <span class="vtp__chip-text">{{ item }}</span>
            <button type="button" class="vtp__chip-del" :aria-label="tr('删除这个常用词') + `：${item}`" @click="removeWordAt(i)">×</button>
          </li>
        </ul>
        <p class="vtp__status" role="status">{{ keywordStatus }}</p>
        <button v-if="keywordCount" type="button" class="vtp__del vtp__del--all" @click="clearWords">
          {{ confirmClearWords ? tr('确认清除全部常用词？') : tr('清除全部常用词') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 细线 + 极轻分层，与 VoiceCorrectionBar 同一套克制风格：无渐变、无发光、无大圆角 */
.vtp {
  margin-top: var(--sp-1);
}
/* 嵌入设置面板时去掉自己那层边框感，靠设置的分隔线呼吸 */
.vtp--embedded {
  margin-top: 0;
}
.vtp--embedded .vtp__body {
  border: 0;
  border-left: 0;
  padding: 0;
  background: transparent;
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
/* 两种词汇的生效方式不同，这句话是唯一能一眼看出差别的地方，别藏进帮助里 */
/* 关键文本跟设置面板同字号（现在默认 15px），解释性文本统一降一档 */
.vtp__intro {
  margin: 0 0 var(--sp-3);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.84615);
  line-height: 1.6;
}
.vtp__lead {
  margin: 0 0 var(--sp-2);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.84615);
  line-height: 1.6;
}
.vtp__field {
  display: grid;
  gap: 3px;
  flex: 1 1 120px;
  min-width: 0;
  color: var(--text);
  font-size: var(--ui-font-size);
}
.vtp__section {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}
/* 小节标题不该盖过外层入口标题（设置里的 h3）：用同一档字号 + 加粗区分层级，
   关键文本（字段名、词条）跟它齐平，解释文本再降一档 */
.vtp__section-title {
  margin: 0 0 var(--sp-1);
  color: var(--text);
  font-size: var(--ui-font-size);
  font-weight: 600;
}
.vtp__chips {
  list-style: none;
  margin: var(--sp-1) 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.vtp__chips li {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 1px 2px 1px var(--sp-2);
}
.vtp__chip-text {
  font-size: var(--ui-font-size);
  overflow-wrap: anywhere;
}
.vtp__chip-del {
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font: inherit;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.vtp__chip-del:hover {
  color: var(--text);
}
.vtp__status {
  margin: var(--sp-2) 0 0;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
  overflow-wrap: anywhere;
}
.vtp__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--sp-1);
}
/* 两处输入框同一套盒模型（常用词与错误/纠正词外观一致），并为对齐提供固定高度：
   箭头与保存按钮按输入行底部对齐后，再靠同高盒子在行内垂直居中 */
.vtp__form input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  height: 32px;
  font-size: var(--ui-font-size);
  font-family: inherit;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-2);
}
/* 常用词输入没有字段名包裹，直接作为表单子项占满剩余宽度 */
.vtp__form > input {
  flex: 1 1 160px;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 var(--sp-3);
  box-sizing: border-box;
  cursor: pointer;
}
.vtp__save:disabled {
  color: var(--text-faint);
  cursor: not-allowed;
}
.vtp__arrow {
  color: var(--text-faint);
}
/* 只修表单里的箭头：列表里的箭头保持基线对齐 */
.vtp__form .vtp__arrow {
  display: inline-flex;
  align-items: center;
  height: 32px;
  line-height: 1;
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
