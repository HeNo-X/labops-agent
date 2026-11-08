<script setup lang="ts">
/**
 * 自动化任务卡片 —— 对标主流 Agent APP 的列表项
 * ============================================================================
 *  一张卡只回答四个问题：这是什么 / 多久一次 / 下次什么时候 / 现在开着吗。
 *  其余信息（参数、审计、运行历史）全部进入详情，不占列表。
 *
 *  无障碍：状态不只靠颜色 —— 符号 + 文案 + 边框样式三重编码。
 */
import { computed, ref } from 'vue';
import { t as tr } from '../../i18n';
import UiIcon from '../UiIcon.vue';
import type { AutomationJob } from '../../composables/useAutomation';
import {
  calendarText,
  canToggle,
  isOn,
  kindHint,
  nextRunText,
  statusMeta,
  triggerText
} from '../../business/automation-format';

const props = defineProps<{
  job: AutomationJob;
  templates: Record<string, string>;
  busy?: boolean;
  readonly?: boolean;
}>();

const emit = defineEmits<{ open: []; toggle: []; delete: [] }>();

const status = computed(() => statusMeta(props.job.displayStatus || props.job.status));
// 历史记录删除（高危低频）：仅已完成/已归档可删；两步确认防误触
const confirmDel = ref(false);
let delTimer: ReturnType<typeof setTimeout> | undefined;
const deletable = computed(() => !props.readonly && props.job.canManage && (props.job.displayStatus === 'completed' || props.job.status === 'archived'));
function askDelete(): void {
  if (!confirmDel.value) {
    confirmDel.value = true;
    delTimer = setTimeout(() => { confirmDel.value = false; }, 4000);
    return;
  }
  clearTimeout(delTimer);
  confirmDel.value = false;
  emit('delete');
}
// B：maxRuns 用尽后 displayStatus=completed——开关按 displayStatus 判定（OFF+不可点），
// 否则会出现"卡片说已完成、开关却是开的"的自相矛盾
const on = computed(() => isOn(props.job.displayStatus || props.job.status));
const toggleEnabled = computed(() => !props.readonly && props.job.canManage && canToggle(props.job.displayStatus || props.job.status));
const title = computed(() => props.job.spec.name || props.templates[props.job.spec.kind] || props.job.spec.kind);
const hint = computed(() => kindHint(props.job.spec.kind));
const lastText = computed(() => {
  if (!props.job.lastRunAt) return '还没有运行过';
  const meta = statusMeta(props.job.lastRunStatus);
  return `最近一次 ${formatShort(props.job.lastRunAt)} ${meta.label}`;
});

function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
}
</script>

<template>
  <article class="auto-card" :class="[`is-${status.tone}`, { 'is-off': !on }]">
    <button type="button" class="auto-card__main" :disabled="!job.canViewDetails && !job.canManage" @click="emit('open')">
      <span class="auto-card__title">
        <UiIcon name="clock" :size="14" />
        <b>{{ title }}</b>
        <span v-if="job.spec.execMode === 'agent'" class="auto-chip">{{ tr('Agent 执行') }}</span>
        <span class="auto-badge" :class="`auto-badge--${status.tone}`">
          <span aria-hidden="true">{{ status.glyph }}</span>{{ tr(status.label) }}
        </span>
      </span>
      <span class="auto-card__hint">{{ tr(hint) }}</span>
      <span class="auto-card__meta">
        {{ tr(triggerText(job.spec)) }} · {{ tr(calendarText(job.spec.calendarPolicy)) }}
      </span>
      <span class="auto-card__meta auto-card__meta--next">
        {{ job.displayStatus === 'completed' ? tr('已按次数完成，历史保留') : on ? tr('下次') + ' ' + tr(nextRunText(job.nextRunAt)) : tr('已暂停，不会自动运行') }}
      </span>
      <span class="auto-card__meta auto-card__meta--last">{{ tr(lastText) }}</span>
    </button>

    <button
      v-if="deletable"
      type="button"
      class="auto-card__del"
      :class="{ 'is-arming': confirmDel }"
      :disabled="busy"
      @click="askDelete"
    >
      {{ confirmDel ? tr('再点一次确认删除') : tr('删除记录') }}
    </button>
    <label v-if="toggleEnabled" class="auto-switch" :title="tr(on ? '暂停此自动化' : '恢复此自动化')">
      <input type="checkbox" role="switch" :checked="on" :disabled="busy" @change.prevent="emit('toggle')" />
      <span class="auto-switch__track" aria-hidden="true"><span class="auto-switch__dot" /></span>
      <span class="sr-only">{{ tr(on ? '暂停此自动化' : '恢复此自动化') }}</span>
    </label>
    <span v-else class="auto-switch auto-switch--locked" :title="tr('当前身份不能修改此规则')">
      <span class="auto-switch__track" :class="{ 'is-on': on }" aria-hidden="true"><span class="auto-switch__dot" /></span>
    </span>
  </article>
</template>

<style scoped>
.auto-card {
  display: flex;
  align-items: stretch;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: 10px;
  background: var(--surface-2);
  transition: border-color 0.12s, background 0.12s;
}
.auto-card:hover {
  border-color: var(--border-strong);
  background: var(--surface);
}
/* 状态不只靠颜色：左侧边框 + 虚线/实线 + 符号 */
.auto-card.is-ok {
  border-left-color: var(--ok, #2e7d32);
}
.auto-card.is-warn {
  border-left-style: dashed;
  border-left-color: var(--warning, #a16207);
}
.auto-card.is-danger {
  border-left-style: double;
  border-left-width: 5px;
  border-left-color: var(--danger, #b91c1c);
}
.auto-card.is-info {
  border-left-color: var(--primary);
}
.auto-card__del {
  align-self: center;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-muted);
  border-radius: 8px;
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.auto-card__del:hover {
  color: var(--danger, #b91c1c);
  border-color: var(--danger, #b91c1c);
}
.auto-card__del.is-arming {
  color: #fff;
  background: var(--danger, #b91c1c);
  border-color: var(--danger, #b91c1c);
}
.auto-card.is-muted,
.auto-card.is-off {
  border-left-color: var(--border-strong);
  opacity: 0.86;
}
.auto-card__main {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 3px;
  background: none;
  border: 0;
  padding: 0;
  text-align: left;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.auto-card__main:disabled {
  cursor: default;
}
.auto-chip {
  padding: 1px 6px;
  border-radius: 6px;
  border: 1px solid var(--primary-border, #b9d4ff);
  background: var(--primary-weak, #eef4ff);
  color: var(--primary, #1668dc);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
}
.auto-card__title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 14px;
}
.auto-card__hint {
  font-size: 12px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.auto-card__meta {
  font-size: 12px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.auto-card__meta--next {
  color: var(--text-muted);
}
.auto-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}
.auto-badge--ok {
  color: var(--ok, #2e7d32);
  background: color-mix(in srgb, var(--ok, #2e7d32) 12%, transparent);
}
.auto-badge--warn {
  color: var(--warning, #a16207);
  border-style: dashed;
  background: color-mix(in srgb, var(--warning, #a16207) 12%, transparent);
}
.auto-badge--danger {
  color: var(--danger, #b91c1c);
  border-style: double;
  border-width: 3px;
  background: color-mix(in srgb, var(--danger, #b91c1c) 12%, transparent);
}
.auto-badge--info {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 12%, transparent);
}
.auto-badge--muted {
  color: var(--text-faint);
  border-style: dashed;
}

/* 开关：主流 Agent APP 的形态，44px 触控区 */
.auto-switch {
  flex: 0 0 auto;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
  position: relative;
}
.auto-switch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: pointer;
}
.auto-switch__track {
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: var(--border-strong);
  border: 1px solid transparent;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  transition: background 0.15s;
}
.auto-switch__dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transform: translateX(0);
  transition: transform 0.15s;
}
.auto-switch input:checked + .auto-switch__track,
.auto-switch__track.is-on {
  background: var(--primary);
}
.auto-switch input:checked + .auto-switch__track .auto-switch__dot,
.auto-switch__track.is-on .auto-switch__dot {
  transform: translateX(18px);
  background: var(--primary-contrast);
}
.auto-switch input:disabled + .auto-switch__track {
  opacity: 0.6;
}
.auto-switch input:focus-visible + .auto-switch__track {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.auto-switch--locked {
  cursor: not-allowed;
  opacity: 0.5;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
</style>
