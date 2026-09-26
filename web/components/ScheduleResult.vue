<script setup lang="ts">
/**
 * 结果与依据区
 * ============================================================================
 *  第一阶段提示词第 4 条：
 *   · 课程结果以可读的卡片或表格呈现
 *   · 展示 数据类型、来源、查询时间
 *   · 区分「实时数据」「脱敏快照」「模拟演示」，不得把后两者称为实时数据
 *
 *  安全约束（§2 前端）：组件**只接受经过校验的结构化数据**，
 *  不把模型返回的任意 HTML 直接插入页面。模型文本一律走 `{{ }}` 插值（自动转义）。
 */
import { computed } from 'vue';
import { useRunStore } from '../stores/run';
import { PERIODS } from '@shared/periods';
import StatusTag from './StatusTag.vue';
import SourceBadge from './SourceBadge.vue';
import type { Tone } from './ui-types';

const store = useRunStore();

const r = computed(() => store.lastResult);

const phaseTag = computed<{ tone: Tone; glyph: string; label: string }>(() => {
  switch (store.phase) {
    case 'idle':
      return { tone: 'neutral', glyph: '○', label: '未开始' };
    case 'running':
      return { tone: 'info', glyph: '◌', label: '查询中' };
    case 'success':
      return { tone: 'ok', glyph: '✓', label: '查询成功' };
    case 'empty':
      return { tone: 'warn', glyph: '▲', label: '无匹配结果' };
    case 'config_insufficient':
      return { tone: 'warn', glyph: '▲', label: '配置不足·结果有条件' };
    case 'error':
      return { tone: 'danger', glyph: '✕', label: '查询失败' };
    default:
      return { tone: 'neutral', glyph: '○', label: '未知' };
  }
});

const REASON_TEXT: Record<string, string> = {
  ok: '已找到排课记录',
  lab_not_found: '系统中没有这个房间号',
  no_class_that_day: '该房间当天没有排课',
  no_class_in_that_period: '该房间当天该节次没有排课',
  lab_not_active: '该房间当前不在开放状态，且当天没有排课',
  timetable_empty: '系统内课表为空'
};

const reasonText = computed(() => (r.value ? REASON_TEXT[r.value.reason] ?? r.value.reason : ''));

function fmtIso(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function weeksText(w: { from: number; to: number; parity: string }): string {
  const p = w.parity === 'odd' ? '单周' : w.parity === 'even' ? '双周' : '每周';
  return `第 ${w.from}-${w.to} 周 · ${p}`;
}

/** 节次条：命中节次用「实心 + 文字计数」表示，未命中用空心，不靠颜色区分 */
const periodBars = computed(() =>
  PERIODS.map((p) => {
    const hit = r.value?.byPeriod?.find((b) => b.periodKey === p.key);
    const count = hit?.count ?? 0;
    return { ...p, count, hit: count > 0 };
  })
);
</script>

<template>
  <section class="res" aria-labelledby="res-h">
    <header class="res__head">
      <h2 id="res-h">结果与依据</h2>
      <StatusTag :tone="phaseTag.tone" :glyph="phaseTag.glyph" :label="phaseTag.label" />
    </header>

    <!-- 初始态 -->
    <div v-if="store.phase === 'idle'" class="placeholder">
      <p>输入一句话后，这里会显示：课程结果、数据依据（来源 / 类型 / 查询时间）。</p>
    </div>

    <!-- 错误态 -->
    <div v-else-if="store.phase === 'error'" class="alert alert--danger" role="alert">
      <StatusTag tone="danger" label="查询失败" />
      <p class="alert__msg">{{ store.error?.message }}</p>
      <p v-if="store.error?.hint" class="alert__hint">建议：{{ store.error.hint }}</p>
      <p class="alert__code">错误码：{{ store.error?.code }}</p>
    </div>

    <template v-else>
      <!-- 配置不足：必须显眼，且说明"这是有条件的结论" -->
      <div v-if="store.phase === 'config_insufficient'" class="alert alert--warn" role="status">
        <StatusTag tone="warn" label="配置不足" />
        <p class="alert__msg">
          {{ r && !r.weekDeterminable ? '无法确定该日期属于第几教学周。' : '课表数据为空。' }}
          下面显示的是按已知数据能给出的**有条件**结果，请勿直接当作最终排课。
        </p>
        <p v-if="r?.weekNote" class="alert__hint">{{ r.weekNote }}</p>
      </div>

      <!-- 无匹配 -->
      <div v-else-if="store.phase === 'empty'" class="alert alert--warn" role="status">
        <StatusTag tone="warn" label="无匹配结果" />
        <p class="alert__msg">{{ reasonText }}。系统没有编造任何课程。</p>
        <div v-if="r?.suggestions?.length" class="suggest">
          <span class="suggest__label">可选房间号：</span>
          <span v-for="s in r.suggestions" :key="s" class="suggest__item">{{ s }}</span>
        </div>
      </div>

      <!-- 命中 -->
      <div v-else-if="store.phase === 'success' && r" class="hit">
        <div class="hit__head">
          <strong class="hit__room">{{ r.labName }}</strong>
          <span class="hit__loc">{{ r.labLocation }}</span>
          <span class="hit__when">{{ r.date }}（{{ r.weekdayLabel }}）</span>
          <StatusTag
            v-if="r.weekNo !== null"
            tone="info"
            :label="`第 ${r.weekNo} 教学周 · ${r.weekNo % 2 === 1 ? '单周' : '双周'}`"
          />
          <StatusTag v-else tone="warn" label="教学周无法确定" />
        </div>

        <div class="bars" role="img" :aria-label="`当天排课分布：${periodBars.map((b) => `${b.label}${b.count}条`).join('，')}`">
          <span
            v-for="b in periodBars"
            :key="b.key"
            class="bar"
            :class="{ 'bar--hit': b.hit }"
            :title="`${b.label} ${b.start}-${b.end}：${b.count} 条`"
          >
            <span class="bar__sym" aria-hidden="true">{{ b.hit ? '▮' : '▯' }}</span>
            <span class="bar__label">{{ b.label.replace('上午第', '上午').replace('下午第', '下午').replace('大节', '') }}</span>
            <span class="bar__count">{{ b.count }}</span>
          </span>
        </div>

        <ul class="lessons">
          <li v-for="(l, i) in r.lessons" :key="`${l.timetableId}-${i}`" class="lesson">
            <div class="lesson__time">
              <span class="lesson__period">{{ l.periodLabel }}</span>
              <span class="lesson__clock">{{ l.startTime }}–{{ l.endTime }}</span>
            </div>
            <div class="lesson__main">
              <span class="lesson__course">{{ l.courseName }}</span>
              <StatusTag v-if="l.merged" tone="info" glyph="⧉" shape="dashed" label="合班" />
            </div>
            <div class="lesson__meta">
              <span>{{ l.teacher }}</span>
              <span class="lesson__sep">·</span>
              <span>{{ l.className }}</span>
              <span class="lesson__sep">·</span>
              <span>{{ weeksText(l.weeks) }}</span>
            </div>
          </li>
        </ul>
      </div>

      <!-- 回答文本（流式） -->
      <div v-if="store.stream" class="answer">
        <h3 class="answer__h">回答</h3>
        <pre class="answer__text">{{ store.stream }}</pre>
      </div>

      <!-- 依据 -->
      <div v-if="r" class="prov">
        <h3 class="prov__h">数据依据</h3>
        <div class="prov__badges">
          <SourceBadge :source-type="r.provenance.sourceType" :engine="store.activeEngine" />
        </div>
        <dl class="prov__list">
          <div class="prov__row">
            <dt>数据类型</dt>
            <dd>{{ r.provenance.sourceLabel }}（{{ r.provenance.sourceType }}）</dd>
          </div>
          <div class="prov__row">
            <dt>数据覆盖</dt>
            <dd>{{ r.provenance.coverage }}</dd>
          </div>
          <div class="prov__row">
            <dt>查询时间</dt>
            <dd>{{ fmtIso(r.provenance.queryTime) }}（{{ r.provenance.timezone }}）</dd>
          </div>
          <div v-if="r.provenance.snapshotAt" class="prov__row">
            <dt>快照导出时间</dt>
            <dd>{{ fmtIso(r.provenance.snapshotAt) }}</dd>
          </div>
          <div v-if="r.provenance.sourceSha256Prefix" class="prov__row">
            <dt>源数据指纹</dt>
            <dd class="prov__mono">sha256 前 16 位：{{ r.provenance.sourceSha256Prefix }}</dd>
          </div>
          <div class="prov__row">
            <dt>查询条件</dt>
            <dd class="prov__mono">
              labName={{ r.labName }}，date={{ r.date }}<template v-if="r.periodFilter">，periodKey={{ r.periodFilter }}</template>
            </dd>
          </div>
        </dl>

        <template v-if="r.notes.length">
          <h4 class="prov__h4">条件说明（必须一并阅读）</h4>
          <ul class="notes">
            <li v-for="(n, i) in r.notes" :key="i">{{ n }}</li>
          </ul>
        </template>
      </div>

      <!-- 无结构化结果时的兜底（例如越界问题） -->
      <div v-else-if="store.phase === 'success' && !store.stream" class="placeholder">
        <p>任务已完成，但本次没有结构化查询结果。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.res {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-1);
}
.res__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.res__head h2 {
  margin: 0;
  font-size: 15px;
}
.placeholder {
  color: var(--text-faint);
  font-size: 13px;
  padding: var(--sp-3) 0;
}
.alert {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--sp-3);
  border-radius: var(--radius);
  margin-bottom: var(--sp-3);
  border: 1px solid;
}
.alert--warn {
  background: var(--warn-bg);
  border-color: var(--warn-border);
  color: var(--warn);
}
.alert--danger {
  background: var(--danger-bg);
  border-color: var(--danger-border);
  color: var(--danger);
}
.alert__msg {
  margin: 0;
  color: var(--text);
  font-size: 13px;
}
.alert__hint,
.alert__code {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.alert__code {
  font-family: var(--font-mono);
}
.suggest {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-size: 12px;
}
.suggest__label {
  color: var(--text-muted);
}
.suggest__item {
  font-family: var(--font-mono);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 6px;
}
.hit__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}
.hit__room {
  font-family: var(--font-mono);
  font-size: 18px;
  letter-spacing: 0.03em;
}
.hit__loc,
.hit__when {
  font-size: 12px;
  color: var(--text-muted);
}
.hit__when {
  font-family: var(--font-mono);
}
.bars {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-faint);
  background: var(--surface-2);
}
.bar--hit {
  border-style: solid;
  border-color: var(--info-border);
  background: var(--info-bg);
  color: var(--info);
}
.bar__sym {
  font-size: 10px;
}
.bar__count {
  font-family: var(--font-mono);
  font-weight: 700;
}
.lessons {
  list-style: none;
  margin: 0 0 var(--sp-4);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.lesson {
  display: grid;
  grid-template-columns: 128px 1fr;
  grid-template-areas: 'time main' 'time meta';
  gap: 2px var(--sp-3);
  padding: var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary-border);
  border-radius: var(--radius);
}
.lesson__time {
  grid-area: time;
  display: flex;
  flex-direction: column;
}
.lesson__period {
  font-size: 12px;
  font-weight: 600;
}
.lesson__clock {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
}
.lesson__main {
  grid-area: main;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.lesson__course {
  font-size: 14px;
  font-weight: 600;
}
.lesson__meta {
  grid-area: meta;
  font-size: 12px;
  color: var(--text-muted);
}
.lesson__sep {
  margin: 0 4px;
  color: var(--text-faint);
}
.answer {
  margin-bottom: var(--sp-4);
}
.answer__h {
  margin: 0 0 var(--sp-2);
  font-size: 13px;
  color: var(--text-muted);
}
.answer__text {
  margin: 0;
  padding: var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-sans);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.prov {
  border-top: 1px dashed var(--border);
  padding-top: var(--sp-3);
}
.prov__h {
  margin: 0 0 var(--sp-2);
  font-size: 13px;
  color: var(--text-muted);
}
.prov__badges {
  margin-bottom: var(--sp-2);
}
.prov__list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.prov__row {
  display: flex;
  gap: var(--sp-3);
  font-size: 12px;
}
.prov__row dt {
  flex: 0 0 96px;
  color: var(--text-faint);
}
.prov__row dd {
  margin: 0;
  color: var(--text-muted);
  word-break: break-word;
}
.prov__mono {
  font-family: var(--font-mono);
}
.prov__h4 {
  margin: var(--sp-3) 0 var(--sp-1);
  font-size: 12px;
  color: var(--text-muted);
}
.notes {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-muted);
}
.notes li {
  margin-bottom: 2px;
}

@media (max-width: 640px) {
  .lesson {
    grid-template-columns: 1fr;
    grid-template-areas: 'time' 'main' 'meta';
  }
  .prov__row {
    flex-direction: column;
    gap: 0;
  }
  .prov__row dt {
    flex: none;
  }
}
</style>
