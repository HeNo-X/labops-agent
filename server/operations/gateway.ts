/**
 * 沙盒业务网关（ops.v1，任务书 §8 的第 2 层：独立业务沙盒）
 * ============================================================================
 *  所有业务写入的唯一通道。执行器（executor.ts）只调用这里，不直接碰 biz_* 表；
 *  Agent / 模型永远不直接改业务数据 —— 这是"模型准备、服务端提交"的分界线。
 *
 *  · 复合操作（停用 + 建单 + 通知）在**同一个 SQLite 事务**内完成：
 *    全部成功或全部不发生，不产生"停用了但工单没建"的半状态。
 *  · 每个对象写入即写审计（ops_audit）；站内通知额外写一条 outbox 投递记录
 *    —— 入库即视为站内送达，但"已读"事实不跟踪（界面如实标注）。
 *  · production 适配器未接入：这里所有数据都在本库 biz_* 表，前缀
 *    sandbox 标识，绝不与老系统 state.json / lab.db 混写（任务书 §8.3 防双写）。
 */

import { createHash } from 'node:crypto';
import type { ObjectRef, OperationReceipt, SandboxActor } from '../../shared/operations-contract.ts';
import {
  getDb,
  insertBizClosure,
  insertBizDutySession,
  insertBizIssue,
  insertBizNotification,
  handOverBizDutySession,
  getBizDutySession,
  insertOpsAudit,
  insertOpsOutbox
} from '../persistence/db.ts';

/** 网关执行失败：执行器转成结构化错误，不冒充成功 */
export class GatewayError extends Error {
  readonly code = 'gateway_execution_failed';
}

export interface IssuePayload {
  roomId: string;
  category: string;
  description: string;
  attachmentRefs: string[];
}

export interface NotificationPayload {
  title: string;
  content: string;
  level: string;
  audienceSummary: string;
  recipientCount: number | null;
}

export interface ClosurePayload {
  roomId: string;
  startDate: string;
  endDate: string;
  periodKeys: string[];
  reason: string;
  affectedLessons: number;
  createIssue: boolean;
  issueCategory: string | null;
  issueDescription: string | null;
  prepareNotice: boolean;
  noticeTitle: string | null;
  noticeContent: string | null;
  noticeAudienceSummary: string | null;
}

export interface DutyStartPayload {
  roomId: string;
}

export interface DutyHandoverPayload {
  sessionId: string;
  checklist: Array<{ key: string; label: string; state: 'done' | 'abnormal' | 'unchecked' }>;
  note: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function requestHashOf(parts: Record<string, unknown>): string {
  return sha256(JSON.stringify(parts)).slice(0, 64);
}

// ---------------------------------------------------------------------------
//  各动作的沙盒执行。返回 objects[]（回执对象引用）；审计在事务内逐对象写入。
// ---------------------------------------------------------------------------

function runInTransaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec('SAVEPOINT gateway');
  try {
    const out = fn();
    d.exec('RELEASE gateway');
    return out;
  } catch (err) {
    d.exec('ROLLBACK TO gateway');
    d.exec('RELEASE gateway');
    throw err;
  }
}

function auditOne(actor: SandboxActor, action: string, ref: ObjectRef, operationId: string, detail?: Record<string, unknown>): void {
  insertOpsAudit({ actorId: actor.id, action, objectKind: ref.kind, objectId: ref.id, operationId, detail });
}

export function execIssueCreate(payload: IssuePayload, actor: SandboxActor, operationId: string): ObjectRef[] {
  return runInTransaction(() => {
    const issue = insertBizIssue({
      roomId: payload.roomId,
      category: payload.category,
      description: payload.description,
      actor,
      attachmentRefs: payload.attachmentRefs
    });
    const ref: ObjectRef = { kind: 'issue', id: issue.id, revision: issue.revision };
    auditOne(actor, 'issue.create', ref, operationId, { roomId: payload.roomId, category: payload.category });
    return [ref];
  });
}

export function execNotificationPublish(payload: NotificationPayload, actor: SandboxActor, operationId: string): ObjectRef[] {
  return runInTransaction(() => {
    const ntf = insertBizNotification({
      title: payload.title,
      content: payload.content,
      level: payload.level,
      audienceSummary: payload.audienceSummary,
      recipientCount: payload.recipientCount,
      actor
    });
    // outbox：站内信道的投递记录。入库即送达（沙盒内没有外部信道）；
    // 已读跟踪未接入，回执的 deliveryNote 必须说明这一点。
    insertOpsOutbox('in_app', { notificationId: ntf.id, audienceSummary: payload.audienceSummary });
    const ref: ObjectRef = { kind: 'notification', id: ntf.id, revision: ntf.revision };
    auditOne(actor, 'notification.publish', ref, operationId, { level: payload.level, audience: payload.audienceSummary });
    return [ref];
  });
}

export function execClosureCreate(payload: ClosurePayload, actor: SandboxActor, operationId: string): ObjectRef[] {
  return runInTransaction(() => {
    const refs: ObjectRef[] = [];
    const closure = insertBizClosure({
      roomId: payload.roomId,
      startDate: payload.startDate,
      endDate: payload.endDate,
      periodKeys: payload.periodKeys,
      reason: payload.reason,
      affectedLessons: payload.affectedLessons,
      actor
    });
    refs.push({ kind: 'closure', id: closure.id, revision: closure.revision });
    auditOne(actor, 'closure.create', refs[0]!, operationId, {
      roomId: payload.roomId,
      range: `${payload.startDate}~${payload.endDate}`,
      periods: payload.periodKeys,
      affectedLessons: payload.affectedLessons
    });

    if (payload.createIssue) {
      const issue = insertBizIssue({
        roomId: payload.roomId,
        category: payload.issueCategory ?? 'other',
        description: payload.issueDescription ?? payload.reason,
        actor,
        attachmentRefs: []
      });
      refs.push({ kind: 'issue', id: issue.id, revision: issue.revision });
      auditOne(actor, 'issue.create', refs[refs.length - 1]!, operationId, { from: 'closure', closureId: closure.id });
    }
    if (payload.prepareNotice && payload.noticeTitle && payload.noticeContent) {
      const ntf = insertBizNotification({
        title: payload.noticeTitle,
        content: payload.noticeContent,
        level: 'warning',
        audienceSummary: payload.noticeAudienceSummary ?? '受影响班级（按停用范围推算）',
        recipientCount: null,
        actor
      });
      insertOpsOutbox('in_app', { notificationId: ntf.id, from: 'closure', closureId: closure.id });
      refs.push({ kind: 'notification', id: ntf.id, revision: ntf.revision });
      auditOne(actor, 'notification.publish', refs[refs.length - 1]!, operationId, { from: 'closure', closureId: closure.id });
    }
    return refs;
  });
}

export function execDutyStart(payload: DutyStartPayload, actor: SandboxActor, operationId: string): ObjectRef[] {
  return runInTransaction(() => {
    const session = insertBizDutySession({ roomId: payload.roomId, actor });
    const ref: ObjectRef = { kind: 'duty_session', id: session.id, revision: session.revision };
    auditOne(actor, 'duty.start', ref, operationId, { roomId: payload.roomId });
    return [ref];
  });
}

export function execDutyHandover(payload: DutyHandoverPayload, actor: SandboxActor, operationId: string): ObjectRef[] {
  return runInTransaction(() => {
    const existing = getBizDutySession(payload.sessionId);
    if (!existing || existing.startedBy.id !== actor.id) throw new GatewayError('仅能交接本人创建的值班记录');
    const session = handOverBizDutySession({
      sessionId: payload.sessionId,
      checklist: payload.checklist,
      note: payload.note,
      linkedIssueIds: []
    });
    if (!session) throw new GatewayError('值班会话不存在或已交接，无法重复交接');
    const ref: ObjectRef = { kind: 'duty_session', id: session.id, revision: session.revision };
    auditOne(actor, 'duty.handover', ref, operationId, {
      sessionId: payload.sessionId,
      unchecked: payload.checklist.filter((c) => c.state !== 'done').length
    });
    return [ref];
  });
}

export function getDutySessionForValidation(sessionId: string): { ok: true } | { ok: false; message: string } {
  const s = getBizDutySession(sessionId);
  if (!s) return { ok: false, message: `值班会话 ${sessionId} 不存在` };
  if (s.status !== 'open') return { ok: false, message: `值班会话 ${sessionId} 已交接，不能重复交接` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
//  回执组装
// ---------------------------------------------------------------------------

export function buildReceipt(input: {
  operationId: string;
  requestHash: string;
  objects: ObjectRef[];
  actor: SandboxActor;
  proposalId: string;
  proposalVersion: number;
  deliveryStatus: OperationReceipt['deliveryStatus'];
  deliveryNote: string | null;
  auditId: string;
  committedAt: string;
}): OperationReceipt {
  return {
    ok: true,
    operationId: input.operationId,
    requestHash: input.requestHash,
    businessStatus: 'committed',
    executionEnvironment: 'sandbox',
    objects: input.objects,
    committedAt: input.committedAt,
    deliveryStatus: input.deliveryStatus,
    deliveryNote: input.deliveryNote,
    auditId: input.auditId,
    actor: input.actor,
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion
  };
}
