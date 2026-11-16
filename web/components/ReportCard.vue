<script setup lang="ts">
import {t as tr} from "../i18n";
/**
 * 运营日报卡 —— create_operations_report 的结构化产物
 * ============================================================================
 *  口径纪律：缺失数据源的指标如实标「未知」+ 原因，绝不显示为 0；
 *  报告是当前用户可见的草稿产物，未自动发布给他人。
 */
import { computed } from 'vue';
import type { OperationsReportResult } from '@shared/types';
import StatusTag from './StatusTag.vue';

const props = defineProps<{ report: OperationsReportResult }>();

const rangeText = computed(() =>
  props.report.range.startDate === props.report.range.endDate
    ? props.report.range.startDate
    : `${props.report.range.startDate} ~ ${props.report.range.endDate}`
);
</script>

<template>
  <section class="report" :aria-label="tr('运营日报草稿')">
    <header class="report__head">
      <StatusTag tone="info" glyph="▤" label="运营日报草稿" />
      <span class="report__range">{{ rangeText }}</span>
      <span class="report__id">{{ report.reportId }}</span>
    </header>

    <ul class="report__metrics">
      <li v-for="m in report.metrics" :key="m.key" :data-status="m.status">
        <span class="report__label">{{ m.label }}</span>
        <span v-if="m.status === 'known'" class="report__value">{{ m.value }} {{ m.unit }}</span>
        <span v-else class="report__unknown" :title="m.note">{{tr("未知 ·")}} {{ m.note }}</span>
      </li>
    </ul>

    <details class="report__prov">
      <summary>{{tr("统计口径与数据来源")}}</summary>
      <ul class="report__notes">
        <li v-for="(e, i) in report.evidence" :key="i">[{{ e.section }}] {{ e.sourceLabel }}{{ e.note ? `（${e.note}）` : '' }}</li>
        <li v-for="(n, i) in report.notes" :key="`n${i}`">{{ n }}</li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.report {
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  background: var(--surface-2);
  border-radius: var(--radius);
  padding: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.report__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.report__range {
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.report__id {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.report__metrics {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.report__metrics li {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: calc(var(--ui-font-size) * 1.0);
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px var(--sp-2);
}
.report__label {
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.report__value {
  font-family: var(--font-mono);
  font-weight: 700;
}
.report__unknown {
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-faint);
}
.report__prov {
  font-size: calc(var(--ui-font-size) * 0.84615);
}
.report__prov summary {
  cursor: pointer;
  color: var(--text-faint);
  user-select: none;
}
.report__notes {
  margin: var(--sp-1) 0 0;
  padding-left: 18px;
  color: var(--text-faint);
}
</style>
