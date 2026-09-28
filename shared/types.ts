/**
 * 前后端共享类型 —— 事件契约、工具契约、数据来源标识
 * ============================================================================
 *  B3 要求：SSE 事件类型表先在文档里定死，前后端按同一份实现。本文件即那份契约。
 */

import type { PeriodKey } from './periods.ts';
import type { Proposal } from './operations-contract.ts';

// ===========================================================================
//  数据来源标识（界面与事件都必须带，且不得把后两者说成"实时数据"）
// ===========================================================================

/**
 * - live     ：实时数据 —— 服务端直接读真实 state.json（LIVE_DATA=1，仅本地/校内演示）
 * - snapshot ：脱敏快照 —— 默认。从真实 state.json 导出、已脱敏、随仓库入库
 * - demo     ：模拟演示 —— 快照文件缺失时的内置示例数据，构造出来的
 */
export type DataSourceType = 'live' | 'snapshot' | 'demo';

export const DATA_SOURCE_LABELS: Record<DataSourceType, string> = {
  live: '实时数据',
  snapshot: '脱敏快照',
  demo: '模拟演示'
};

/** 推理引擎：agnes = 真实模型；demo = 服务端确定性规则（未配置 Key 时的诚实降级） */
export type EngineType = 'agnes' | 'demo';

// ===========================================================================
//  SSE 事件契约
// ===========================================================================

/** 当前实现的事件类型 */
export const RUN_EVENT_TYPES = [
  /** 消息接受确认（会话端点专用）：payload 携带全部正式 ID（N01/N17） */
  'run_accepted',
  'run_started',
  'tool_started',
  'tool_result',
  'answer_delta',
  'run_completed',
  'run_failed',
  /** R03：终态已执行但持久化失败 —— 前端必须展示"保存失败"，不得静默 */
  'save_failed',
  /**
   * ops.v1（阶段 2B）：服务端产出一个待确认业务提案后发出。
   * payload 携带完整提案预览；实际执行只经受权 UI 的决策端点，模型无权提交。
   */
  'need_confirm',
  /** ops.v1：任务状态变化（本轮由决策 REST 端点驱动；SSE 侧登记备用） */
  'task_updated',
  /** ops.v1：一次业务副作用的结果（SSE 侧登记备用；本轮经 REST 返回） */
  'operation_result',
  /** 协议层收尾（传输结束 + 保存确认 payload.saved）；不是业务终态 */
  'end'
] as const;

/**
 * 预留但**本轮仍未发出**的事件（类型固定，便于后续阶段增量实现时前后端不用改契约）：
 *   run_cancelled —— 用户中途取消（本轮仍由前端合成）
 *   thinking      —— 内部推理步骤。注意：绝不把模型内部思维链展示给用户，
 *                    该事件若启用也只承载\"正在查询课表\"这类可观察的步骤摘要。
 */
export const RESERVED_RUN_EVENT_TYPES = ['run_cancelled', 'thinking'] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number] | (typeof RESERVED_RUN_EVENT_TYPES)[number];

/** 每个事件的统一信封。seq 单调递增，供前端去重与乱序重排。 */
export interface RunEvent<T extends RunEventType = RunEventType, P = unknown> {
  /** 同一事件流内从 0 单调递增 */
  seq: number;
  /** 契约版本，便于日后演进 */
  v: 1;
  /** 本次任务 id */
  runId: string;
  /** 事件类型 */
  type: T;
  /** 事件产生时间（ISO 8601，带时区） */
  ts: string;
  payload: P;
}

export interface RunStartedPayload {
  runId: string;
  /** 会话 id（前端生成并持久化）。服务端据此承接上一问的房间/日期指代 */
  sessionId?: string;
  /** 用户原始问题（原样回显，便于前端渲染用户气泡） */
  question: string;
  engine: EngineType;
  /** 本次结果的数据来源；前端据此显示"实时数据/脱敏快照/模拟演示" */
  sourceType: DataSourceType;
  /** 服务端时间（Asia/Shanghai），不信任客户端时钟 */
  serverNow: {
    iso: string;
    date: string;
    time: string;
    weekday: number;
    weekdayLabel: string;
    timezone: string;
  };
  /** 服务端预解析出的时间指代（难点 3：日期绝不让模型自己算） */
  resolvedTimeHint: {
    raw: string | null;
    date: string | null;
    source: string;
  };
  /** 学期上下文（模型据此知道"今天"是哪一周） */
  term: {
    term: string;
    termStart: string | null;
    weekNo: number | null;
    weekDeterminable: boolean;
    note: string;
  };
  /** 本次任务允许使用的工具名（白名单） */
  allowedTools: string[];
}

export interface ToolStartedPayload {
  step: number;
  /** 本次工具调用的唯一 id。前端按它配对 started/result；step 只是展示序号 */
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  sourceType: DataSourceType;
}

/** 结构化结果的类别。前端据此选择渲染器，不再假设所有工具都返回课表 */
export type ToolResultKind = 'schedule' | 'lab_status' | 'free_rooms' | 'operation_proposal' | 'operations_report';

export interface ToolResultPayload {
  step: number;
  /** 与 tool_started 的 toolCallId 一一对应 */
  toolCallId: string;
  tool: string;
  ok: boolean;
  ms: number;
  sourceType: DataSourceType;
  /** 给界面看的一句话摘要（人话，不是 JSON）。保持一行以内，明细放结构化结果 */
  summary: string;
  /** 结果类别，决定前端用哪个渲染器 */
  resultKind?: ToolResultKind;
  /** 结构化结果，前端只接受这一份（绝不插入模型返回的任意 HTML） */
  result?: ScheduleQueryResult | LabStatusResult | FreeRoomsResult | Proposal | OperationsReportResult;
  error?: { code: string; message: string };
}

export interface AnswerDeltaPayload {
  text: string;
}

export interface RunCompletedPayload {
  answer: string;
  steps: number;
  toolCalls: number;
  ms: number;
  sourceType: DataSourceType;
  engine: EngineType;
  /**
   * ops.v1：本次运行结束时关联任务的业务状态。
   * awaiting_confirmation 必须如实呈现——它**不是**"业务已办完"（任务书 §11.3）。
   */
  taskStatus?: string;
  /** 模型用量（仅 agnes 引擎有） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** create_operations_report 的结构化产物（只创建给当前用户看的报告，不自动发布） */
export interface OperationsReportResult {
  reportId: string;
  artifactVersion: number;
  createdAt: string;
  range: { startDate: string; endDate: string };
  sections: string[];
  metrics: Array<{
    key: string;
    label: string;
    value: number | null;
    unit: string;
    status: 'known' | 'unknown' | 'partial';
    note: string;
  }>;
  /** 数据依据：每一段统计用了什么来源 */
  evidence: Array<{ section: string; sourceType: DataSourceType; sourceLabel: string; note: string }>;
  notes: string[];
}

export interface RunFailedPayload {
  code: string;
  message: string;
  /** 用户可执行的下一步建议 */
  hint?: string;
}

/**
 * run_cancelled：用户主动取消。第一阶段仍由**前端合成**（abort 后本地追加），
 * 服务端预留此类型；接此 payload 时任务必须有确定的取消终态，不得呈现为故障。
 */
export interface RunCancelledPayload {
  /** 取消发生时已运行的时间 */
  ms: number;
  message: string;
}

// ===========================================================================
//  阶段 2A 新增只读工具的输入与输出
// ===========================================================================

// ---------- query_lab_status ----------

export interface LabStatusArgs {
  /** 房间号，如 E310。必填 */
  labName?: string;
  /** YYYY-MM-DD，缺省 = 服务端当天（用于附带该日排课统计） */
  date?: string;
}

export interface LabStatusResult {
  labId: string | null;
  labName: string | null;
  labLocation: string | null;
  capacity: number | null;
  /** active=开放 closed=关闭 inactive=停用/修整 */
  status: 'active' | 'closed' | 'inactive' | null;
  statusLabel: string;
  description: string;
  /** 所查日期（统计口径） */
  date: string;
  weekdayLabel: string;
  /** 该日排课统计 */
  schedule: {
    /** 该日排课条数（已按周次过滤） */
    lessonCount: number;
    /** 占用的节次（按时间序） */
    occupiedPeriods: Array<{ periodKey: PeriodKey; periodLabel: string; startTime: string; endTime: string; courseNames: string[] }>;
    /** 下一节课（含今天剩余时间内的下一次；无则 null） */
    nextLesson: { periodLabel: string; startTime: string; courseName: string } | null;
    /**
     * nextLesson 为 null 的原因（F18）：
     *   no_more_today = 今天且当天剩余无课；not_applicable = 非当天，不提供该字段；
     *   unknown = 教学周不可确定等无法统计的情况
     */
    nextLessonReason: 'no_more_today' | 'not_applicable' | 'unknown';
  };
  /** 在室人数：永远 null —— 没有数据来源，绝不允许编造 */
  occupancy: null;
  /** 档案状态口径说明（F19）：active/closed 来自房间档案快照，不是实时门禁 */
  registryStatusNote: string;
  term: string;
  weekNo: number | null;
  weekDeterminable: boolean;
  suggestions: string[];
  notes: string[];
  provenance: ScheduleQueryResult['provenance'];
}

// ---------- query_free_rooms ----------

export interface FreeRoomsArgs {
  /** YYYY-MM-DD，缺省 = 服务端当天 */
  date?: string;
  /** 缺省 = 查全天（返回每个节次的空闲名单）；指定则只看该节次 */
  periodKey?: PeriodKey;
  /** 节次范围（F12）：如"下午"= ['pm1','pm2'] */
  periodKeys?: PeriodKey[];
}

export interface FreeRoomsResult {
  date: string;
  weekdayLabel: string;
  /** null = 未按单一节次过滤（多节次或全天口径） */
  periodFilter: PeriodKey | null;
  /** 实际参与统计的节次集合 */
  periodKeys: PeriodKey[];
  /**
   * 数据覆盖（F09/N10）：'complete' = 课表非空且日期在合理学期范围内，可做无排课推断；
   * 'missing' = 课表为空；'out_of_range' = 日期超出可信学期范围；
   * 'unknown' = 教学周不可确定。非 complete 时 freeByPeriod.rooms 一律为空，
   * 候选只进 unknownCandidates，**不得展示成确认空闲**
   */
  coverage: 'complete' | 'missing' | 'out_of_range' | 'unknown';
  /** 非 complete 时的未确认候选（仅档案开放），UI 必须标注"未知"，不当空闲推荐 */
  unknownCandidates: string[];
  term: string;
  weekNo: number | null;
  weekDeterminable: boolean;
  /**
   * 每节次的空闲房间。**只含档案状态为开放（active）的房间**（F11）；
   * 关闭/停用进 excluded。指定单节次时只有一个元素。
   */
  freeByPeriod: Array<{
    periodKey: PeriodKey;
    periodLabel: string;
    startTime: string;
    endTime: string;
    rooms: Array<{ labName: string; location: string | null; status: 'active'; capacity: number | null }>;
  }>;
  /** 因档案状态非"开放"而被排除的房间（课表可能同样空闲，但不宜推荐借用） */
  excluded: Array<{ labName: string; location: string | null; status: 'closed' | 'inactive'; reason: string }>;
  notes: string[];
  provenance: ScheduleQueryResult['provenance'];
}

// ===========================================================================
//  工具契约
// ===========================================================================

export interface ToolSpec {
  name: string;
  /** 给模型看的说明书。描述越精确，选得越准（难点 1 的第 6 条对策） */
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
  /** true ⇒ 执行前必须人工二次确认。第一阶段没有任何 danger 工具 */
  danger: boolean;
}

// ---------- query_schedule 的输入与输出 ----------

export interface QueryScheduleArgs {
  /** YYYY-MM-DD。缺省 = 服务端当天（Asia/Shanghai） */
  date?: string;
  /** 房间号，如 E310。第一阶段必填（否则结果无法收敛到可读的规模） */
  labName?: string;
  /** 可选：只查某个节次 */
  periodKey?: PeriodKey;
}

export interface ScheduleLesson {
  timetableId: string;
  periodKey: PeriodKey;
  periodLabel: string;
  /** '08:20' */
  startTime: string;
  /** '09:50' */
  endTime: string;
  courseName: string;
  /** 已脱敏（教师T01 形式）。脱敏前的真实姓名不进入本项目任何文件 */
  teacher: string;
  /** 合班时多个；单班时与 className 相同 */
  classNames: string[];
  className: string;
  merged: boolean;
  labId: string;
  labName: string;
  term: string;
  weeks: { from: number; to: number; parity: 'all' | 'odd' | 'even' };
  updatedAt: string;
}

export interface ScheduleQueryResult {
  /** 命中的房间号；房间不存在时为 null */
  labId: string | null;
  labName: string | null;
  labLocation: string | null;
  labStatus: 'active' | 'closed' | 'inactive' | null;
  /** 本次查询的日期（YYYY-MM-DD） */
  date: string;
  weekday: number;
  weekdayLabel: string;
  /** 命中的节次过滤（未指定则 null） */
  periodFilter: PeriodKey | null;
  term: string;
  /** null = 无法确定教学周 */
  weekNo: number | null;
  /** 教学周是否可确定；false 时 lessons 未做周次过滤，必须在界面上明说 */
  weekDeterminable: boolean;
  weekNote: string;
  lessons: ScheduleLesson[];
  /** 按节次聚合的计数，便于界面渲染"哪几节有课" */
  byPeriod: Array<{ periodKey: PeriodKey; periodLabel: string; startTime: string; endTime: string; count: number }>;
  /** 无数据时的原因码，供前端分支渲染（不靠猜文案） */
  reason:
    | 'ok'
    | 'lab_not_found'
    | 'no_class_that_day'
    | 'no_class_in_that_period'
    | 'lab_not_active'
    | 'timetable_empty';
  /** 房间不存在时给出的可选房号（给模型纠正用，也给界面做纠错提示） */
  suggestions: string[];
  /** 必须一并展示的条件说明，例如"未做周次过滤""该房间当前已关闭" */
  notes: string[];
  /** 结果的数据来源与取证信息 */
  provenance: {
    sourceType: DataSourceType;
    sourceLabel: string;
    /** 快照导出时间（sourceType=snapshot 时有值） */
    snapshotAt?: string;
    /** 源 state.json 的 sha256 前 16 位（可追溯，但不泄露完整指纹以外的信息） */
    sourceSha256Prefix?: string;
    /** 本次查询执行时间 */
    queryTime: string;
    timezone: string;
    /** 数据覆盖范围的口径说明，防止用户误以为是全量历史 */
    coverage: string;
  };
}
