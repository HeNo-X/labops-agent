<script setup lang="ts">
import { computed } from 'vue';
import { t as tr } from '../i18n';
/**
 * 签到结果卡 —— query_checkin_status / query_checkin_summary 的结构化产物
 * ============================================================================
 *  口径纪律（与工具 description / 回答正文一致）：
 *    · 本人状态卡只转述主系统服务端判定；签到入口是路径文本（须本人在场完成，
 *      Agent 不代签）；
 *    · 汇总卡（仅管理员）账面缺口与未签到学号名单分列，名单与账面不一致时转述 note；
 *    · 取不到的数据不编造：note / null 一律如实呈现。
 *  桌面专用（与 OperationCard/ReportCard 同约定：移动端会话不渲染工具卡）。
 */
import type { CheckinStatusResult, CheckinSummaryResult, CheckinStatusLesson } from '@shared/types';
import type { Tone } from './ui-types';
import StatusTag from './StatusTag.vue';

const props = defineProps<{
  kind: 'checkin_status' | 'checkin_summary';
  result: CheckinStatusResult | CheckinSummaryResult;
}>();

const status = computed(() => (props.kind === 'checkin_status' ? (props.result as CheckinStatusResult) : null));
const summary = computed(() => (props.kind === 'checkin_summary' ? (props.result as CheckinSummaryResult) : null));

function lessonTone(l: CheckinStatusLesson): Tone {
  if (l.status === 'signed_out') return 'info';
  if (l.status === 'signed') return 'ok';
  if (l.phase === 'open') return 'warn';
  if (l.phase === 'ended') return 'danger';
  return 'neutral';
}
function lessonLabel(l: CheckinStatusLesson): string {
  if (l.status === 'signed_out') return l.autoSignout ? tr('已签退（自动）') : tr('已签退');
  if (l.status === 'signed') return l.lateSignin ? tr('已签到（补签到）') : tr('已签到');
  if (l.phase === 'open') return l.lateWindow ? tr('未签到 · 现在签记补签到') : tr('未签到 · 可签');
  if (l.phase === 'ended') return tr('未签到 · 节次已结束');
  if (l.phase === 'upcoming') return tr('未签到 · 未到可签时间');
  return tr('未签到');
}
function flagsOf(l: CheckinStatusLesson): string {
  const flags: string[] = [];
  if (l.mismatch) flags.push(tr('扫错实验室'));
  if (l.locationFailed) flags.push(tr('定位失败'));
  return flags.join(' · ');
}
</script>

<template>
  <!-- 本人签到状态卡 -->
  <section v-if="status" class="ckcard" :aria-label="tr('本人签到状态')">
    <header class="ckcard__head">
      <StatusTag tone="info" :label="tr('本人签到状态')" />
      <span class="ckcard__meta">{{ status.date }}<template v-if="status.currentPeriod"> · {{ status.currentPeriod.label }} {{ status.currentPeriod.start }}–{{ status.currentPeriod.end }}</template></span>
    </header>
    <p v-if="status.note" class="ckcard__note">{{ status.note }}</p>
    <p v-else-if="!status.lessons.length" class="ckcard__note">{{ tr('该日期没有本人的课程安排。') }}</p>
    <ul v-else class="ckcard__list">
      <li v-for="l in status.lessons" :key="l.timetableId + l.periodKey" class="ckcard__row">
        <StatusTag :tone="lessonTone(l)" :label="lessonLabel(l)" />
        <span class="ckcard__main">
          <span class="ckcard__title">{{ l.periodLabel || l.periodKey }}｜{{ l.courseName || tr('未录入') }}｜{{ l.labName || tr('实验室未录入') }}</span>
          <span class="ckcard__sub">{{ l.start && l.end ? l.start + '–' + l.end : tr('时间未录入') }}<template v-if="flagsOf(l)"> · {{ flagsOf(l) }}</template></span>
        </span>
      </li>
    </ul>
    <p v-if="status.lessons.some(l => l.status === 'unsigned' && l.phase === 'open' && l.checkinPath)" class="ckcard__entry">
      {{ tr('签到入口：') }}<code class="ckcard__path">{{ status.lessons.find(l => l.status === 'unsigned' && l.phase === 'open')?.checkinPath }}</code>
      <span class="ckcard__hint">{{ tr('（在主系统打开；须本人在场完成）') }}</span>
    </p>
    <footer class="ckcard__foot">{{ tr('Agent 不代签：签到须本人在实验室现场完成，扫码主链不变。') }}</footer>
  </section>

  <!-- 签到汇总卡（仅管理员） -->
  <section v-else-if="summary" class="ckcard" :aria-label="tr('签到汇总')">
    <header class="ckcard__head">
      <StatusTag tone="info" :label="tr('签到汇总')" />
      <span class="ckcard__meta">{{ summary.date }}<template v-if="summary.scope.labId"> · {{ summary.scope.labId }}</template><template v-if="summary.scope.periodKey"> · {{ summary.scope.periodKey }}</template></span>
    </header>
    <p class="ckcard__totals">
      {{ tr('应到') }} {{ summary.totals.unknownExpected ? summary.totals.expected + '+' : summary.totals.expected }}<template v-if="summary.totals.unknownExpected">（{{ summary.totals.unknownExpected }} {{ tr('节应到未知') }}）</template>
      · {{ tr('已签到') }} {{ summary.totals.checkedIn }}
      · {{ tr('账面缺口') }} {{ summary.totals.absent }}
      · {{ tr('签退') }} {{ summary.totals.checkedOut }} · {{ tr('补签到') }} {{ summary.totals.late }} · {{ tr('扫错实验室') }} {{ summary.totals.mismatch }} · {{ tr('定位失败') }} {{ summary.totals.locationFailed }}
    </p>
    <p v-if="!summary.sessions.length" class="ckcard__note">{{ tr('所选范围内没有排课。') }}</p>
    <ul v-else class="ckcard__list">
      <li v-for="s in summary.sessions" :key="s.timetableId" class="ckcard__row">
        <StatusTag :tone="s.expected === null ? 'neutral' : (s.absentCount ?? 0) > 0 ? 'warn' : 'ok'" :label="s.expected === null ? tr('应到未知') : (s.absentCount ?? 0) > 0 ? tr('有缺口') : tr('无账面缺口')" />
        <span class="ckcard__main">
          <span class="ckcard__title">{{ s.periodLabel || s.periodKey }}｜{{ s.courseName || tr('未录入') }}｜{{ s.labName || tr('实验室未录入') }}｜{{ s.classNames.join('、') || tr('班级未录入') }}</span>
          <span class="ckcard__sub">
            {{ tr('应到') }} {{ s.expected ?? tr('未知') }} · {{ tr('已签到') }} {{ s.checkedIn }}<template v-if="s.absentCount !== null"> · {{ tr('账面缺口') }} {{ s.absentCount }}</template><template v-if="s.checkedOut"> · {{ tr('已签退') }} {{ s.checkedOut }}</template><template v-if="s.late"> · {{ tr('补签到') }} {{ s.late }}</template>
          </span>
          <span v-if="s.absentUsernames && s.absentUsernames.length" class="ckcard__ids">{{ tr('未签到学号：') }}{{ s.absentUsernames.join('、') }}</span>
          <span v-if="s.note" class="ckcard__sub ckcard__sub--note">{{ s.note }}</span>
        </span>
      </li>
    </ul>
    <footer class="ckcard__foot">{{ tr('缺口=应到−实到的账面差，需现场核实后再定性；请勿代替学生签到。未签到名单为学号（账号），不含姓名。') }}</footer>
  </section>
</template>

<style scoped>
.ckcard {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2, 8px);
  padding: 12px;
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  background: var(--surface, #fafafa);
}
.ckcard__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ckcard__meta {
  color: var(--text-dim, #666);
  font-size: 12px;
}
.ckcard__totals {
  margin: 0;
  font-size: 13px;
  color: var(--text, #222);
}
.ckcard__note {
  margin: 0;
  font-size: 13px;
  color: var(--text-dim, #666);
}
.ckcard__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ckcard__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ckcard__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ckcard__title {
  font-size: 13px;
  color: var(--text, #222);
}
.ckcard__sub {
  font-size: 12px;
  color: var(--text-dim, #666);
}
.ckcard__sub--note {
  color: var(--warn-text, #8a6d3b);
}
.ckcard__ids {
  font-size: 12px;
  color: var(--text, #222);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}
.ckcard__entry {
  margin: 0;
  font-size: 12px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: baseline;
}
.ckcard__path {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface-2, #f0f0f0);
}
.ckcard__hint {
  color: var(--text-dim, #666);
}
.ckcard__foot {
  font-size: 12px;
  color: var(--text-dim, #666);
  border-top: 1px dashed var(--border, #ddd);
  padding-top: 8px;
}
</style>
