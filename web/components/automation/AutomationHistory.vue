<script setup lang="ts">
/**
 * 运行历史 —— 详情页里唯一需要"往下翻"的部分
 * ============================================================================
 *  主流 Agent APP 的详情页都把"历史"做成可扫读的时间线：
 *  一行一条，失败项直接给原因，需要时再展开冻结结果。
 *  这里不做虚拟滚动 —— 单条规则的运行记录由后端按条数上限返回。
 */
import { t as tr } from '../../i18n';
import type { AutomationRun } from '../../composables/useAutomation';
import { formatDateTime, statusMeta } from '../../business/automation-format';

defineProps<{ runs: AutomationRun[] }>();

/** 这一轮是不是 Agent 跑的？是就把它用的模型与工具调用数摊开给用户看 */
function copyRunId(id: string): void { void navigator.clipboard?.writeText(id); }
function agentMeta(run: AutomationRun): { model: string; toolCalls: number; runId: string } | null {
  const first = run.frozenPayload?.[0]?.output?.agent;
  if (!first || !first.model) return null;
  return { model: first.model, toolCalls: Number(first.toolCalls ?? 0), runId: String(first.runId ?? '') };
}
</script>

<template>
  <section class="auto-history">
    <h3>{{ tr('运行历史') }}</h3>
    <p v-if="!runs.length" class="auto-history__empty">{{ tr('这条规则还没有运行记录。') }}</p>
    <ol v-else class="auto-history__list">
      <li v-for="run in runs" :key="run.id" class="auto-run" :class="`is-${statusMeta(run.status).tone}`">
        <div class="auto-run__head">
          <b>{{ run.occurrenceLocal || formatDateTime(run.id) }}</b>
          <span class="auto-run__badge" :class="`auto-run__badge--${statusMeta(run.status).tone}`">
            <span aria-hidden="true">{{ statusMeta(run.status).glyph }}</span>{{ tr(statusMeta(run.status).label) }}
          </span>
          <span v-if="run.attempt > 1" class="auto-run__attempt">{{ tr('第') }}{{ run.attempt }}{{ tr('次尝试') }}</span>
        </div>
        <p v-if="agentMeta(run)" class="auto-run__agent">
          {{ tr('由 Agent 执行') }} · {{ agentMeta(run)!.model }} · {{ agentMeta(run)!.toolCalls }}{{ tr(' 次工具调用') }}
          <button v-if="agentMeta(run)!.runId" type="button" class="auto-run__copy" @click="copyRunId(agentMeta(run)!.runId)">
            {{ tr('复制运行号') }}
          </button>
        </p>
        <p v-if="run.error" class="auto-run__error" role="status">{{ run.error }}</p>
        <details v-if="run.frozenPayload?.length || run.resultRefs?.length" class="auto-run__more">
          <summary>{{ tr('查看当时的输出与业务回执') }}</summary>
          <p class="auto-run__rev">{{ tr('来源版本') }} {{ run.sourceRevision || tr('未记录') }}</p>
          <pre v-for="(item, index) in run.frozenPayload" :key="index">{{ item.output.text }}</pre>
          <pre v-if="run.resultRefs?.length">{{ JSON.stringify(run.resultRefs, null, 2) }}</pre>
        </details>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.auto-history h3 {
  margin: 18px 0 8px;
  font-size: 13px;
  color: var(--text-muted);
}
.auto-history__empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.auto-history__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.auto-run {
  border: 1px solid var(--border);
  border-left: 3px solid var(--border-strong);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--surface-2);
}
.auto-run.is-ok {
  border-left-color: var(--ok, #2e7d32);
}
.auto-run.is-danger {
  border-left-style: double;
  border-left-width: 5px;
  border-left-color: var(--danger, #b91c1c);
}
.auto-run.is-warn {
  border-left-style: dashed;
  border-left-color: var(--warning, #a16207);
}
.auto-run__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.auto-run__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
}
.auto-run__badge--ok {
  color: var(--ok, #2e7d32);
}
.auto-run__badge--danger {
  color: var(--danger, #b91c1c);
  border-style: double;
  border-width: 3px;
}
.auto-run__badge--warn {
  color: var(--warning, #a16207);
  border-style: dashed;
}
.auto-run__badge--info {
  color: var(--primary);
}
.auto-run__badge--muted {
  color: var(--text-faint);
  border-style: dashed;
}
.auto-run__attempt {
  font-size: 11px;
  color: var(--text-faint);
}
.auto-run__agent {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted, #5b6470);
}
.auto-run__copy {
  border: 0;
  background: none;
  padding: 0;
  color: var(--primary, #1668dc);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.auto-run__agent {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted, #5b6470);
}
.auto-run__copy {
  border: 0;
  background: none;
  padding: 0;
  color: var(--primary, #1668dc);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.auto-run__error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--danger, #b91c1c);
  overflow-wrap: anywhere;
}
.auto-run__more {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.auto-run__more summary {
  cursor: pointer;
}
.auto-run__rev {
  margin: 4px 0;
  color: var(--text-faint);
}
.auto-run pre {
  margin: 6px 0 0;
  padding: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  max-height: 240px;
  overflow: auto;
}
</style>
