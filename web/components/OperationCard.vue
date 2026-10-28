<script setup lang="ts">
import {clientFetch} from '../client';

import {t as tr} from "../i18n";
/**
 * 办理单（提案）卡 —— ops.v1 的核心交互面
 * ============================================================================
 *  · 信息顺序（任务书 §5.3）：环境标识 → 已解析对象 → 将执行的动作 → 回执/历史
 *  · 确认绑定版本：请求只提交 proposalId + proposalVersion + decision + clientRequestId，
 *    业务参数以服务端持久化提案为准（T04）；幂等键防重复提交（T05）
 *  · 历史消息刷新：挂载时向 /api/proposals/:id 核对当前状态 ——
 *    已执行显示回执、过期/已拒绝不可再确认（T11），绝不显示一个永远可点的旧按钮
 *  · 清单只读：交接清单状态由服务端提案锁定；与实际不符请拒绝后重新描述，
 *    前端不提供"改了参数再确认"的假编辑
 */
import { computed, onMounted, ref } from 'vue';
import type { OperationReceipt, Proposal } from '@shared/operations-contract';
import StatusTag from './StatusTag.vue';
import { actorHeaders } from '../actor';
import { useFeedback } from '../mobile/feedback';

const props = defineProps<{ proposal: Proposal; receipt?: OperationReceipt | null }>();
const emit = defineEmits<{ decided: [] }>();

const state = ref<Proposal>(props.proposal);
const receipt = ref<OperationReceipt | null>(props.receipt ?? null);
const busy = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  // 活跃轮直接用事件里的提案；历史/已决策的卡向服务端核对权威状态
  if (props.receipt || props.proposal.state !== 'awaiting_confirmation') return;
  try {
    const res = await clientFetch(`/api/proposals/${encodeURIComponent(props.proposal.proposalId)}`, { headers: actorHeaders() });
    if (!res.ok) return;
    const j = (await res.json()) as { proposal: Proposal; receipt: OperationReceipt | null };
    state.value = j.proposal;
    receipt.value = j.receipt;
  } catch {
    /* 刷新失败保持本地状态；确认时服务端仍会校验 */
  }
});

async function decide(decision: 'confirm' | 'reject'): Promise<void> {
  if (busy.value) return;
  // U02：移动端确认先弹底部摘要层（拇指区主按钮）；桌面维持卡内直提
  if (decision === 'confirm' && document.querySelector('.mobile-shell')) {
    const feedback = useFeedback();
    const ok = await feedback.confirmSheet({
      title: tr('确认执行该办理单？'),
      message: [state.value.title, state.value.summary.split(/[。；\n]/)[0]].filter(Boolean).join('\n').slice(0, 140),
      confirmLabel: tr('确认执行'),
      cancelLabel: tr('再想想')
    });
    if (!ok) return;
  }
  busy.value = true;
  error.value = null;
  try {
    const clientRequestId = `dec-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    const res = await clientFetch(`/api/tasks/${encodeURIComponent(state.value.taskId)}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({
        proposalId: state.value.proposalId,
        proposalVersion: state.value.version,
        decision,
        clientRequestId
      })
    });
    const j = (await res.json()) as
      | { ok: true; decision: 'confirm'; receipt: OperationReceipt }
      | { ok: true; decision: 'reject' }
      | { ok: false; code: string; message: string; existingReceipt?: OperationReceipt };
    if (j.ok) {
      if (j.decision === 'confirm') {
        receipt.value = j.receipt;
        state.value = { ...state.value, state: 'executed' };
      } else {
        state.value = { ...state.value, state: 'rejected' };
      }
      emit('decided');
    } else {
      if (j.existingReceipt) {
        receipt.value = j.existingReceipt;
        state.value = { ...state.value, state: 'executed' };
        emit('decided');
        return;
      }
      error.value = `${j.message}`;
      // 版本/状态可能已变化：后台刷新一次权威状态
      const r2 = await clientFetch(`/api/proposals/${encodeURIComponent(state.value.proposalId)}`, { headers: actorHeaders() }).catch(() => null);
      if (r2?.ok) {
        const j2 = (await r2.json()) as { proposal: Proposal; receipt: OperationReceipt | null };
        state.value = j2.proposal;
        receipt.value = j2.receipt;
      }
    }
  } catch (e) {
    error.value = `提交决策失败：${(e as Error).message}`;
  } finally {
    busy.value = false;
  }
}

function kindLabel(kind: Proposal['payloadKind']): string {
  switch (kind) {
    case 'issue':
      return '报修工单';
    case 'notification':
      return '站内通知';
    case 'closure':
      return '临时停用';
    case 'duty_session':
      return '值班操作';
  }
}

const ISSUE_CATEGORY_LABELS: Record<string, string> = {
  equipment: '设备故障',
  environment: '环境卫生',
  network: '网络问题',
  door_window_lighting: '门窗照明',
  other: '其他'
};

const STATE_META: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral'; glyph: string; label: string }> = {
  awaiting_confirmation: { tone: 'warn', glyph: '◆', label: '待确认' },
  executed: { tone: 'ok', glyph: '✓', label: '已执行' },
  rejected: { tone: 'neutral', glyph: '⏹', label: '已拒绝' },
  expired: { tone: 'neutral', glyph: '○', label: '已过期' }
};

const checklist = computed<Array<{ key: string; label: string; state: string }>>(() => {
  const v = state.value.payloadView as Record<string, unknown>;
  if (state.value.payloadKind === 'duty_session' && Array.isArray(v['checklist'])) {
    return v['checklist'] as Array<{ key: string; label: string; state: string }>;
  }
  return [];
});
</script>

<template>
  <section class="opcard" :data-state="state.state" :aria-label="tr('业务办理单')">
    <header class="opcard__head">
      <StatusTag
        :tone="(STATE_META[state.state]?.tone ?? 'info') as 'ok' | 'warn' | 'danger' | 'info' | 'neutral'"
        :glyph="STATE_META[state.state]?.glyph ?? '●'"
        :label="STATE_META[state.state]?.label ?? state.state"
      />
      <b class="opcard__title">{{ state.title }}</b>
      <span class="opcard__kind">{{ kindLabel(state.payloadKind) }} · v{{ state.version }}</span>
      <span class="opcard__env" :title="tr('执行环境由服务端决定，界面只如实展示')">{{tr("沙盒演示")}}</span>
    </header>

    <p class="opcard__summary">{{ state.summary }}</p>

    <!-- 将执行的动作 -->
    <ul class="opcard__effects">
      <li v-for="(e, i) in state.effects" :key="i">
        <span class="opcard__effectlabel">{{ e.label }}</span>
        <span v-if="e.before" class="opcard__diff">{{ e.before }} → {{ e.after }}</span>
        <span v-else class="opcard__diff">{{ e.after }}</span>
      </li>
    </ul>

    <!-- 按类型展示关键对象 -->
    <div v-if="state.payloadKind === 'issue'" class="opcard__fields">
      <div class="opcard__row"><span>{{tr("房间")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['roomId'] }}</b></div>
      <div class="opcard__row"><span>{{tr("分类")}}</span><b>{{ ISSUE_CATEGORY_LABELS[String((state.payloadView as Record<string, unknown>)['category'])] ?? (state.payloadView as Record<string, unknown>)['category'] }}</b></div>
      <div class="opcard__row opcard__row--wrap"><span>{{tr("描述")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['description'] }}</b></div>
    </div>
    <div v-else-if="state.payloadKind === 'notification'" class="opcard__fields">
      <div class="opcard__row"><span>{{tr("标题")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['title'] }}</b></div>
      <div class="opcard__row opcard__row--wrap"><span>{{tr("正文")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['content'] }}</b></div>
      <div class="opcard__row"><span>{{tr("接收范围")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['audienceSummary'] }}{{tr("（人数未知，沙盒无名册）")}}</b></div>
    </div>
    <div v-else-if="state.payloadKind === 'closure'" class="opcard__fields">
      <div class="opcard__row"><span>{{tr("范围")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['roomId'] }} · {{ (state.payloadView as Record<string, unknown>)['startDate'] }} ~ {{ (state.payloadView as Record<string, unknown>)['endDate'] }} · {{ ((state.payloadView as Record<string, unknown>)['periodLabels'] as string[])?.join('、') }}</b></div>
      <div class="opcard__row"><span>{{tr("原因")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['reason'] }}</b></div>
      <div class="opcard__row"><span>{{tr("受影响")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['affectedLessons'] }} {{tr("条排课")}}</b></div>
      <ul v-if="((state.payloadView as Record<string, unknown>)['affectedSamples'] as string[])?.length" class="opcard__samples">
        <li v-for="(s, i) in ((state.payloadView as Record<string, unknown>)['affectedSamples'] as string[])" :key="i">{{ s }}</li>
      </ul>
    </div>
    <div v-else-if="state.payloadKind === 'duty_session'" class="opcard__fields">
      <div v-if="String((state.payloadView as Record<string, unknown>)['mode']) === 'start'" class="opcard__row">
        <span>{{tr("开始值班")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['roomId'] }}</b>
      </div>
      <template v-else>
        <div class="opcard__row"><span>{{tr("房间")}}</span><b>{{ (state.payloadView as Record<string, unknown>)['roomId'] }}</b></div>
        <ul class="opcard__checklist">
          <li v-for="c in checklist" :key="c.key" :data-state="c.state">
            <span class="opcard__ckglyph" aria-hidden="true">{{ c.state === 'done' ? '✓' : c.state === 'abnormal' ? '✕' : '○' }}</span>
            <span class="opcard__cklabel">{{ c.label }}</span>
            <span class="opcard__ckstate">{{tr(c.state === 'done' ? '已完成' : c.state === 'abnormal' ? '有异常' : '未确认')}}</span>
          </li>
        </ul>
        <p v-if="String((state.payloadView as Record<string, unknown>)['mode']) === 'handover'" class="opcard__cknote"> {{tr("清单状态以服务端提案为准（只读）。与实际不符？请拒绝本单，补充说明后重新生成。")}} </p>
      </template>
    </div>

    <ul v-if="state.missingDependencies.length" class="opcard__deps">
      <li v-for="(d, i) in state.missingDependencies" :key="i">{{tr("未接入 ·")}} {{ d }}</li>
    </ul>

    <p v-if="!state.canExecute && state.state === 'awaiting_confirmation'" class="opcard__forbid" role="alert">
      {{ state.cannotExecuteReason }}
    </p>

    <!-- 回执 -->
    <div v-if="receipt" class="opcard__receipt" role="status">
      <h4 class="opcard__rh">{{tr("业务回执（以此为准，聊天文字不是凭据）")}}</h4>
      <div class="opcard__row"><span>{{tr("业务单号")}}</span><b class="opcard__mono">{{ receipt.operationId }}</b></div>
      <div class="opcard__row"><span>{{tr("状态")}}</span><b>{{tr("已生效 ·")}} {{tr(receipt.executionEnvironment === 'sandbox' ? '沙盒' : receipt.executionEnvironment)}}</b></div>
      <div class="opcard__row"><span>{{tr("对象")}}</span><b class="opcard__mono">{{ receipt.objects.map((o) => `${o.kind}:${o.id}`).join('，') }}</b></div>
      <div class="opcard__row"><span>{{tr("时间")}}</span><b>{{ receipt.committedAt }}</b></div>
      <div class="opcard__row"><span>{{tr("执行身份")}}</span><b>{{ receipt.actor.label }}（{{ receipt.actor.role }}）</b></div>
      <p v-if="receipt.deliveryNote" class="opcard__rnote">{{ receipt.deliveryNote }}</p>
    </div>

    <p v-if="error" class="opcard__err" role="alert">{{ error }}</p>

    <!-- 动作：仅在待确认 + 有权时出现 -->
    <div v-if="state.state === 'awaiting_confirmation' && state.canExecute && !receipt" class="opcard__actions">
      <button type="button" class="opcard__confirm" :disabled="busy" @click="decide('confirm')">
        {{tr(busy ? '提交中…' : `确认执行（v${state.version}）`)}}
      </button>
      <button type="button" class="opcard__reject" :disabled="busy" @click="decide('reject')">{{tr("拒绝")}}</button>
      <span class="opcard__ttl">{{tr("过期时间")}} {{ new Date(state.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}{{tr("，过期后需重新生成")}}</span>
    </div>
    <p v-else-if="state.state === 'expired'" class="opcard__gone">{{tr("本办理单已过期，请重新发起。")}}</p>
    <p v-else-if="state.state === 'rejected'" class="opcard__gone">{{tr("本办理单已被拒绝，可重新描述需求生成新单。")}}</p>
  </section>
</template>

<style scoped>
.opcard {
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--warn-border);
  background: var(--surface-2);
  border-radius: var(--radius);
  padding: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  font-size: calc(var(--ui-font-size) * 1.0);
}
.opcard[data-state='executed'] {
  border-left-color: var(--info-border, var(--primary));
}
.opcard__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.opcard__title {
  font-size: calc(var(--ui-font-size) * 1.07692);
}
.opcard__kind,
.opcard__env {
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  padding: 0 8px;
}
.opcard__summary {
  margin: 0;
  color: var(--text-muted);
  word-break: break-word;
}
.opcard__effects {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.opcard__effects li {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.opcard__effectlabel::before {
  content: '▸ ';
  color: var(--primary);
}
.opcard__diff {
  color: var(--text-faint);
}
.opcard__fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
}
.opcard__row {
  display: flex;
  gap: var(--sp-2);
  font-size: calc(var(--ui-font-size) * 0.92308);
  align-items: baseline;
}
.opcard__row--wrap {
  flex-direction: column;
  gap: 2px;
}
.opcard__row span:first-child {
  flex: 0 0 64px;
  color: var(--text-faint);
}
.opcard__row--wrap span:first-child {
  flex: none;
}
.opcard__row b {
  font-weight: 600;
  word-break: break-word;
}
.opcard__samples {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.opcard__checklist {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.opcard__checklist li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) * 0.92308);
}
.opcard__ckglyph {
  width: 14px;
  text-align: center;
}
.opcard__checklist li[data-state='done'] .opcard__ckglyph { color: var(--primary); }
.opcard__checklist li[data-state='abnormal'] .opcard__ckglyph { color: var(--danger); }
.opcard__ckstate {
  margin-left: auto;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.opcard__cknote {
  margin: 4px 0 0;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.opcard__deps {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.opcard__forbid {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--danger);
}
.opcard__receipt {
  background: var(--surface-3);
  border: 1px solid var(--info-border, var(--primary));
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.opcard__rh {
  margin: 0 0 2px;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-muted);
}
.opcard__rnote {
  margin: 2px 0 0;
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.opcard__mono {
  font-family: var(--font-mono);
  font-weight: 400;
}
.opcard__err {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--danger);
}
.opcard__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.opcard__confirm {
  border: 1px solid var(--primary);
  background: var(--primary);
  color: var(--primary-contrast);
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  font-size: calc(var(--ui-font-size) * 1.0);
  font-weight: 600;
  cursor: pointer;
}
.opcard__confirm:hover {
  background: var(--primary-hover);
}
.opcard__reject {
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  font-size: calc(var(--ui-font-size) * 0.92308);
  cursor: pointer;
}
.opcard__reject:hover {
  color: var(--text);
}
.opcard__ttl {
  font-size: calc(var(--ui-font-size) * 0.84615);
  color: var(--text-faint);
}
.opcard__gone {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-faint);
}
</style>
