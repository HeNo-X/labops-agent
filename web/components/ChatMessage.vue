<script setup lang="ts">
import {t as tr} from "../i18n";
/**
 * 单条消息渲染 —— 连续会话的基本单元（M2 / F01·F24·F34·F35）
 * ============================================================================
 *  · user：右侧浅灰气泡
 *  · assistant：结论正文 + 工具调用卡（参数可展开）+ 状态 + 复制按钮；
 *    活跃轮的工具数据由 run store 实时驱动，历史轮来自持久化 meta —— 同一组件两种来源
 *  · 状态不只靠颜色：符号 + 文字（✓ 完成 / ✕ 失败 / ⏹ 已取消 / ◌ 生成中 / ‼ 中断）
 */
import type { KnowledgeResult, BusinessPlanResult, TaskPlanStep } from '@shared/types';
import type { CheckinStatusResult, CheckinSummaryResult } from '@shared/types';
import { computed, ref } from 'vue';
import type { ChatMessage, ToolCallRecord } from '../stores/session';
import { useRunStore } from '../stores/run';
import type { ScheduleQueryResult, LabStatusResult, FreeRoomsResult, EngineType } from '@shared/types';
import type { OperationsReportResult } from '@shared/types';
import type { Proposal } from '@shared/operations-contract';
import MarkdownText from './MarkdownText.vue';
import StatusTag from './StatusTag.vue';
import InlineRoundEditor from './InlineRoundEditor.vue';
import UiIcon from './UiIcon.vue';
import PlanPanel from './PlanPanel.vue';
import TaskResult from './TaskResult.vue';
import BusinessPlanCard from './BusinessPlanCard.vue';
import {useSessionStore} from '../stores/session';
import OperationCard from './OperationCard.vue';
import ReportCard from './ReportCard.vue';
import CheckinCard from './CheckinCard.vue';
import EvidenceObservationCard from './EvidenceObservationCard.vue';
import type { EvidenceObservationResult } from '@shared/types';
import type { Tone } from './ui-types';
import { buildTurnRenderUnit, shouldForceExpand, toolTitle, toneOf, glyphOf, labelOf } from '../lib/turn-view';
import { buildToolDisplay } from '../lib/tool-display';

const props = defineProps<{
  msg: ChatMessage;
  /** 工作模式用户消息才给回档/修改 */
  canRewind?: boolean;
  busy?: boolean;
  /** 本轮牵涉业务写入，内联面板给简短提醒 */
  businessWrites?: boolean;
  /** 批次1：可删除本轮（顶部轮次条的删除入口迁移到助手回复底部） */
  canDelete?: boolean;
}>();
const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'decided'): void;
  (e: 'round-edit', payload: { userMessageId: string; text: string; revertEffects: boolean }): void;
  (e: 'round-rewind', payload: { userMessageId: string; revertEffects: boolean }): void;
  /** 批次1：删除本轮（父级走既有删除确认） */
  (e: 'round-delete'): void;
}>();
const run = useRunStore();
const session=useSessionStore();
const copied = ref(false);
const textOnly=computed(()=>session.currentMode()==='chat'||props.msg.responseMode==='chat');

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

const knowledgeArtifacts=computed(()=>props.msg.toolCalls.filter(t=>t.resultKind==='knowledge').map(t=>t.result as KnowledgeResult));
const evidenceArtifacts=computed(()=>props.msg.toolCalls.filter(t=>t.resultKind==='evidence_observation'&&t.result).map(t=>({key:t.toolCallId,result:t.result as EvidenceObservationResult})));
const businessArtifacts=computed(()=>props.msg.toolCalls.filter(t=>t.resultKind==='business_plan'&&t.result).map(t=>({key:t.toolCallId,result:t.result as BusinessPlanResult})));
const checkinArtifacts=computed(()=>props.msg.toolCalls.filter(t=>t.result&&t.resultKind&&(t.resultKind==='checkin_status'||t.resultKind==='checkin_summary')).map(t=>({key:t.toolCallId,kind:t.resultKind as 'checkin_status'|'checkin_summary',result:t.result as CheckinStatusResult|CheckinSummaryResult})));

const isUser = computed(() => props.msg.role === 'user');

// 仅失败/中断/取消轮展开技术运行轨迹（排查用）；成功轮隐藏 token/耗时/工具调用等技术元信息
const showTrace = computed(() => ['failed', 'interrupted', 'cancelled'].includes(props.msg.status));

/**
 * A5 计划步骤：活跃轮（streaming）读 run store 的 plan（plan_updated 实时更新），
 * 历史轮读消息 meta.plan（服务端终态落库）。谁有值用谁——历史轮回放与活跃轮同口径。
 */
const planSteps = computed<TaskPlanStep[]>(() => {
  const live = run.runStatus === 'running' && props.msg.status === 'streaming';
  if (live) return run.plan;
  return Array.isArray(props.msg.plan) ? props.msg.plan : [];
});

/**
 * 轮次渲染单元（T2）—— 活跃轮从 run store 的实时轨迹重建，历史轮从持久化的
 * toolCalls/ms/status 重建，**同一套口径**：
 *   · 运行中 = 展开、逐步带状态；完成 = 默认收起成一行"已工作 N 秒"；
 *   · 中断/取消/失败 = 强制展开，标题为"已停止"且**不带耗时**；
 *   · 历史轮缺完成时间 → interrupted（只显示"已停止"），绝不伪造"已完成"。
 */
const turnUnit = computed(() => {
  const live = run.runStatus === 'running' && props.msg.status === 'streaming';
  if (live) {
    return {
      unit: buildTurnRenderUnit(run.trace, { running: true, interrupted: false, serverMs: null }),
      live: true
    };
  }
  // 历史轮：由持久化事实重建步骤（不重放事件流 —— 历史会话没有 events）
  const steps = props.msg.toolCalls.map((t) => ({
    id: t.toolCallId,
    kind: 'tool' as const,
    title: t.ok === false ? tr('查询未成功') : toolTitle(t.tool),
    detail: t.ok === false ? `${t.error?.code ?? 'error'}：${t.error?.message ?? ''}` : (t.summary ?? ''),
    status: (t.ok === true ? 'done' : t.ok === false ? 'failed' : 'running') as 'done' | 'failed' | 'running',
    ms: t.ms,
    argsText: argsText(t)
  }));
  const interrupted = props.msg.status === 'interrupted' || props.msg.status === 'cancelled';
  return {
    // 已完成轮才有服务端耗时事实（历史里就是 meta.ms）；其余一律 null
    unit: buildTurnRenderUnit(steps, {
      running: false,
      interrupted,
      serverMs: props.msg.status === 'completed' ? (props.msg.ms ?? null) : null
    }),
    live: false
  };
});
/** 展开态按稳定 step id 记忆（不按数组下标）—— 切换会话由父级 key 重建组件自然清空 */
const openSteps = ref<Set<string>>(new Set());
function toggleStep(id: string): void {
  const next = new Set(openSteps.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openSteps.value = next;
}
const traceSummary = computed(() => {
  const u = turnUnit.value.unit;
  const tools = u.toolCount ? ` · ${u.toolCount} ${tr('次工具调用')}` : '';
  return `${u.workStatus.label}${tools}${usageSuffix.value}`;
});

/**
 * A6：token 用量后缀。provider 真实上报才显示（活跃轮来自 run_completed.usage，
 * 历史轮来自消息 meta.usage）；拿不到就是空串 —— 绝不前端估数冒充。
 */
const usageSuffix = computed(() => {
  const u = turnUnit.value.live ? run.usage : (props.msg.usage ?? null);
  if (!u || typeof u.totalTokens !== 'number' || !(u.totalTokens >= 0)) return '';
  return ` · ${u.totalTokens.toLocaleString('en-US')} ${tr('tokens')}`;
});

/**
 * 工具卡展示模型（T4）：按族分流摘要 —— 查询/知识/草稿/视觉/日报各有不同主语与
 * 引导语，不再让 18 个工具长得一模一样。完整结果仍由下方结果卡（TaskResult /
 * OperationCard / ReportCard / EvidenceObservationCard / 引用链接）承担，此处不重复渲染。
 */
const toolDisplays = computed(() =>
  props.msg.toolCalls.map((t) => ({
    key: t.toolCallId,
    record: t,
    display: buildToolDisplay(t, { running: t.ok === null && props.msg.status === 'streaming' })
  }))
);

const statusMeta = computed<{ tone: Tone; glyph: string; label: string }>(() => {
  switch (props.msg.status) {
    case 'streaming':
      return { tone: 'info', glyph: '◌', label: '生成中' };
    case 'completed':
      return { tone: 'ok', glyph: '✓', label: '本轮回答已保存' };
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

/** 内联编辑/回档状态：null=正常显示气泡；否则在气泡位置显示 InlineRoundEditor */
const editorMode = ref<'edit' | 'rollback' | null>(null);


function startEdit(): void {
  if (props.busy) return;
    editorMode.value = 'edit';
}
function startRollback(): void {
  if (props.busy) return;
    editorMode.value = 'rollback';
}
function cancelEditor(): void {
  editorMode.value = null;
}
/**
 * 点击瞬间就把请求原样上抛（回档编排由父层完成）。
 * ⚠️ 不能在这里 await session.rollbackRound 再 emit：回档会清空消息列表并卸载本组件，
 * 卸载后 emit 会丢——「修改并重新发起」表现为只删不重发（2026-11-08 实测根因）。
 */
function onEditorSubmit(payload: { text: string; revertEffects: boolean }): void {
  const mode = editorMode.value;
  if (!mode) return;
  if (mode === 'edit' && !payload.text.trim()) return;
  editorMode.value = null;
  if (mode === 'edit') {
    emit('round-edit', { userMessageId: props.msg.id, text: payload.text, revertEffects: payload.revertEffects });
  } else {
    emit('round-rewind', { userMessageId: props.msg.id, revertEffects: payload.revertEffects });
  }
}

/**
 * 引擎/模型标注 —— 必须显示**真正在回答的那个模型**。
 * 之前只在 engine==='agnes' 时硬编码"Agnes 3.0 Flash"：聊天模式走 DashScope 链时
 * 标签直接是空的，用户无从知道是谁在回答，也无从核对模式分流是否生效。
 * 现在优先显示 run_completed 回带的真实模型 id；只有拿不到时才退回提供方名。
 */
const engineLabel = computed(() => {
  const m = props.msg.model;
  switch (props.msg.engine) {
    case 'scope': return '范围引导';
    case 'dashscope':
      return m ? `DashScope · ${m}` : 'DashScope（聊天链）';
    case 'agnes':
      return m ? `Agnes · ${m}` : 'Agnes';
    case 'demo':
      return props.msg.sourceType === 'live' ? '确定性事实引擎' : '演示引擎';
    case 'facts':
      return '可靠事实转换';
    default:
      return m ?? '';
  }
});
const engineTitle = computed(() => {
  if(props.msg.engine==='scope')return '未查询业务数据或调用模型';
  if (props.msg.engine === 'dashscope') return `聊天模式固定走 DashScope（阿里云百炼）多模型链，本轮的模型是 ${props.msg.model ?? '未标注'}`;
  if (props.msg.engine === 'agnes') return `工作（任务）模式固定走 Agnes，本轮的模型是 ${props.msg.model ?? '未标注'}`;
  return '本轮未调用大模型，由服务端规则引擎生成';
});
</script>

<template>
  <article class="msg" :class="isUser ? 'msg--user' : 'msg--assistant'" :data-status="msg.status">
    <template v-if="isUser">
      <div v-if="editorMode" class="msg__editorwrap">
        <InlineRoundEditor
          :mode="editorMode"
          :initial-text="msg.text"
          :busy="props.busy"
          :error="''"
          :business-writes="Boolean(businessWrites)"
          @cancel="cancelEditor"
          @submit="onEditorSubmit"
        />
      </div>
      <template v-else>
        <div class="msg__userbubble">{{ msg.text }}</div>
        <div class="msg__actions msg__actions--user">
          <button type="button" class="msg__iconbtn" :title="tr(copied ? '已复制' : '复制')" :aria-label="tr('复制')" @click="copyAnswer">
            <UiIcon :name="copied ? 'check' : 'copy'" :size="16" />
          </button>
          <button v-if="canRewind" type="button" class="msg__iconbtn" :title="tr('回档到本轮发起前')" :aria-label="tr('回档到本轮发起前')" @click="startRollback">
            <UiIcon name="rewind" :size="16" />
          </button>
          <button v-if="canRewind" type="button" class="msg__iconbtn" :title="tr('修改并重新发起')" :aria-label="tr('修改并重新发起')" @click="startEdit">
            <UiIcon name="edit" :size="16" />
          </button>
        </div>
      </template>
    </template>

    <template v-else>
      <div class="msg__ahead">
        <span class="msg__who">Agent</span>
        <StatusTag :tone="statusMeta.tone" :glyph="statusMeta.glyph" :label="statusMeta.label" />
        <!-- PC-4：引擎与耗时收敛为一枚徽标，细节移入 hover 提示 -->
        <span v-if="engineLabel || msg.ms" class="msg__engine" :title="engineTitle + (msg.ms ? ` · ${msg.ms} ms` : '')">i</span>
      </div>

      <!-- A5 任务计划面板：活跃轮来自 plan_updated 事件（run store），历史轮来自
           消息 meta.plan —— 同一组件同一口径。计划是模型的工作记录，不是业务结果。 -->
      <PlanPanel v-if="!textOnly && planSteps.length" :steps="planSteps" />

      <!-- 执行过程（T2）：活跃轮与历史轮同一口径 —— 运行中/中断/失败强制展开，
           正常完成默认收起成一行；每步带状态标签与耗时 -->
      <details
        v-if="!textOnly && showTrace && turnUnit.unit.steps.length"
        class="msg__trace"
        :open="shouldForceExpand(turnUnit.unit)"
      >
        <summary>{{ traceSummary }}</summary>
        <ol class="msg__steps">
          <li v-for="s in turnUnit.unit.steps" :key="s.id" class="msg__step">
            <span class="msg__steptitle">{{ s.title }}</span>
            <StatusTag :tone="toneOf(s) as Tone" :glyph="glyphOf(s)" :label="tr(labelOf(s))" />
            <span v-if="s.ms !== undefined" class="msg__ms">{{ s.ms }} ms</span>
            <p v-if="s.detail" class="msg__stepdetail">{{ s.detail }}</p>
            <template v-if="s.argsText || s.summaryFull">
              <button type="button" class="msg__stepmore" @click="toggleStep(s.id)">
                {{ tr(openSteps.has(s.id) ? '收起参数' : '查看参数') }}
              </button>
              <template v-if="openSteps.has(s.id)">
                <p v-if="s.argsText" class="msg__args">{{ tr('参数：') }}{{ s.argsText }}</p>
                <p v-if="s.summaryFull" class="msg__args">{{ tr('摘要：') }}{{ s.summaryFull }}</p>
                <p v-if="s.summaryTruncated" class="msg__toolhint msg__toolhint--warn">
                  {{tr('内容已截断，完整依据见结果卡或引用链接')}}
                </p>
              </template>
            </template>
          </li>
        </ol>
      </details>

      <!-- 工具调用卡（T4：按族分流摘要，18 个工具不再长一样；完整内容在下方结果卡） -->
      <details v-if="!textOnly && showTrace && msg.toolCalls.length" class="msg__tools">
        <summary>{{tr("已执行")}} {{ msg.toolCalls.length }} {{tr("次工具调用（点击看参数与依据）")}}</summary>
        <div v-for="t in toolDisplays" :key="t.key" class="msg__tool" :data-family="t.display.family">
          <div class="msg__toolhead">
            <b>{{ tr(t.display.state === 'running' ? t.display.runningLabel : t.display.finalLabel) }}</b>
            <StatusTag
              :tone="(t.display.state === 'ok' ? 'ok' : t.display.state === 'failed' ? 'danger' : t.display.state === 'cancelled' ? 'neutral' : 'info') as Tone"
              :glyph="t.display.state === 'ok' ? '✓' : t.display.state === 'failed' ? '✕' : t.display.state === 'cancelled' ? '⏹' : '◌'"
              :label="tr(t.display.stateLabel)"
            />
            <span v-if="t.record.ms !== undefined" class="msg__ms">{{ t.record.ms }} ms</span>
          </div>
          <p v-if="t.display.primaryText" class="msg__summary">
            {{ t.display.primaryText }}{{ t.display.primaryTruncated ? '…' : '' }}
          </p>
          <!-- 族的引导语：说明"结果去哪看 / 是否已执行"，不重复正文 -->
          <p v-if="t.display.hint" class="msg__toolhint">{{ tr(t.display.hint) }}</p>
          <p v-if="t.display.showInput" class="msg__args">{{tr("参数：")}}{{ argsText(t.record) || '（无）' }}</p>
          <p v-if="t.record.error" class="msg__args">{{tr("错误：")}}{{ t.record.error.code }} {{ t.record.error.message }}</p>
          <!-- 展开态必须提示已截断：不能让用户以为看到的是全文 -->
          <p v-if="t.display.output?.truncated" class="msg__toolhint msg__toolhint--warn">
            {{tr('内容已截断，完整依据见结果卡或引用链接')}}
          </p>
        </div>
      </details>

      <MarkdownText v-if="msg.text" :text="msg.text" />
      <p v-else-if="msg.status === 'streaming'" class="msg__pending">{{tr("正在执行…")}}</p>
      <p v-else-if="msg.status === 'failed'" class="msg__pending">{{tr("本轮执行失败，未生成回答。")}}</p>
      <p v-else-if="msg.status === 'interrupted'" class="msg__pending">{{tr("本轮执行被中断，部分内容可能未生成。")}}</p>
      <div v-for="(k,i) in knowledgeArtifacts" :key="'knowledge-'+i"><p v-for="h in k.hits" :key="h.id"><a :href="h.url" target="_blank" rel="noopener">{{h.title}} · v{{h.version}} {{tr("· 段落依据")}}</a></p></div>
      <template v-if="!textOnly"><BusinessPlanCard v-for="b in businessArtifacts" :key="b.key" :result="b.result" :card-id="msg.id+':'+b.key" :readonly="session.currentMode()==='chat'" />
      <!-- N03：本条消息自己的结构化结果卡（实时与历史同一渲染器） -->
      <OperationCard
        v-for="a in proposalArtifacts"
        :key="a.key"
        :proposal="a.proposal"
        @decided="emit('decided')"
      />
      <ReportCard v-for="a in reportArtifacts" :key="a.key" :report="a.report" />
      <CheckinCard v-for="a in checkinArtifacts" :key="'ck-'+a.key" :kind="a.kind" :result="a.result" />
      <EvidenceObservationCard v-for="a in evidenceArtifacts" :key="'evo-'+a.key" :result="a.result" />
      <TaskResult v-for="a in queryArtifacts" :key="a.key" :artifact="{ kind: a.kind, result: a.result }" :engine="(msg.engine as EngineType | null | undefined)" />
      </template><p v-if="msg.error" class="msg__err" role="alert"> {{tr("失败原因：")}}{{ msg.error.code }} {{ msg.error.message }}<span v-if="msg.error.hint" class="msg__errhint">{{tr("建议：")}}{{ msg.error.hint }}</span>
      </p>
      <div v-if="(msg.status === 'failed' || msg.status === 'interrupted') && !run.inputLocked" class="msg__retryrow">
        <button type="button" class="msg__retry" @click="emit('retry')">{{tr("重新执行上一问")}}</button>
      </div>

      <div class="msg__actions msg__actions--assistant">
        <button v-if="msg.text" type="button" class="msg__iconbtn" :title="tr(copied ? '已复制' : '复制')" :aria-label="tr('复制')" @click="copyAnswer">
          <UiIcon :name="copied ? 'check' : 'copy'" :size="16" />
        </button>
        <!-- 批次1：删除轮入口迁移——垃圾桶在复制旁，父级走既有删除确认 -->
        <button
          v-if="canDelete && !busy"
          type="button"
          class="msg__iconbtn msg__iconbtn--danger"
          :title="tr('删除本轮')"
          :aria-label="tr('删除本轮')"
          @click="emit('round-delete')"
        >
          <UiIcon name="trash" :size="16" />
        </button>
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
  /* A8：margin-left:auto 双保险——即使外层覆写了 align-items，用户气泡也靠右 */
  margin-left: auto;
  max-width: 78%;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: var(--sp-2) var(--sp-3);
  font-size: calc(var(--ui-font-size) * 1.07692);
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
  font-size: calc(var(--ui-font-size) * 0.92308);
  font-weight: 700;
  color: var(--text);
}
.msg__engine,
.msg__ms {
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
/* PC-4：元数据徽标 —— 小圆 i，hover 有指针与边框反馈 */
.msg__engine {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  font-style: italic;
  font-size: calc(var(--ui-font-size) * 0.69231);
  cursor: help;
  user-select: none;
}
/* 内联编辑器：PC 限宽靠右（编辑区够用又不铺满），触摸端满宽 */
.msg__editorwrap {
  width: min(100%, 680px);
  margin-left: auto;
}
/* 气泡下方操作图标行：PC 靠 hover/聚焦浮现，触摸端常显（主流 Agent 口径） */
.msg__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 120ms ease;
}
.msg__actions--user { justify-content: flex-end; margin-left: auto; }
.msg__actions--assistant { justify-content: flex-start; }
.msg:hover .msg__actions,
.msg:focus-within .msg__actions { opacity: 1; }
.msg__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.msg__iconbtn--danger:hover { color: var(--danger); }
.msg__iconbtn:hover {
  color: var(--text);
  background: var(--surface-2);
}
.msg__iconbtn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
/* 无精确指针（触摸）：操作行常显，点击目标放大到拇指友好尺寸 */
@media (hover: none) {
  .msg__actions { opacity: 1; }
  .msg__iconbtn { width: 34px; height: 34px; }
  .msg__editorwrap { width: 100%; }
}
.msg__text {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  font-family: var(--font-sans);
  font-size: calc(var(--ui-font-size) * 1.07692);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.msg__pending,
.msg__err {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-faint);
}
.msg__err {
  color: var(--danger);
}
.msg__errhint {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
}
.msg__trace,
.msg__tools {
  font-size: calc(var(--ui-font-size) * 0.92308);
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
.msg__step {
  margin-bottom: var(--sp-1);
}
.msg__steptitle {
  font-weight: 600;
  margin-right: var(--sp-2);
}
.msg__stepdetail {
  margin: 2px 0 0;
  color: var(--text-muted);
  word-break: break-word;
}
.msg__stepmore {
  margin-top: 2px;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: calc(var(--ui-font-size) * 0.84615);
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
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
/* 工具卡按族给一条细色边：只做识别线索，不做视觉主戏（无渐变/无发光） */
.msg__tool[data-family='query'] {
  border-left: 2px solid var(--primary);
}
.msg__tool[data-family='knowledge'] {
  border-left: 2px solid var(--info);
}
.msg__tool[data-family='draft'] {
  border-left: 2px solid var(--warn);
}
.msg__tool[data-family='vision'] {
  border-left: 2px solid var(--neutral);
}
.msg__tool[data-family='report'] {
  border-left: 2px solid var(--ok);
}
.msg__toolhint {
  margin: 2px 0 0;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.msg__toolhint--warn {
  color: var(--warn);
}
.msg__args {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) * 0.84615);
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
  font-size: calc(var(--ui-font-size) * 0.92308);
  border-radius: var(--radius-sm);
  padding: 4px 12px;
  cursor: pointer;
}
.msg__retry:hover {
  color: var(--text);
  background: var(--surface-3);
}
</style>
