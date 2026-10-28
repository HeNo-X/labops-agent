<script setup lang="ts">
/**
 * PC-2 右栏 artifact 面板 —— 桌面范式：中央消息流 + 右侧钉住画布
 * ============================================================================
 *  · 内容：当前"最新待确认方案"或"最新回执"（从当前会话消息的 business_plan
 *    toolCalls 派生），用户在长会话里滚动时方案不丢。
 *  · 与房间清单互斥共用右栏轨道（App 侧裁决 sideView: 'plan' | 'rooms'）。
 *  · 产生待确认方案时 App 自动把 sideView 切到 plan（钉住）；确认后本面板
 *    展示回执；"查看会话位置"回跳到消息流对应卡片。
 *  · 内联卡仍保留（旧路径不删）：面板只是镜像视图，操作走同一 controller。
 */
import { computed, watch } from 'vue';
import { t as tr } from '../i18n';
import { useSessionStore } from '../stores/session';
import type { BusinessPlanResult } from '@shared/types';
import BusinessPlanCard from './BusinessPlanCard.vue';

const session = useSessionStore();
const emit = defineEmits<{ locate: [messageId: string]; 'plan-arrived': [messageId: string] }>();

interface PlanEntry {
  messageId: string;
  key: string;
  result: BusinessPlanResult;
  /** 该卡当前所处阶段（从 result.plan/receipt 推断，卡片自身是实时状态源） */
  phase: 'awaiting' | 'receipt' | 'info';
}

/** 当前会话里所有业务卡（含历史），最新在前 */
const entries = computed<PlanEntry[]>(() => {
  const out: PlanEntry[] = [];
  for (const m of [...session.currentMessages].reverse()) {
    if (m.role !== 'assistant') continue;
    for (const t of m.toolCalls ?? []) {
      if (t.resultKind === 'business_plan' && t.result) {
        const r = t.result as BusinessPlanResult;
        const phase: PlanEntry['phase'] = r.plan
          ? r.plan.state === 'awaiting_confirmation'
            ? 'awaiting'
            : 'receipt'
          : 'info';
        out.push({ messageId: m.id, key: t.toolCallId, result: r, phase });
      }
    }
  }
  return out;
});

/** 面板主体：优先最新的待确认方案；没有则展示最新回执；再没有展示最新业务卡 */
const pinned = computed<PlanEntry | null>(() => {
  if (!entries.value.length) return null;
  return entries.value.find((e) => e.phase === 'awaiting') ?? entries.value[0]!;
});

const awaitingCount = computed(() => entries.value.filter((e) => e.phase === 'awaiting').length);

// 待确认数从 0 → ≥1 时提示 App 钉住（App 侧决定是否切换 sideView）
const justArrived = watch(
  awaitingCount,
  (n, old) => {
    if (n > 0 && (old ?? 0) === 0) emit('plan-arrived', pinned.value?.messageId ?? '');
  }
);
void justArrived;

function title(e: PlanEntry): string {
  const view = e.result.view;
  const names: Record<string, string> = {
    schedule: '调课方案',
    duty: '值班交接',
    issues: '报修工单',
    notifications: '通知发布',
    closures: '房间停用',
    incidents: '事件处置',
    report: '运营日报'
  };
  return names[view ?? ''] ?? '业务办理';
}
</script>

<template>
  <div class="planpane">
    <header class="planpane__head">
      <h2 class="planpane__h">{{ tr('办理单') }}</h2>
      <span v-if="awaitingCount" class="planpane__badge">{{ tr('待确认') }} {{ awaitingCount }}</span>
      <span v-else class="planpane__badge planpane__badge--ok">{{ tr('无待确认') }}</span>
    </header>

    <template v-if="pinned">
      <p class="planpane__loc">
        {{ tr('来自会话消息') }} · {{ title(pinned) }}
        <button type="button" class="planpane__jump" @click="emit('locate', pinned.messageId)">
          {{ tr('查看会话位置') }}
        </button>
      </p>
      <!-- 同一 BusinessPlanCard：面板是镜像挂载点，操作与内联卡一致 -->
      <BusinessPlanCard
        :key="pinned.key"
        :result="pinned.result"
        :card-id="'pane:' + pinned.messageId + ':' + pinned.key"
        :readonly="session.currentMode() === 'chat'"
      />
    </template>
    <p v-else class="planpane__empty">
      {{ tr('还没有办理单。任务会话里生成方案后会出现在这里。') }}
    </p>
  </div>
</template>

<style scoped>
.planpane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  overflow-y: auto;
  padding: 2px 4px 12px;
  min-width: 0;
}
.planpane__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.planpane__h {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 1.0);
}
.planpane__badge {
  font-size: calc(var(--ui-font-size) * 0.76923);
  color: var(--warn, #b45309);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
}
.planpane__badge--ok {
  color: var(--text-faint);
}
.planpane__loc {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-muted);
}
.planpane__jump {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 0.76923);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
}
.planpane__jump:hover {
  color: var(--text);
  background: var(--surface-3);
}
.planpane__empty {
  margin: 24px 8px;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
</style>
