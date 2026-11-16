/**
 * 轮次回档的业务写入补偿
 * ============================================================================
 *  回档分两层，这里只负责第二层：
 *    ① 会话回档（消息截断 + 上下文快照还原）—— 在 api/conversations.ts 里完成，永远可做；
 *    ② 业务写入回退 —— 本模块。**能撤的撤，不能撤的如实列出**，绝不谎报。
 *
 *  为什么必须分开：会话是自己的数据，业务写入是别人的事实。
 *   · 沙盒（ops_operations 回执）对象都在本库 biz_* 表里 → 可以真补偿，且逐条留痕；
 *   · 连接原系统（native）的写入落在主系统 opsLedger，主系统没有通用撤销接口
 *     → 只能做两件真事：把**尚未提交**的方案 reject 掉（阻止后续提交），
 *       把**已提交**的回执列成清单交给人工处理。
 *
 *  「作废待确认方案」与「取消该轮任务」**不受复选框影响**：它们没有产生任何业务事实，
 *  一个属于本轮的方案活过回档，才是真正的状态泄漏。
 *
 *  参数纪律：本模块不接受任何来自前端的"要撤销哪些对象"，只接受服务端从
 *  已落库消息 meta 里解析出的引用（collectRoundRefs），与 ops.v1 的既有约定一致。
 */

import type { MessageRow } from '../persistence/db.ts';
import {
  cancelOpsTasks,
  getOpsOperationByProposal,
  getOpsProposal,
  hasRevertedOperation,
  recordOpsRevert,
  revertBizClosure,
  revertBizDutySession,
  revertBizIssue,
  revertBizNotification,
  supersedePendingProposals
} from '../persistence/db.ts';
import { businessRequest, businessScope, isBusinessConnected } from '../business/bridge.ts';

export interface ProposalRef {
  proposalId: string;
  taskId: string | null;
}

export interface NativePlanRef {
  planId: string;
  taskId: string | null;
}

export interface RoundRefs {
  proposals: ProposalRef[];
  nativePlans: NativePlanRef[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 从轮次消息的 meta.toolCalls 里解析出该轮牵涉的业务引用。
 * 只认已落库的结构化结果（operation_proposal / business_plan），
 * 聊天文字里的任何 ID 一律不采信。
 */
export function collectRoundRefs(messages: MessageRow[]): RoundRefs {
  const proposals = new Map<string, ProposalRef>();
  const nativePlans = new Map<string, NativePlanRef>();
  for (const m of messages) {
    const calls = (m.meta?.['toolCalls'] as unknown[] | undefined) ?? [];
    for (const raw of calls) {
      const call = asRecord(raw);
      if (!call) continue;
      const resultKind = call['resultKind'];
      const result = asRecord(call['result']);
      if (!result) continue;
      if (resultKind === 'operation_proposal') {
        const proposalId = String(result['proposalId'] ?? '');
        if (!proposalId) continue;
        proposals.set(proposalId, { proposalId, taskId: result['taskId'] ? String(result['taskId']) : null });
      } else if (resultKind === 'business_plan') {
        const plan = asRecord(result['plan']);
        const planId = String(result['planId'] ?? plan?.['id'] ?? '');
        if (!planId) continue;
        const taskId = result['taskId'] ?? plan?.['taskId'];
        nativePlans.set(planId, { planId, taskId: taskId ? String(taskId) : null });
      }
    }
  }
  return { proposals: [...proposals.values()], nativePlans: [...nativePlans.values()] };
}

export interface RevertedItem {
  operationId: string;
  objectKind: string;
  objectId: string;
  action: string;
  detail: string;
}

/** 本轮确实执行过、但本次没有回退的业务写入（用户未勾选，或对象类型不支持） */
export interface NotRevertedItem {
  operationId: string;
  objectKind: string;
  objectId: string;
  reason: string;
}

/** 原系统已提交、无法自动撤回的写入 */
export interface BlockedItem {
  planId: string;
  reason: string;
  objects: Array<{ kind: string; id: string }>;
}

export interface EffectsReport {
  /** 沙盒写入：真的补偿掉了 */
  reverted: RevertedItem[];
  /** 本轮执行过但未回退的写入（未勾选 / 类型不支持），界面必须显示 */
  notReverted: NotRevertedItem[];
  /** 原系统已提交的写入：撤不回来，列清单 */
  blocked: BlockedItem[];
  /** 原系统尚未提交的方案：已 reject（这是真回退） */
  rejectedPlans: string[];
  /** 该轮待确认提案：已作废 */
  supersededProposals: string[];
  /** 该轮任务：已取消 */
  cancelledTasks: string[];
  /** 面向用户的补充说明（失败原因等），界面原样展示 */
  notes: string[];
}

interface PendingPlanOutcome {
  rejected: string[];
  blocked: BlockedItem[];
  notes: string[];
}

/** 原系统方案核对：未提交的 reject 掉，已提交的列成 blocked 清单 */
async function settleNativePlans(refs: NativePlanRef[]): Promise<PendingPlanOutcome> {
  const out: PendingPlanOutcome = { rejected: [], blocked: [], notes: [] };
  for (const ref of refs) {
    let detail: Record<string, unknown>;
    try {
      detail = await businessRequest(`/plans/${encodeURIComponent(ref.planId)}`);
    } catch (err) {
      out.notes.push(`原系统方案 ${ref.planId} 状态未知：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const plan = asRecord(detail['plan']);
    const receipt = asRecord(detail['receipt']);
    if (receipt) {
      const objects = Array.isArray(receipt['objects'])
        ? (receipt['objects'] as unknown[])
            .map((o) => asRecord(o))
            .filter((o): o is Record<string, unknown> => Boolean(o))
            .map((o) => ({ kind: String(o['kind'] ?? ''), id: String(o['id'] ?? '') }))
        : [];
      out.blocked.push({
        planId: ref.planId,
        reason: '该方案已在原系统提交，原系统没有通用撤销接口，需要人工在原系统处理',
        objects
      });
      continue;
    }
    const state = plan ? String(plan['state'] ?? '') : '';
    if (state !== 'awaiting_confirmation') {
      out.notes.push(state ? `原系统方案 ${ref.planId} 当前状态为 ${state}，无需撤回` : `原系统方案 ${ref.planId} 已不存在，无需撤回`);
      continue;
    }
    try {
      await businessRequest('/plans/reject', 'POST', {
        planId: ref.planId,
        version: Number(plan?.['version'] ?? 0),
        scopeKey: businessScope().scopeKey
      });
      out.rejected.push(ref.planId);
    } catch (err) {
      out.blocked.push({
        planId: ref.planId,
        reason: `撤回待确认方案失败：${err instanceof Error ? err.message : String(err)}`,
        objects: []
      });
    }
  }
  return out;
}

function compensateSandbox(ref: ProposalRef, input: { conversationId: string; userMessageId: string; actorId: string }, report: EffectsReport, includeExecuted: boolean): void {
  const receipt = getOpsOperationByProposal(ref.proposalId);
  if (!receipt) return; // 未执行：没有业务写入，无需补偿
  if (hasRevertedOperation(receipt.operationId)) {
    report.notes.push(`操作 ${receipt.operationId} 此前已回档，本次未重复处理`);
    return;
  }
  const actionType = getOpsProposal(ref.proposalId)?.proposal.actionType ?? '';
  for (const object of receipt.objects) {
    if (!object || !object.id) continue;
    if (!includeExecuted) {
      report.notReverted.push({ operationId: receipt.operationId, objectKind: object.kind, objectId: object.id, reason: '按你的选择未回退本轮业务写入（会话已回档）' });
      continue;
    }
    try {
      if (object.kind === 'notification' && receipt.executionEnvironment === 'production') {
        report.notReverted.push({ operationId: receipt.operationId, objectKind: object.kind, objectId: object.id, reason: '该通知已写入主系统收件箱，LabOps 不撤回真实通知；请到主系统处理。沙盒台账保留以供审计' });
        continue;
      }
      const outcome =
        object.kind === 'issue'
          ? revertBizIssue(object.id)
          : object.kind === 'notification'
            ? revertBizNotification(object.id)
            : object.kind === 'closure'
              ? revertBizClosure(object.id)
              : object.kind === 'duty_session'
                ? revertBizDutySession(object.id, actionType === 'duty_session.handover')
                : null;
      if (!outcome) {
        report.notReverted.push({ operationId: receipt.operationId, objectKind: object.kind, objectId: object.id, reason: '该对象类型暂不支持自动回退，需要人工处理' });
        continue;
      }
      recordOpsRevert({ conversationId: input.conversationId, userMessageId: input.userMessageId, operationId: receipt.operationId, outcome, actorId: input.actorId });
      if (outcome.status === 'reverted') {
        report.reverted.push({ operationId: receipt.operationId, objectKind: outcome.objectKind, objectId: outcome.objectId, action: outcome.action, detail: outcome.detail });
      } else {
        report.notReverted.push({ operationId: receipt.operationId, objectKind: outcome.objectKind, objectId: outcome.objectId, reason: outcome.detail });
      }
    } catch (err) {
      report.notReverted.push({ operationId: receipt.operationId, objectKind: object.kind, objectId: object.id, reason: `回退失败：${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

/**
 * 执行回档的业务写入补偿。**不抛异常**：会话截断已经完成，
 * 这里任何失败都必须变成报告里的一条事实，而不是让整个回档 500。
 */
export async function revertRoundEffects(input: {
  conversationId: string;
  userMessageId: string;
  actorId: string;
  refs: RoundRefs;
  /** 是否补偿已经在沙盒执行过的写入（界面上的复选框）；false 时只报告不动数据 */
  includeExecuted: boolean;
}): Promise<EffectsReport> {
  const report: EffectsReport = {
    reverted: [],
    notReverted: [],
    blocked: [],
    rejectedPlans: [],
    supersededProposals: [],
    cancelledTasks: [],
    notes: []
  };

  // ---- ① 沙盒：已执行对象的补偿（受复选框控制）；未执行的提案交给 supersede ----
  for (const ref of input.refs.proposals) {
    compensateSandbox(ref, input, report, input.includeExecuted);
  }
  report.supersededProposals = supersedePendingProposals(input.refs.proposals.map((p) => p.proposalId));

  // ---- ② 原系统：未提交方案 reject（真回退）；已提交的回执列清单（如实）----
  if (input.refs.nativePlans.length) {
    if (!isBusinessConnected()) {
      report.notes.push(`本轮牵涉 ${input.refs.nativePlans.length} 个原系统方案，但当前未连接原系统账号，无法核对或撤回；请重新连接后手动处理。`);
    } else {
      const settled = await settleNativePlans(input.refs.nativePlans);
      report.rejectedPlans.push(...settled.rejected);
      report.blocked.push(...settled.blocked);
      report.notes.push(...settled.notes);
    }
  }

  // ---- ③ 该轮任务取消（已完成/失败的不动：既成事实不该被回档改写）----
  report.cancelledTasks = cancelOpsTasks(input.refs.proposals.map((p) => p.taskId ?? '').filter(Boolean));

  return report;
}
