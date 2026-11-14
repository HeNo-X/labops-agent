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
export type EngineType = 'agnes' | 'demo' | 'facts' | 'dashscope' | 'scope';

// ===========================================================================
//  SSE 事件契约
// ===========================================================================

/** 当前实现的事件类型 */
export const RUN_EVENT_TYPES = [
  /** 消息接受确认（会话端点专用）：payload 携带全部正式 ID（N01/N17） */
  'run_accepted',
  /**
   * 跨会话并发第二片：全局并发闸门排队提示（协议层控制事件）。
   * ★ 不带 seq：SSE 解码器按 seq 去重，run_accepted 已占 -1、执行事件从 0 起，
   *   排队提示不进事件流编号空间；前端只显示可读提示，不交给 run.ingest。
   */
  'run_queued',
  'run_started',
  /** 执行过程可见性：模型思维链增量（reasoning_content）或相位提示，只用于展示，不进答案 */
  'thinking',
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
  /**
   * A5 任务计划复述（todo recitation）：模型经 maintain_task_plan 工具登记/更新
   * 多步任务计划后发出。payload 是**模型自己的工作记录**，不是业务事实；
   * UI 呈现为计划面板，用户据此看到 Agent 打算做什么、做到了哪一步。
   */
  'plan_updated',
  /** 协议层收尾（传输结束 + 保存确认 payload.saved）；不是业务终态 */
  'end'
] as const;

/**
 * 预留但**本轮仍未发出**的事件（类型固定，便于后续阶段增量实现时前后端不用改契约）：
 *   run_cancelled —— 用户中途取消（本轮仍由前端合成）
 *   thinking      —— 内部推理步骤。注意：绝不把模型内部思维链展示给用户，
 *                    该事件若启用也只承载\"正在查询课表\"这类可观察的步骤摘要。
 */
export const RESERVED_RUN_EVENT_TYPES = ['run_cancelled'] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number] | (typeof RESERVED_RUN_EVENT_TYPES)[number];

/** 每个事件的统一信封。seq 单调递增，前端据此**丢弃已见过的旧事件**（见 shared/sse.js）；
 *  不做乱序重排 —— 迟到的小 seq 直接丢，因此上层依赖"终态事件必达"而非"顺序可恢复"。 */
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

/**
 * 单次运行的服务端快照（GET /api/conversations/:id/run-snapshot?runId=…）。
 *
 * ★ 它是**只读投影**，不是事件流的替代品：字段全部来自已落库的事实
 *   （runs 行 + assistant 消息 meta + 待确认提案），没有任何一条是推测出来的。
 *   **取不到的字段一律为 null**，UI 必须显示"未知"，禁止用推测补齐。
 *   断线后前端用它把一轮收敛到真实终态，而不是让用户手工回查。
 */
export interface RunSnapshot {
  runId: string;
  conversationId: string;
  /** 运行相位。服务端只在能确定时给值（终态 / 有未确认提案），其余为 null */
  phase: 'planning' | 'model' | 'tool' | 'awaiting_confirm' | 'answering' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null;
  /** 该轮已落库的工具调用（含参数与摘要），前端按与历史轮相同的口径重建步骤 */
  toolCalls: Array<{
    toolCallId: string;
    tool: string;
    args?: Record<string, unknown>;
    ok: boolean | null;
    ms?: number;
    summary?: string;
    resultKind?: string;
    error?: { code: string; message: string };
  }>;
  /** 已落库的回答正文（增量刷写的最新快照；可能不是最终全文） */
  answerText: string;
  /** 该会话仍在等待本人确认的提案（没有就为空数组） */
  proposals: Array<{ taskId: string; proposalId: string; actionType: string; version: number }>;
  sourceType: DataSourceType | null;
  engine: EngineType | null;
  model: string | null;
  /** 事件序号。LabOps 不持久化 seq，恒为 null —— 不编造一个看起来连续的编号 */
  lastSeq: null;
  /** 终态；仍在运行或无法判定时为 null。interrupted = 连接断开导致的非主动中止 */
  terminal: 'completed' | 'failed' | 'cancelled' | 'interrupted' | null;
  /** 该轮正文是否已落为终态（false 表示仍在流式写库或写入失败） */
  saved: boolean;
  /** 服务端记录的起止时间（runs 行）；缺字段为 null */
  startedAt: string | null;
  endedAt: string | null;
  /** 实际写出该回答的模型；未配置大模型（规则引擎）时为 null */
  assistantMessageId: string | null;
  /** A5：该轮最后登记的任务计划（meta.plan）；没有就是 null */
  plan: TaskPlanStep[] | null;
}

// ===========================================================================
// A5 任务计划（todo recitation）
// ===========================================================================

/** 模型自己的工作步骤记录；状态只有三种，UI 用 ○/✓/— 呈现 */
export interface TaskPlanStep {
  id: string;
  text: string;
  status: 'pending' | 'done' | 'dropped';
}

export interface TaskPlanUpdatedPayload {
  steps: TaskPlanStep[];
  updatedAt: string;
}

export interface RunStartedPayload {
  runId: string;
  /** 会话 id（前端生成并持久化）。服务端据此承接上一问的房间/日期指代 */
  sessionId?: string;
  /** 用户原始问题（原样回显，便于前端渲染用户气泡） */
  question: string;
  engine: EngineType;
  /** 本模式的模型标识（聊天=DashScope 链首，任务=Agnes）；未配置大模型时缺省。界面据此显示"谁在回答" */
  model?: string;
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
export type ToolResultKind = 'schedule' | 'lab_status' | 'free_rooms' | 'operation_proposal' | 'operations_report' | 'knowledge' | 'business_plan' | 'evidence_observation' | 'checkin_status' | 'checkin_summary' | 'vision_field' | 'task_plan' | 'term_schedule' | 'term_schedule_applied' | 'records';

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
  result?: ScheduleQueryResult | LabStatusResult | FreeRoomsResult | Proposal | OperationsReportResult | KnowledgeResult | BusinessPlanResult | EvidenceObservationResult | CheckinStatusResult | CheckinSummaryResult | VisionFieldResult | { steps: TaskPlanStep[]; updatedAt: string } | Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface AnswerDeltaPayload {
  text: string;
}

export interface RunCompletedPayload {
  durable?: boolean;
  strategy?: 'fact_transform'|'verified_query_transform'|'scope_guidance'|'deterministic_chain'|'deterministic_readonly';
  answer: string;
  steps: number;
  toolCalls: number;
  ms: number;
  sourceType: DataSourceType;
  engine: EngineType;
  /** 实际产出本次回答的模型（fallback 后是真正生效的那个）；规则引擎时为缺省 */
  model?: string;
  /**
   * ops.v1：本次运行结束时关联任务的业务状态。
   * awaiting_confirmation 必须如实呈现——它**不是**"业务已办完"（任务书 §11.3）。
   */
  taskStatus?: string;
  /** 模型用量（仅 agnes 引擎有） */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /**
   * 上下文预算决策（估算口径，见 shared/context-budget.ts）。
   * 只用于**可观测**（界面显示"估算 X / 阈值 Y · 已精简 N 条"），
   * 不参与终态判定，也绝不冒充 provider 的真实 usage。
   */
  budget?: {
    shouldTrim: boolean;
    reason: 'disabled' | 'not_enough_turns' | 'below_threshold' | 'above_threshold' | 'circuit_breaker';
    tokenSource: 'estimate';
    estimatedTokens: number;
    threshold: number;
    contextWindow: number;
    outputReserveTokens: number;
    effectiveContextWindow: number;
    trimmed: { toolResultsDropped: number; historyTurnsDropped: number };
  };
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
  keySummary?:{state:string;location:string|null;holder?:string|null;recordedAt:string|null;note:string};
  serviceState?: 'normal'|'suspended';
  suspendedPeriods?: string[];
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
  /**
   * 经授权读取上海当日未结束的有效签到记录：同房间同主体逐条配对，重复记录不去重。
   * 无数据来源时为 null —— **任何情况下都不允许编造人数**。
   */
  occupancy: { present: number; source: 'authorized_api'; date: string; note: string } | null;
  /** 档案状态口径说明（F19）：active/closed 来自房间档案快照，不是实时门禁 */
  registryStatusNote: string;
  term: string;
  weekNo: number | null;
  weekDeterminable: boolean;
  suggestions: string[];
  notes: string[];
  provenance: ScheduleQueryResult['provenance'];
}

// ---------- query_checkin_status ----------

export interface CheckinStatusArgs {
  /** YYYY-MM-DD，缺省 = 服务端当天（上海时区） */
  date?: string;
}

/** 单节课的本人签到状态（主系统按会话身份计算，只含本人记录） */
export interface CheckinStatusLesson {
  timetableId: string;
  periodKey: string;
  periodLabel: string | null;
  start: string | null;
  end: string | null;
  courseId: string | null;
  courseName: string | null;
  teacher: string | null;
  labId: string | null;
  labName: string | null;
  /** unsigned=未签到 signed=已签到 signed_out=已签退（含自动签退） */
  status: 'unsigned' | 'signed' | 'signed_out';
  /** 仅当天提供：upcoming=未到可签时间 open=可签（含补签窗） ended=已结束；非当天为 null */
  phase: 'upcoming' | 'open' | 'ended' | null;
  /** phase=open 且已超过开课后 20 分钟 → 现在去签会记「补签到」 */
  lateWindow: boolean;
  /** 已有记录本身是「补签到」 */
  lateSignin: boolean;
  autoSignout: boolean;
  /** 签到记录与该课的实验室不一致（扫错实验室） */
  mismatch: boolean;
  locationFailed: boolean;
  checkinTime: string | null;
  checkoutTime: string | null;
  /** 主系统签到页路径（相对主系统 origin；须本人在场完成，Agent 不代签） */
  checkinPath: string | null;
}

export interface CheckinStatusResult {
  actor: { username: string; identity: string; className: string };
  date: string;
  timezone: 'Asia/Shanghai';
  /** 服务器当前节次（当天且处于节次窗口内才有） */
  currentPeriod: { key: string; label: string; start: string; end: string } | null;
  lessons: CheckinStatusLesson[];
  /** 非学生身份 / 未关联班级等情形的如实说明；正常为 null */
  note: string | null;
  provenance: { source: 'authorized_api'; queriedAt: string; sourceRevision: string };
  /** 固定口径：签到须本人在场完成，Agent 不代签 */
  boundaryNote: string;
}

// ---------- query_vision_status（视觉边缘现场事实，剥离身份） ----------

/** 单个房间的现场快照：只有数量与条目名，没有任何人脸/姓名/画面 */
export interface VisionFieldLab {
  labId: string;
  online: boolean;
  count: number;
  /** 边缘随报的房间容量；null=边缘未提供 */
  capacity: number | null;
  /** 已录入人脸命中数（姓名永不出边缘机）；null=边缘未提供 */
  recognized: number | null;
  unknownFaces: number | null;
  library: Array<{ kind: string; name: string; score: number | null }>;
  alert: boolean;
  ageSeconds: number;
}

export interface VisionFieldResult {
  configured: boolean;
  generatedAt?: string;
  /** 口径说明（如"视觉是线索不是结论"），渲染时必须转达 */
  note?: string;
  knownLabs?: string[];
  labs: VisionFieldLab[];
  /** 每房间一行的可读明细（与工具 summary 同源），渲染直接逐行转达 */
  detailLines: string[];
}

// ---------- query_checkin_summary ----------

export interface CheckinSummaryArgs {
  /** YYYY-MM-DD，缺省 = 服务端当天（上海时区） */
  date?: string;
  /** 可选：只看某个实验室（房间 id） */
  labId?: string;
  /** 可选：只看某个节次（am1/am2/pm1/pm2/eve_ab/eve_cd） */
  periodKey?: string;
}

/** 单节课的签到汇总（仅管理员；应到按名册人数或班级档案人数） */
export interface CheckinSummarySession {
  timetableId: string;
  periodKey: string;
  periodLabel: string | null;
  start: string | null;
  end: string | null;
  courseId: string | null;
  courseName: string | null;
  teacher: string | null;
  labId: string | null;
  labName: string | null;
  classNames: string[];
  /** 应到人数；班级人数完全未知时为 null */
  expected: number | null;
  /** 是否有已登记名册（决定 absentUsernames 是否可得） */
  rosterKnown: boolean;
  /** 已签到人数（同人同节唯一，服务端 409 保证） */
  checkedIn: number;
  /** 未签到学号（账号）名单，**不含姓名**；未登记名册时为 null。名单可能少于账面缺口（非名册签到/名册不全），以 note 说明 */
  absentUsernames: string[] | null;
  /** 账面缺口 = max(应到−实到, 0)，与名册无关；应到未知（expected=null）时为 null */
  absentCount: number | null;
  checkedOut: number;
  /** 补签到条数（进程内存标记，重启后的历史记录不计） */
  late: number;
  /** 扫错实验室条数 */
  mismatch: number;
  /** 定位失败条数（仅留痕标记） */
  locationFailed: number;
  note: string | null;
}

export interface CheckinSummaryTotals {
  sessions: number;
  expected: number;
  checkedIn: number;
  absent: number;
  checkedOut: number;
  late: number;
  mismatch: number;
  locationFailed: number;
  /** 应到无法确定的课节数 */
  unknownExpected: number;
}

export interface CheckinSummaryResult {
  actor: { username: string; identity: string; className: string };
  date: string;
  timezone: 'Asia/Shanghai';
  scope: { labId: string | null; periodKey: string | null };
  sessions: CheckinSummarySession[];
  totals: CheckinSummaryTotals;
  note: string | null;
  provenance: { source: 'authorized_api'; queriedAt: string; sourceRevision: string };
  /** 固定口径：缺口需现场核实，请勿代替学生签到；名单为学号不含姓名 */
  boundaryNote: string;
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
  /** 按班级查（与 labName 二选一）：'智能本2501'/'智能本2501班' 都可 */
  className?: string;
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
    | 'class_not_found'
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
    sourceRevision?: string;
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

export interface KnowledgeResult {summary:string;scope:string;hits:Array<{id:string;title:string;version:string;effectiveFrom:string;source:string;url:string;paragraphs:Array<{locator:string;text:string}>}>}
export type BusinessPlanResult = import('./business.ts').BusinessResult;

/**
 * 证据照片的 AI 视觉初判。刻意与"人工验收结论"分开：
 * notHumanVerification 恒为 true，前端必须据此显示声明，后端也不得拿它推进任何业务状态。
 */
export interface EvidenceObservationResult {
  provenance: { sourceLabel: string; queryTime: string; sourceRevision: string; coverage: string };
  scope: string;
  model: string;
  ms: number;
  attachments: Array<{ id: string; fileName: string; mimeType: string; sha256: string; uploadedAt: string }>;
  skipped?: string[];
  observation: {
    deviceType: string;
    visibleSymptoms: string[];
    nameplateText: string;
    severityGuess: 'unknown' | 'minor' | 'moderate' | 'severe';
    confidence: number;
    whatNotVisible: string[];
  };
  notHumanVerification: true;
}
