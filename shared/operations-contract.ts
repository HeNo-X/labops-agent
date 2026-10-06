/**
 * ops.v1 业务操作契约 —— 提案 / 决策 / 回执 / 任务（任务书 §9–§11 最小实现版）
 * ============================================================================
 *  定位（任务书 §2.3 三层交付）：本轮交付第 1–2 层 —— 快照 + Agent 自有存储的分析
 *  与草稿能力，以及**独立业务沙盒**的真实执行链路（创建 → 确认 → 执行 → 回执）。
 *  生产适配器（第 3 层）尚未接入：executionEnvironment 恒为 'sandbox'，
 *  界面与服务端都会如实标注，绝不把沙盒结果说成已办理真实业务。
 *
 *  与 GPT 任务书的有意偏离（按本项目现状调整，README 记录）：
 *   · 身份：老系统无登录体系可复用 → 沙盒演示身份（三角色），服务端注入，
 *     前端仅可在沙盒内切换演示视角；模型参数里的任何身份字段一律不采信。
 *   · roomId：直接采用数据集房间号（E310 等），与现有 3 个只读工具同一口径。
 *   · 值班：沙盒无排班实体 → start 以 roomId 建会话、handover 由用户逐项
 *     确认检查清单（服务端只存用户提交的清单，模型不得代填现场事实）。
 *   · 附件：attachmentIds 仅登记引用；上传服务未接入时在 missingDependencies
 *     中明示，不阻塞草稿提交。
 */

import type { DataSourceType } from './types.ts';

// ===========================================================================
//  基础枚举
// ===========================================================================

/** 执行环境：draft=仅草稿未执行；sandbox=独立业务沙盒；production=真实业务（本轮未接入） */
export type ExecutionEnvironment = 'draft' | 'sandbox' | 'production';

/** 任务状态（任务书 §9.2 的本轮子集：单步沙盒操作立即终态，无 queued/running 停留） */
export type TaskStatus =
  | 'awaiting_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  awaiting_confirmation: '待确认',
  completed: '已办结',
  failed: '执行失败',
  cancelled: '已取消',
  expired: '已过期'
};

/** 提案状态。superseded=被用户「回档/删除本轮」作废（不是自然过期，也不是用户拒绝执行） */
export type ProposalState = 'awaiting_confirmation' | 'executed' | 'rejected' | 'expired' | 'superseded';

/** 业务对象种类（回执 objects[].kind） */
export type ObjectKind = 'issue' | 'notification' | 'closure' | 'duty_session' | 'report';

/** 沙盒演示身份。role 决定能力集合（§7.2 权限模型的最小版） */
export type SandboxRole = 'admin' | 'volunteer' | 'student';

export interface SandboxActor {
  id: string;
  role: SandboxRole;
  label: string;
}

export const SANDBOX_ROLE_LABELS: Record<SandboxRole, string> = {
  admin: '演示管理员',
  volunteer: '演示志愿者',
  student: '演示学生'
};

// ===========================================================================
//  提案（Proposal）—— 服务端持久化的"待执行计划"
// ===========================================================================

/** 单项影响预览：提交后哪些对象会发生什么变化（数量必须来自服务端计算） */
export interface EffectPreview {
  label: string;
  objectType: ObjectKind;
  /** 执行前为 null（对象尚不存在） */
  objectId: string | null;
  before: string | null;
  after: string;
}

/**
 * 提案 = 一次可确认的业务计划。**实际业务参数只存在于服务端持久化的
 * payload 里**（见 operations 层）；决策请求只允许提交 ID + 版本 + 决定，
 * 前端不可能夹带一份不同的房间或收件人名单（任务书 §9.3）。
 */
export interface Proposal {
  proposalId: string;
  taskId: string;
  actionType: string;
  version: number;
  state: ProposalState;
  executionEnvironment: ExecutionEnvironment;
  /** 当前身份能否执行（能力不足时为 false，卡面给原因；确认请求会被拒绝） */
  canExecute: boolean;
  cannotExecuteReason: string | null;
  title: string;
  summary: string;
  effects: EffectPreview[];
  /** 尚未接通、但不阻塞生成草稿的依赖（如附件上传） */
  missingDependencies: string[];
  requiredCapabilities: string[];
  createdAt: string;
  expiresAt: string;
  /** 计划依据的数据来源（与只读结果同一 provenance 结构） */
  evidence: Array<ScheduleProvenance>;
  /** 提案载荷的类型标签，前端据此选择编辑/展示形态 */
  payloadKind: 'issue' | 'notification' | 'closure' | 'duty_session';
  /** 展示用载荷：与 payloadKind 对应的用户可读字段（不含服务端内部字段） */
  payloadView: Record<string, unknown>;
}

/** provenance 精简引用（复用 types.ts 的结构形状） */
export interface ScheduleProvenance {
  sourceType: DataSourceType;
  sourceLabel: string;
  queryTime: string;
  timezone: string;
  coverage: string;
}

// ===========================================================================
//  回执（OperationReceipt）—— 一次真实业务副作用的凭据
// ===========================================================================

export interface ObjectRef {
  kind: ObjectKind;
  id: string;
  revision: number;
}

/**
 * 沙盒回执。业务事实以这里的 operationId + objects 为准；
 * 聊天里的任何文字（包括"已完成"）都不构成凭据（任务书 §5.4）。
 */
export interface OperationReceipt {
  ok: true;
  operationId: string;
  requestHash: string;
  businessStatus: 'committed';
  executionEnvironment: 'sandbox';
  objects: ObjectRef[];
  committedAt: string;
  /** 站内通知已创建即 delivered；读状态跟踪未接入（readReceiptsNote 说明） */
  deliveryStatus: 'not_applicable' | 'sent' | 'pending';
  deliveryNote: string | null;
  auditId: string;
  actor: SandboxActor;
  /** 决策依据：哪个提案的哪个版本 */
  proposalId: string;
  proposalVersion: number;
}

// ===========================================================================
//  决策（Decision）—— 受权 UI 触发，模型无权调用
// ===========================================================================

export interface DecisionRequest {
  proposalId: string;
  proposalVersion: number;
  decision: 'confirm' | 'reject';
  /** 幂等键：重复点击/网络重放只产生一次业务效果 */
  clientRequestId: string;
}

export type DecisionOutcome =
  | { ok: true; decision: 'confirm'; receipt: OperationReceipt; task: TaskRecord }
  | { ok: true; decision: 'reject'; task: TaskRecord }
  | {
      ok: false;
      code:
        | 'proposal_not_found'
        | 'version_mismatch'
        | 'proposal_expired'
        | 'proposal_already_decided'
        | 'forbidden'
        | 'bad_request'
        | 'execution_failed';
      message: string;
      /** proposal_already_decided 时回带既有决策结果，幂等恢复用 */
      existingReceipt?: OperationReceipt;
    };

// ===========================================================================
//  任务（Task）—— 跨会话持续存在的业务目标
// ===========================================================================

export interface TaskRecord {
  taskId: string;
  conversationId: string | null;
  kind: 'issue' | 'notification' | 'closure' | 'duty_session' | 'report';
  goal: string;
  status: TaskStatus;
  actor: SandboxActor;
  createdAt: string;
  updatedAt: string;
  /** 关联提案（通常一个任务一个提案；被拒绝后重新准备会生成新提案） */
  proposalIds: string[];
  /** 已执行的操作回执摘要（无则空） */
  operationIds: string[];
}

// ===========================================================================
//  SSE 事件载荷（契约增量：need_confirm 激活；task_updated / operation_result 登记）
// ===========================================================================

/**
 * need_confirm：服务端产出一个待确认提案后发出。
 * payload 携带完整提案预览 —— 前端活跃轮直接渲染，不需要额外请求。
 */
export interface NeedConfirmPayload {
  taskId: string;
  proposal: Proposal;
  allowedDecisions: Array<'confirm' | 'reject'>;
}

/** task_updated：任务状态变化（本轮由决策 REST 端点驱动，SSE 侧登记备用） */
export interface TaskUpdatedPayload {
  taskId: string;
  status: TaskStatus;
  revision: number;
  proposalId: string | null;
  operationId: string | null;
}

/** operation_result：一次业务副作用的结果（SSE 侧登记备用；本轮经 REST 返回） */
export interface OperationResultPayload {
  taskId: string;
  operationId: string;
  receipt: OperationReceipt | { ok: false; code: string; message: string };
}

// ===========================================================================
//  沙盒业务记录（GET /api/tasks/:id 与业务查询接口的返回形状）
// ===========================================================================

export interface SandboxIssue {
  id: string;
  roomId: string;
  category: string;
  description: string;
  reporter: SandboxActor;
  /** reverted=随会话轮次回档被撤回（不再计为未结工单） */
  status: 'open' | 'closed' | 'reverted';
  attachmentRefs: string[];
  createdAt: string;
  revision: number;
}

export interface SandboxNotification {
  id: string;
  title: string;
  content: string;
  level: 'info' | 'warning' | 'urgent';
  audienceSummary: string;
  recipientCount: number | null;
  readTracking: 'not_connected';
  /** reverted=随会话轮次回档撤回（已送达的告知无法收回，仅本系统内作废） */
  status: 'published' | 'reverted';
  publishedBy: SandboxActor;
  publishedAt: string;
  revision: number;
}

export interface SandboxClosure {
  id: string;
  roomId: string;
  startDate: string;
  endDate: string;
  periodKeys: string[];
  reason: string;
  status: 'active' | 'restored';
  affectedLessons: number;
  createdBy: SandboxActor;
  createdAt: string;
  revision: number;
}

export interface SandboxDutySession {
  id: string;
  roomId: string;
  startedBy: SandboxActor;
  startedAt: string;
  /** reverted=开班随会话轮次回档被撤销 */
  status: 'open' | 'handed_over' | 'reverted';
  checklist: Array<{ key: string; label: string; state: 'done' | 'abnormal' | 'unchecked' }> | null;
  handoverNote: string | null;
  linkedIssueIds: string[];
  revision: number;
}
