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
import { clientFetch } from '../client';
import { useUserTerms } from '../composables/useUserTerms';
import type { VoiceBias } from '../composables/useVoiceInput';

/** 服务端体检结论的结构（与 server/api/asr-lexicon-report.ts 一一对应） */
interface LexiconReport {
  ok: true;
  builtIn: { terms: number; fingerprint: string; protect: number; ambiguousKeys: number };
  effective: {
    protocol: string;
    contextEnabled: boolean;
    contextMaxChars: number;
    termCorrectEnabled: boolean;
    contextTerms: number;
    contextChars: number;
    omittedFromBudget: number;
  };
  keywords: Array<{ word: string; verdict: string; hotwordFits: boolean; why: string }>;
  pairs: Array<{ from: string; to: string; verdict: string; why: string }>;
  merge: { candidates: Array<Record<string, unknown>>; needPinyin: string[] };
}

const props = defineProps<{
  /** 上一次请求回报的偏置真实状态；没有成功请求过就是 null（面板不许拿"配置开了"代替它） */
  bias?: VoiceBias | null;
  /** 上一次请求实际使用的上游协议，用于判断热词这条路存不存在 */
  protocol?: string;
}>();

const { pairs, count, add, remove, clear, keywords, keywordCount, addKeyword, removeKeyword, clearKeywords } = useUserTerms();

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
  const bias = props.bias;
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
  } else if (props.protocol === 'dashscope_native') {
    parts.push(tr('即时热词本次未发'));
  } else {
    parts.push(tr('当前协议没有热词通道'));
  }
  return parts.join('；') + '。';
});

/** 词汇一变，上一次体检的结论就过期了：宁可重新点一次，也不给一份"看起来还有效"的旧报告 */
function invalidateReport(): void {
  report.value = null;
  reportError.value = '';
  exportText.value = '';
  copyNotice.value = '';
}

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
    invalidateReport();
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
  invalidateReport();
}

function clearAll(): void {
  if (!confirmClear.value) {
    confirmClear.value = true;
    return;
  }
  clear();
  confirmClear.value = false;
  notice.value = '';
  invalidateReport();
}

function submitWord(): void {
  const result = addKeyword(word.value);
  if (result.ok) {
    word.value = '';
    wordNotice.value = '';
    invalidateReport();
    return;
  }
  wordNotice.value =
    result.reason === 'empty' ? tr('先写一个词')
      : result.reason === 'tooShort' ? tr('单个字不必登记：想确定生效，请用上面的「识别成 → 应该是」')
        : result.reason === 'tooLong' ? tr('一个词最多 24 个字')
          : result.reason === 'duplicate' ? tr('这个词已经在列表里')
            : tr('已到 100 条上限，先删掉不用的');
}

function removeWordAt(at: number): void {
  removeKeyword(at);
  wordNotice.value = '';
  invalidateReport();
}

function clearWords(): void {
  if (!confirmClearWords.value) {
    confirmClearWords.value = true;
    return;
  }
  clearKeywords();
  confirmClearWords.value = false;
  wordNotice.value = '';
  report.value = null;
}

// ---------------------------------------------------------------- 体检与导出
const checking = ref(false);
const report = ref<LexiconReport | null>(null);
const reportError = ref('');
const exportText = ref('');
const copyNotice = ref('');

const keywordVerdictLabel = (v: string): string =>
  v === 'in-context' ? tr('已进上下文')
    : v === 'already-in-builtin' ? tr('内置已有')
      : v === 'dropped-by-budget' ? tr('被预算挤掉')
        : v === 'bias-off' ? tr('偏置未开')
          : v;

const pairVerdictLabel = (v: string): string =>
  v === 'active' ? tr('生效')
    : v === 'redundant-with-builtin' ? tr('内置已做')
      : v === 'overrides-builtin-alias' ? tr('覆盖内置')
        : v === 'collides-with-protect' ? tr('撞常用词')
          : v === 'rewrites-a-builtin-term' ? tr('改内置正确词')
            : v;

const reportSummary = computed(() => {
  const r = report.value;
  if (!r) return '';
  return tr(
    '内置 {terms} 条（指纹 {fp}）｜事前偏置 {bias}｜协议 {protocol}｜事后纠错 {correct}'
  , {
    terms: String(r.builtIn.terms),
    fp: r.builtIn.fingerprint,
    bias: r.effective.contextEnabled ? tr('开') : tr('关'),
    protocol: r.effective.protocol,
    correct: r.effective.termCorrectEnabled ? tr('开') : tr('关')
  });
});

/** 体检请求发的是"我登记的词"，服务端拿它对着内置表与配置算结论；它不写任何东西 */
async function runCheck(): Promise<void> {
  checking.value = true;
  reportError.value = '';
  exportText.value = '';
  copyNotice.value = '';
  try {
    const response = await clientFetch('/api/agent/asr-lexicon-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: keywords.value,
        pairs: pairs.value
      })
    });
    const data = (await response.json()) as LexiconReport & { error?: string; message?: string };
    if (!response.ok || data.ok !== true) {
      // 报告拿不到就明说拿不到，不保留上一次的结论冒充现状
      report.value = null;
      reportError.value = data.message ?? tr('体检失败：服务端没有返回结论');
      return;
    }
    report.value = data;
  } catch {
    report.value = null;
    reportError.value = tr('体检失败：请求没发出去（网络或服务未启动）');
  } finally {
    checking.value = false;
  }
}

/**
 * 导出的是**候选**，不是成品：并入 shared/asr-glossary.json 之前必须过
 * `npm run check:asr-lexicon`。缺拼音的词不进 JSON —— 它们没法自检，混进去
 * 只会在装载时把整张表带崩。
 */
function buildExport(): void {
  const r = report.value;
  if (!r) return;
  const payload = {
    note: '面板导出的候选条目。先跑 npm run check:asr-lexicon <本文件> 通过后再并入 shared/asr-glossary.json。',
    terms: r.merge.candidates
  };
  exportText.value = JSON.stringify(payload, null, 2);
  copyNotice.value = r.merge.needPinyin.length
    ? tr('另有 {n} 个词推不出读音，列在下面，需人工补拼音后才可并入。', { n: r.merge.needPinyin.length })
    : '';
}

async function copyExport(): Promise<void> {
  copyNotice.value = '';
  try {
    await navigator.clipboard.writeText(exportText.value);
    copyNotice.value = tr('已复制到剪贴板，存成文件后跑 check:asr-lexicon。');
  } catch {
    copyNotice.value = tr('浏览器不允许直接复制，请在下面框里全选复制。');
  }
}
</script>

<template>
  <div class="vtp">
    <button type="button" class="vtp__toggle" :aria-expanded="open" @click="toggle">
      <span class="vtp__toggle-label">{{ tr('我的语音词汇') }}</span>
      <span v-if="count" class="vtp__count">{{ count }}</span>
      <span class="vtp__caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-if="open" class="vtp__body">
      <p class="vtp__lead">{{ tr('「识别成 → 应该是」会直接改写结果；常用词只是提示模型，可能不生效。') }}</p>
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

      <div class="vtp__section">
        <p class="vtp__section-title">{{ tr('常用词（只填正确写法）') }}</p>
        <form class="vtp__form" @submit.prevent="submitWord">
          <label class="sr-only" for="vtp-word">{{ tr('常用词') }}</label>
          <input id="vtp-word" v-model="word" maxlength="24" :placeholder="tr('例：稳压器、门禁电源')" autocomplete="off">
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

      <div class="vtp__section">
        <p class="vtp__section-title">{{ tr('体检与并入内置表') }}</p>
        <div class="vtp__row">
          <button type="button" class="vtp__save" :disabled="checking || (!count && !keywordCount)" @click="runCheck">
            {{ checking ? tr('体检中…') : tr('体检我的词汇') }}
          </button>
          <button v-if="report" type="button" class="vtp__save" @click="buildExport">{{ tr('导出待并入条目') }}</button>
        </div>
        <p v-if="reportError" class="vtp__notice" role="alert">{{ reportError }}</p>
        <p v-else-if="!count && !keywordCount" class="vtp__hint">{{ tr('登记过词汇之后再体检，能看到每条的真实结论。') }}</p>

        <template v-if="report">
          <p class="vtp__report">{{ reportSummary }}</p>
          <ul v-if="report.keywords.length" class="vtp__verdicts">
            <li v-for="k in report.keywords" :key="k.word">
              <span class="vtp__chip-text">{{ k.word }}</span>
              <b class="vtp__tag">{{ keywordVerdictLabel(k.verdict) }}</b>
              <span class="vtp__why">{{ k.why }}</span>
            </li>
          </ul>
          <ul v-if="report.pairs.length" class="vtp__verdicts">
            <li v-for="p in report.pairs" :key="`${p.from}-${p.to}`">
              <span class="vtp__chip-text">{{ p.from }} → {{ p.to }}</span>
              <b class="vtp__tag">{{ pairVerdictLabel(p.verdict) }}</b>
              <span class="vtp__why">{{ p.why }}</span>
            </li>
          </ul>
          <p class="vtp__hint">
            {{ tr('可并入内置表 {n} 条；缺读音 {m} 条（缺读音的不会出现在导出里）。', {
              n: String(report.merge.candidates.length),
              m: String(report.merge.needPinyin.length)
            }) }}
          </p>
          <p v-if="report.merge.needPinyin.length" class="vtp__needpinyin">{{ report.merge.needPinyin.join('、') }}</p>
        </template>

        <template v-if="exportText">
          <label class="sr-only" for="vtp-export">{{ tr('候选条目 JSON') }}</label>
          <textarea id="vtp-export" class="vtp__export" rows="6" readonly :value="exportText"></textarea>
          <div class="vtp__row">
            <button type="button" class="vtp__save" @click="copyExport">{{ tr('复制') }}</button>
            <span class="vtp__why">{{ tr('存成文件后运行 npm run check:asr-lexicon 文件名，过了再并入。') }}</span>
          </div>
          <p v-if="copyNotice" class="vtp__status" role="status">{{ copyNotice }}</p>
        </template>
      </div>
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
/* 两种词汇的生效方式不同，这句话是唯一能一眼看出差别的地方，别藏进帮助里 */
.vtp__lead {
  margin: 0 0 var(--sp-2);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.vtp__section {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
}
.vtp__section-title {
  margin: 0 0 var(--sp-1);
  color: var(--text);
  font-size: calc(var(--ui-font-size) * 0.92308);
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
  font-size: calc(var(--ui-font-size) * 0.92308);
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
.vtp__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  margin-top: var(--sp-1);
}
.vtp__verdicts {
  list-style: none;
  margin: var(--sp-2) 0 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.vtp__verdicts li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
}
/* 结论用细边框小标签，不用色块：一屏十几条时色块会把"原因"压掉 */
.vtp__tag {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 5px;
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
}
.vtp__why {
  flex: 1 1 160px;
  min-width: 0;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
/* 体检区自己的两段结论，用独立类名：共用 .vtp__status/.vtp__foot 会让"第几段"变成选择器题 */
.vtp__report {
  margin: var(--sp-2) 0 0;
  color: var(--text);
  font-size: calc(var(--ui-font-size) * 0.92308);
  overflow-wrap: anywhere;
}
.vtp__needpinyin {
  margin: var(--sp-1) 0 0;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
  overflow-wrap: anywhere;
}
.vtp__export {
  width: 100%;
  box-sizing: border-box;
  margin-top: var(--sp-2);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-2);
  resize: vertical;
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
