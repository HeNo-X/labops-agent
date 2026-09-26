/**
 * 前后端共享类型 —— 事件契约、工具契约、数据来源标识
 * ============================================================================
 *  B3 要求：SSE 事件类型表先在文档里定死，前后端按同一份实现。本文件即那份契约。
 */

import type { PeriodKey } from './periods.ts';

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

/** 第一阶段实现的事件类型 */
export const RUN_EVENT_TYPES = [
  'run_started',
  'tool_started',
  'tool_result',
  'answer_delta',
  'run_completed',
  'run_failed'
] as const;

/**
 * 预留但**第一阶段不发出**的事件（类型固定，便于后续阶段增量实现时前后端不用改契约）：
 *   need_confirm  —— 危险操作二次确认（第一阶段不执行任何写操作）
 *   run_cancelled —— 用户中途取消
 *   thinking      —— 内部推理步骤。注意：绝不把模型内部思维链展示给用户，
 *                    该事件若启用也只承载\"正在查询课表\"这类可观察的步骤摘要。
 */
export const RESERVED_RUN_EVENT_TYPES = ['need_confirm', 'run_cancelled', 'thinking'] as const;

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
  tool: string;
  args: Record<string, unknown>;
  sourceType: DataSourceType;
}

export interface ToolResultPayload {
  step: number;
  tool: string;
  ok: boolean;
  ms: number;
  sourceType: DataSourceType;
  /** 给界面看的一句话摘要（人话，不是 JSON） */
  summary: string;
  /** 结构化结果，前端只接受这一份（绝不插入模型返回的任意 HTML） */
  result?: ScheduleQueryResult;
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
  /** 模型用量（仅 agnes 引擎有） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface RunFailedPayload {
  code: string;
  message: string;
  /** 用户可执行的下一步建议 */
  hint?: string;
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
