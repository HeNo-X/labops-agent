<script setup lang="ts">
/**
 * 单条消息渲染 —— 连续会话的基本单元（M2 / F01·F24·F34·F35）
 * ============================================================================
 *  · user：右侧浅灰气泡
 *  · assistant：结论正文 + 工具调用卡（参数可展开）+ 状态 + 复制按钮；
 *    活跃轮的工具数据由 run store 实时驱动，历史轮来自持久化 meta —— 同一组件两种来源
 *  · 状态不只靠颜色：符号 + 文字（✓ 完成 / ✕ 失败 / ⏹ 已取消 / ◌ 生成中 / ‼ 中断）
 */
import { computed, ref } from 'vue';
import type { ChatMessage, ToolCallRecord } from '../stores/session';
import { useRunStore } from '../stores/run';
import type { ScheduleQueryResult, LabStatusResult, FreeRoomsResult, EngineType } from '@shared/types';
import type { OperationsReportResult } from '@shared/types';
import type { Proposal } from '@shared/operations-contract';
import StatusTag from './StatusTag.vue';
import TaskResult from './TaskResult.vue';
import OperationCard from './OperationCard.vue';
import ReportCard from './ReportCard.vue';
import type { Tone } from './ui-types';

const props = defineProps<{ msg: ChatMessage }>();
const emit = defineEmits<{ retry: []; decided: [] }>();
const run = useRunStore();
const copied = ref(false);

/** N03：每条消息拥有自己的结果卡（toolCalls[].result → 对应渲染器） */
const queryArtifacts = computed(() =>
  props.msg.toolCalls
    .filter((t) => t.result && t.resultKind && ['schedule', 'lab_status', 'free_rooms'].includes(t.resultKind))
    .map((t) => ({
      key: t.toolCallId,
      kind: t.resultKind as 'schedule' | 'lab_status' | 'free_rooms',
      result: t.result as ScheduleQueryResult | LabStatusResult | FreeRoomsResult
    }))
);
const proposalArtifacts = computed(() =>
  props.msg.toolCalls
    .filter((t) => t.resultKind === 'operation_proposal' && t.result)
    .map((t) => ({ key: t.toolCallId, proposal: t.result as Proposal }))
);
const reportArtifacts = computed(() =>
  props.msg.toolCalls
    .filter((t) => t.resultKind === 'operations_report' && t.result)
    .map((t) => ({ key: t.toolCallId, report: t.result as OperationsReportResult }))
);

const isUser = computed(() => props.msg.role === 'user');

const statusMeta = computed<{ tone: Tone; glyph: string; label: string }>(() => {
  switch (props.msg.status) {
    case 'streaming':
      return { tone: 'info', glyph: '◌', label: '生成中' };
    case 'completed':
      return { tone: 'ok', glyph: '✓', label: '完成' };
    case 'failed':
      return { tone: 'danger', glyph: '✕', label: '失败' };
    case 'cancelled':
      return { tone: 'neutral', glyph: '⏹', label: '已取消' };
    case 'interrupted':
      return { tone: 'warn', glyph: '‼', label: '已中断·可重试' };
    default:
      return { tone: 'neutral', glyph: '○', label: '未知' };
  }
});

function toolTitle(tool: string): string {
  switch (tool) {
    case 'query_schedule':
      return '查询课表';
    case 'query_lab_status':
      return '查询房间状态';
    case 'query_free_rooms':
      return '查找空闲房间';
    case 'prepare_issue_ticket':
      return '准备报修单';
    case 'prepare_room_closure':
      return '准备停用计划';
    case 'prepare_notification':
      return '准备站内通知';
    case 'prepare_duty_session':
      return '准备值班操作';
    case 'create_operations_report':
      return '生成运营日报';
    default:
      return tool;
  }
}

function argsText(t: ToolCallRecord): string {
  return Object.entries(t.args ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('，');
}

async function copyAnswer(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.msg.text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* 剪贴板不可用时静默 */
  }
}

const engineLabel = computed(() =>
  props.msg.engine === 'agnes' ? 'Agnes 3.0 Flash' : props.msg.engine === 'demo' ? '演示引擎' : ''
);
</script>

<template>
  <article class="msg" :class="isUser ? 'msg--user' : 'msg--assistant'" :data-status="msg.status">
    <div v-if="isUser" class="msg__userbubble">{{ msg.text }}</div>

    <template v-else>
      <div class="msg__ahead">
        <span class="msg__who">Agent</span>
        <StatusTag :tone="statusMeta.tone" :glyph="statusMeta.glyph" :label="statusMeta.label" />
        <span v-if="engineLabel" class="msg__engine">{{ engineLabel }}</span>
        <span v-if="msg.ms" class="msg__ms">{{ msg.ms }} ms</span>
        <button v-if="msg.text && !isUser" type="button" class="msg__copy" @click="copyAnswer">
          {{ copied ? '已复制' : '复制' }}
        </button>
      </div>

      <!-- 活跃轮：任务轨迹来自实时事件流 -->
      <details v-if="run.runStatus === 'running' && msg.status === 'streaming'" class="msg__trace">
        <summary>执行过程</summary>
        <ol class="msg__steps">
          <li v-for="s in run.trace" :key="s.id">{{ s.title }} —— {{ s.detail }}</li>
        </ol>
      </details>

      <!-- 工具调用卡（F34：参数在完成后仍可查） -->
      <details v-if="msg.toolCalls.length" class="msg__tools">
        <summary>已执行 {{ msg.toolCalls.length }} 次工具调用（点击看参数与依据）</summary>
        <div v-for="t in msg.toolCalls" :key="t.toolCallId" class="msg__tool">
          <div class="msg__toolhead">
            <b>{{ toolTitle(t.tool) }}</b>
            <StatusTag
              :tone="(t.ok === true ? 'ok' : t.ok === false ? 'danger' : 'info') as Tone"
              :glyph="t.ok === true ? '✓' : t.ok === false ? '✕' : '◌'"
              :label="t.ok === true ? '成功' : t.ok === false ? '未成功' : '执行中'"
            />
            <span v-if="t.ms !== undefined" class="msg__ms">{{ t.ms }} ms</span>
          </div>
          <p v-if="t.summary" class="msg__summary">{{ t.summary }}</p>
          <p class="msg__args">参数：{{ argsText(t) || '（无）' }}</p>
          <p v-if="t.error" class="msg__args">错误：{{ t.error.code }} {{ t.error.message }}</p>
        </div>
      </details>

      <pre v-if="msg.text" class="msg__text">{{ msg.text }}</pre>
      <p v-else-if="msg.status === 'streaming'" class="msg__pending">正在执行…</p>
      <p v-else-if="msg.status === 'failed'" class="msg__pending">本轮执行失败，未生成回答。</p>
      <p v-else-if="msg.status === 'interrupted'" class="msg__pending">本轮执行被中断，部分内容可能未生成。</p>
      <!-- N03：本条消息自己的结构化结果卡（实时与历史同一渲染器） -->
      <OperationCard
        v-for="a in proposalArtifacts"
        :key="a.key"
        :proposal="a.proposal"
        @decided="emit('decided')"
      />
      <ReportCard v-for="a in reportArtifacts" :key="a.key" :report="a.report" />
      <TaskResult v-for="a in queryArtifacts" :key="a.key" :artifact="{ kind: a.kind, result: a.result }" :engine="(msg.engine as EngineType | null | undefined)" />
      <p v-if="msg.error" class="msg__err" role="alert">失败原因：{{ msg.error.code }} {{ msg.error.message }}</p>
      <div v-if="(msg.status === 'failed' || msg.status === 'interrupted') && !run.inputLocked" class="msg__retryrow">
        <button type="button" class="msg__retry" @click="emit('retry')">重新执行上一问</button>
      </div>
    </template>
  </article>
</template>

<style scoped>
.msg {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.msg--user {
  align-items: flex-end;
}
.msg__userbubble {
  max-width: 78%;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: var(--sp-2) var(--sp-3);
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg__ahead {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.msg__who {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}
.msg__engine,
.msg__ms {
  font-size: 11px;
  color: var(--text-faint);
}
.msg__copy {
  margin-left: auto;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-muted);
  font-size: 11px;
  border-radius: var(--radius-sm);
  padding: 1px 8px;
  cursor: pointer;
}
.msg__copy:hover {
  color: var(--text);
  background: var(--surface-2);
}
.msg__text {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  font-family: var(--font-sans);
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.msg__pending,
.msg__err {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.msg__err {
  color: var(--danger);
}
.msg__trace,
.msg__tools {
  font-size: 12px;
  color: var(--text-muted);
}
.msg__trace summary,
.msg__tools summary {
  cursor: pointer;
  color: var(--text-faint);
  user-select: none;
}
.msg__steps {
  margin: var(--sp-1) 0 0;
  padding-left: 18px;
}
.msg__tool {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  margin-top: var(--sp-2);
  background: var(--surface-2);
}
.msg__toolhead {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.msg__summary {
  margin: var(--sp-1) 0 0;
  word-break: break-word;
}
.msg__args {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  word-break: break-word;
}
.msg__retryrow {
  display: flex;
}
.msg__retry {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12px;
  border-radius: var(--radius-sm);
  padding: 4px 12px;
  cursor: pointer;
}
.msg__retry:hover {
  color: var(--text);
  background: var(--surface-3);
}
</style>
