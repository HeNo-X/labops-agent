/**
 * 决策执行器（ops.v1，任务书 §9.2–§9.4）
 * ============================================================================
 *  唯一的提案执行通道：受权 UI 提交决策（REST），这里完成
 *    幂等预检 → 提案版本/状态/到期校验 → 决策落库 → 网关执行 → 回执落库 → 审计。
 *
 *  关键纪律：
 *   · 实际业务参数**只**从服务端持久化的提案载荷读取；决策请求只带
 *     proposalId + proposalVersion + decision + clientRequestId（T04）。
 *   · 幂等：clientRequestId 命中既有回执 → 原样返回，绝不重复执行（T05/T06）。
 *   · 版本错配 / 已过期 / 已决定 / 越权：返回结构化错误，不执行、不静默。
 *   · 模型无权调用本通道 —— 端点不暴露给工具注册表（任务书 §11.2）。
 */

import { createHash } from 'node:crypto';
import type { DecisionOutcome, ObjectRef, OperationReceipt, SandboxActor, TaskRecord } from '../../shared/operations-contract.ts';
import {
  getDb,
  getOpsOperationByProposal,
  getOpsOperationByClientRequest,
  getOpsProposal,
  getOpsTask,
  insertOpsAudit,
  insertOpsDecision,
  insertOpsOperation,
  updateOpsProposalState,
  updateOpsTaskStatus
} from '../persistence/db.ts';
import {
  buildReceipt,
  execClosureCreate,
  execDutyHandover,
  execDutyStart,
  execIssueCreate,
  execNotificationPublish,
  execRoomStatus,
  GatewayError,
  requestHashOf
} from './gateway.ts';
import { actorHasCapability, type Capability } from './identity.ts';

/** actionType → 所需能力。复合动作（停用+通知）要求集齐全部 */
const ACTION_CAPABILITIES: Record<string, Capability[]> = {
  'issue.create': ['issue:create:self'],
  'notification.publish': ['notice:publish'],
  'room_closure.create': ['availability:write'],
  'room_status.update': ['availability:write'],
  'duty_session.start': ['duty:write'],
  'duty_session.handover': ['duty:write']
};

export interface DecisionInput {
  taskId?: string;
  proposalId: string;
  proposalVersion: number;
  decision: 'confirm' | 'reject';
  clientRequestId: string;
  actor: SandboxActor;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function decideOnProposal(input: DecisionInput): DecisionOutcome {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const outcome = decideInTransaction(input);
    db.exec(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } catch (err) {
    db.exec('ROLLBACK');
    return {ok:false,code:'execution_failed',message:`办理未提交：${err instanceof Error ? err.message : String(err)}`};
  }
}

function decideInTransaction(input: DecisionInput): DecisionOutcome {
  if (!Number.isInteger(input.proposalVersion) || input.proposalVersion < 1) {
    return { ok: false, code: 'bad_request', message: 'proposalVersion 必须是正整数' };
  }
  if (!input.clientRequestId || input.clientRequestId.length > 128) {
    return { ok: false, code: 'bad_request', message: 'clientRequestId 缺失或超长（≤128）' };
  }

  const stored = getOpsProposal(input.proposalId);
  if (!stored) {
    return { ok: false, code: 'proposal_not_found', message: `提案 ${input.proposalId} 不存在` };
  }
  const { proposal, payload, payloadHash } = stored;
  const task = getOpsTask(proposal.taskId);
  if (!task || (input.taskId && input.taskId !== proposal.taskId)) return {ok:false, code:'bad_request', message:'提案与任务不匹配'};
  if (task.actor.id !== input.actor.id) return {ok:false, code:'forbidden', message:'只能处理本人创建的提案'};
  if (input.decision !== 'confirm' && input.decision !== 'reject') return {ok:false,code:'bad_request',message:'无效决定'};

  if (proposal.version !== input.proposalVersion) {
    return {
      ok: false,
      code: 'version_mismatch',
      message: `提案版本不匹配：请求确认 v${input.proposalVersion}，当前有效版本为 v${proposal.version}（${proposal.state}）。请刷新后按最新提案操作。`
    };
  }
  // ---- 能力校验（服务端实时重查，不信任提案生成时的快照）----
  const caps = ACTION_CAPABILITIES[proposal.actionType];
  if (!caps) return {ok:false, code:'bad_request', message:'动作未注册'};
  if (payload['prepareNotice'] === true && !actorHasCapability(input.actor, 'notice:publish')) return {ok:false,code:'forbidden',message:'缺少通知发布权限'};
  const lacking = caps.filter((c) => !actorHasCapability(input.actor, c));
  if (lacking.length) {
    return {
      ok: false,
      code: 'forbidden',
      message: `当前身份（${input.actor.label}）缺少所需能力：${lacking.join('、')}。请切换到有权限的演示身份或联系管理员。`
    };
  }

  const d = getDb();
  const prior = d.prepare('SELECT * FROM ops_decisions WHERE clientRequestId = ?').get(input.clientRequestId) as Record<string, unknown> | undefined;
  if (prior && (prior['proposalId'] !== input.proposalId || prior['proposalVersion'] !== input.proposalVersion || prior['decision'] !== input.decision || prior['actorId'] !== input.actor.id)) {
    return {ok:false,code:'bad_request',message:'幂等键与原始请求指纹不一致'};
  }
  const original = getOpsOperationByProposal(proposal.proposalId);
  if (original && input.decision === 'confirm' && original.actor.id === input.actor.id && original.proposalVersion === input.proposalVersion) return {ok:true,decision:'confirm',receipt:original,task};
  if (prior && input.decision === 'reject' && proposal.state === 'rejected') return {ok:true,decision:'reject',task};
  if (proposal.state === 'expired' || (proposal.state === 'awaiting_confirmation' && Date.parse(proposal.expiresAt) <= Date.now())) return {ok:false,code:'proposal_expired',message:'提案已过期，请重新生成'};
  if (proposal.state !== 'awaiting_confirmation') return {ok:false,code:'proposal_already_decided',message:'提案已处理'};
  if (!proposal.canExecute && input.decision === 'confirm') return {ok:false,code:'forbidden',message:proposal.cannotExecuteReason || '提案不可执行'};

  // ---- 决策落库（唯一索引兜底并发重放）----
  const decided = insertOpsDecision({
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion,
    decision: input.decision,
    clientRequestId: input.clientRequestId,
    actorId: input.actor.id
  });
  if (decided === 'duplicate') {
    // 并发重放：查是否有对应回执；有则幂等返回
    const op = getOpsOperationByClientRequest(input.clientRequestId);
    if (op) {
      const t = getTaskOfProposal(input.proposalId);
      if (t) return { ok: true, decision: 'confirm', receipt: op, task: t };
    }
    return { ok: false, code: 'proposal_already_decided', message: '该提案已被处理过（决策重复），未重复执行' };
  }

  // ---- 拒绝：提案作废，任务取消 ----
  if (input.decision === 'reject') {
    updateOpsProposalState(proposal.proposalId, 'rejected');
    updateOpsTaskStatus(proposal.taskId, 'cancelled');
    insertOpsAudit({
      actorId: input.actor.id,
      action: 'proposal.reject',
      objectKind: 'proposal',
      objectId: proposal.proposalId,
      detail: { taskId: proposal.taskId, version: proposal.version, actionType: proposal.actionType }
    });
    const task = getOpsTask(proposal.taskId);
    if (!task) return { ok: false, code: 'proposal_not_found', message: '提案关联的任务不存在' };
    return { ok: true, decision: 'reject', task };
  }

  // ---- 确认：按 actionType 分派到沙盒网关 ----
  const requestHash = requestHashOf({ actorId: input.actor.id, proposalId: proposal.proposalId, version: proposal.version, decision: input.decision, payloadHash });
  const operationId = `op-${sha256(`${input.actor.id}:${requestHash}`).slice(0, 24)}`;
  const committedAt = new Date().toISOString();
  const claimed = d.prepare("UPDATE ops_proposals SET state='executed' WHERE id=? AND version=? AND state='awaiting_confirmation'").run(proposal.proposalId,proposal.version);
  if(Number(claimed.changes)!==1) return {ok:false,code:'proposal_already_decided',message:'提案已被处理'};
  d.prepare('INSERT INTO ops_proposal_commits VALUES (?,?)').run(proposal.proposalId,operationId);

  try {
    let objects: ObjectRef[];
    switch (proposal.actionType) {
      case 'issue.create':
        objects = execIssueCreate(payload as never, input.actor, operationId);
        break;
      case 'notification.publish':
        objects = execNotificationPublish(payload as never, input.actor, operationId);
        break;
      case 'room_closure.create':
        objects = execClosureCreate(payload as never, input.actor, operationId);
        break;
      case 'duty_session.start':
        objects = execDutyStart(payload as never, input.actor, operationId);
        break;
      case 'duty_session.handover':
        objects = execDutyHandover(payload as never, input.actor, operationId);
        break;
      case 'room_status.update':
        objects = execRoomStatus(payload as never, input.actor, operationId);
        break;
      default:
        return { ok: false, code: 'bad_request', message: `未知的动作类型：${proposal.actionType}` };
    }

    const auditId = insertOpsAudit({
      actorId: input.actor.id,
      action: 'proposal.execute',
      objectKind: 'proposal',
      objectId: proposal.proposalId,
      operationId,
      detail: { taskId: proposal.taskId, version: proposal.version, actionType: proposal.actionType, objects }
    });

    const delivery = deliveryOf(proposal.actionType, payload as Record<string, unknown>);
    const receipt = buildReceipt({
      operationId,
      requestHash,
      objects,
      actor: input.actor,
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      deliveryStatus: delivery.status,
      deliveryNote: delivery.note,
      auditId,
      committedAt
    });

    const inserted = insertOpsOperation({
      clientRequestId: input.clientRequestId,
      proposalId: proposal.proposalId,
      actionType: proposal.actionType,
      requestHash,
      receipt
    });
    if (inserted === 'duplicate') {
      // 并发竞态：另一请求已提交同一操作 → 以库内回执为准（幂等保证）
      const op = getOpsOperationByClientRequest(input.clientRequestId);
      const t = op ? getTaskOfProposal(proposal.proposalId) : null;
      if (op && t) return { ok: true, decision: 'confirm', receipt: op, task: t };
    }

    updateOpsProposalState(proposal.proposalId, 'executed');
    updateOpsTaskStatus(proposal.taskId, 'completed');
    const task = getOpsTask(proposal.taskId);
    if (!task) return { ok: false, code: 'proposal_not_found', message: '提案关联的任务不存在' };
    return { ok: true, decision: 'confirm', receipt, task, executedNow: true };
  } catch (err) {
    // 网关失败：提案保持待确认（可换新幂等键重试），任务标失败并如实上报
    const message = err instanceof GatewayError ? err.message : `沙盒执行失败：${err instanceof Error ? err.message : String(err)}`;
    updateOpsTaskStatus(proposal.taskId, 'failed');
    return { ok: false, code: 'execution_failed', message };
  }
}

function deliveryOf(actionType: string, payload: Record<string, unknown>): { status: OperationReceipt['deliveryStatus']; note: string | null } {
  if (actionType === 'notification.publish') {
    return {
      status: 'pending',
      note: '通知已入库排队，尚无接收方送达凭据；已读跟踪未接入，recipientCount 为空表示沙盒无人员名册。'
    };
  }
  if (actionType === 'room_closure.create' && payload['prepareNotice'] === true) {
    return { status: 'pending', note: '停用与联动单据已在沙盒内生效；联动通知已排队，送达与已读未验证。' };
  }
  return { status: 'not_applicable', note: null };
}

function getTaskOfProposal(proposalId: string): TaskRecord | null {
  const stored = getOpsProposal(proposalId);
  return stored ? getOpsTask(stored.proposal.taskId) : null;
}
