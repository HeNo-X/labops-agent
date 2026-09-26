/**
 * 工具注册表 —— JSON Schema + 白名单 + 参数类型校验 + 人话摘要
 * ============================================================================
 *  阶段 2A 注册 3 个只读工具：query_schedule / query_lab_status / query_free_rooms。
 *  注册表 = 真实能力清单：没有数据支撑的能力（值班 / 签到 / 钥匙 / 在室人数）与
 *  写操作**一律不注册** —— 注册了却不实现，只会让模型选到一个必然失败的工具。
 *
 *  难点 1 对策 2/3 落在这里：
 *    · 工具名不在注册表 → 回一条"工具 X 不存在，可用工具有：…"，让模型重试
 *    · 参数值非法       → 回"没有 E999，可选：E310/E312/…"，让模型改正
 *  两条都是**可恢复错误**（ok=false + 结构化提示），而不是抛异常中断任务。
 *
 *  摘要原则（工作台改造引入）：summarize() 只给**一行可读结论**，
 *  完整明细在结构化 result 里（界面渲染结构化卡片，模型读 result 全量）。
 */

import type {
  FreeRoomsResult,
  LabStatusResult,
  QueryScheduleArgs,
  ScheduleQueryResult,
  ToolResultKind,
  ToolSpec
} from '../../shared/types.ts';
import { DATA_SOURCE_LABELS } from '../../shared/types.ts';
import type { Dataset } from '../data/store.ts';
import type { ServerNow } from '../time/term.ts';
import {
  ToolArgumentError,
  availableRoomNames,
  runQuerySchedule
} from './query-schedule.ts';
import { coerceLabStatusArgs, runQueryLabStatus } from './query-lab-status.ts';
import { coerceFreeRoomsArgs, runQueryFreeRooms } from './query-free-rooms.ts';
import { PERIOD_KEYS, isPeriodKey } from '../../shared/periods.ts';

/** 注册表 —— 每个条目必须同时有 spec（给模型）与 execute（给服务端） */
export interface RegisteredTool {
  spec: ToolSpec;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => ToolExecution;
}

export interface ToolContext {
  dataset: Dataset;
  now: ServerNow;
}

export type ToolExecution =
  | { ok: true; resultKind: ToolResultKind; result: ScheduleQueryResult | LabStatusResult | FreeRoomsResult; summary: string }
  | { ok: false; code: string; message: string; suggestions: string[]; summary: string };

// ===========================================================================
//  query_schedule 的 JSON Schema
// ===========================================================================

const QUERY_SCHEDULE_SPEC: ToolSpec = {
  name: 'query_schedule',
  description:
    '查询【指定日期 + 指定房间】在实验室课表里的排课安排，返回该房间当天的课程、班级、教师（已脱敏）、节次与起止时间。' +
    '用于回答这一类问题：「E310 今天有哪些课」「周三 D517 有课吗」「某实验室某天第几节被谁占用」。' +
    '调用前请先用服务端给出的当前日期/星期/教学周信息把用户的时间指代（今天、周三、9月30日）换算成 YYYY-MM-DD，本工具不接受"今天"这类自然语言。' +
    '本工具只读、不改动任何数据。不要用它回答签到人数、钥匙位置、人员名单、房间档案类问题——那些不在本工具范围内。',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: '查询日期，格式必须是 YYYY-MM-DD（例如 2026-09-30）。',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$'
      },
      labName: {
        type: 'string',
        description: '实验室房间号，例如 E310、D517、D526。必须来自系统已收录的房间号列表。'
      },
      periodKey: {
        type: 'string',
        enum: [...PERIOD_KEYS],
        description:
          '可选。只查某一个节次。am1=上午第一大节(08:20-09:50)，am2=上午第二大节(10:10-11:40)，' +
          'pm1=下午第一大节(14:00-15:30)，pm2=下午第二大节(15:50-17:20)，' +
          'eve_ab=晚上AB节(17:30-19:00)，eve_cd=晚上CD节(19:10-20:40)。不传表示查全天。'
      }
    },
    required: ['date', 'labName'],
    additionalProperties: false
  },
  danger: false
};

const QUERY_LAB_STATUS_SPEC: ToolSpec = {
  name: 'query_lab_status',
  description:
    '查询【某个实验室房间】的档案与状态：位置、容量、开放状态（开放/关闭/停用）、描述，以及指定日期的排课统计' +
    '（当天几节课、哪些节次被占用、下一节课是什么）。用于回答：「E310 现在开放吗」「D515 容量多大」「那间房今天还有什么课」。' +
    '注意：本工具不提供在室人数（没有签到/门禁数据），涉及"里面有多少人"的问题必须如实回答查不到。',
  parameters: {
    type: 'object',
    properties: {
      labName: {
        type: 'string',
        description: '实验室房间号，例如 E310。必须来自系统已收录的房间号列表。'
      },
      date: {
        type: 'string',
        description: '可选。排课统计的日期，YYYY-MM-DD。缺省为服务端当天。',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$'
      }
    },
    required: ['labName'],
    additionalProperties: false
  },
  danger: false
};

const QUERY_FREE_ROOMS_SPEC: ToolSpec = {
  name: 'query_free_rooms',
  description:
    '查询【指定日期（+可选节次）】没有排课的实验室房间清单，用于"找空实验室/哪些房间没人用"类问题：' +
    '「明天下午第二大节哪些实验室空着」「9月30日有什么房间可用」。' +
    '返回按节次分组的空闲房间（含开放状态与容量）。「空闲」仅指课表无排课，不代表室内无人。' +
    '调用前先把自然语言时间指代换算成 YYYY-MM-DD；date 缺省为服务端当天。',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: '可选。查询日期，YYYY-MM-DD。缺省为服务端当天。',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$'
      },
      periodKey: {
        type: 'string',
        enum: [...PERIOD_KEYS],
        description:
          '可选。只看某一个节次；不传则返回全部六个节次的空闲名单。'
      }
    },
    required: [],
    additionalProperties: false
  },
  danger: false
};

// ===========================================================================
//  参数校验（服务端白名单 + 类型校验，模型给的一律不可信）
// ===========================================================================

/**
 * 把模型给的任意对象收敛成严格类型。多余字段静默丢弃，
 * 类型不对的字段**剥离**（而不是转成 "undefined" 字符串）。
 */
export function coerceQueryScheduleArgs(raw: Record<string, unknown>): QueryScheduleArgs {
  const out: QueryScheduleArgs = {};
  const date = raw['date'];
  if (typeof date === 'string' && date.trim()) out.date = date.trim();
  const labName = raw['labName'];
  if (typeof labName === 'string' && labName.trim()) out.labName = labName.trim();
  const periodKey = raw['periodKey'];
  if (typeof periodKey === 'string') {
    const trimmed = periodKey.trim();
    if (isPeriodKey(trimmed)) out.periodKey = trimmed;
  }
  return out;
}

// ===========================================================================
//  执行
// ===========================================================================

function fail(err: ToolArgumentError, prefix?: string): ToolExecution {
  return {
    ok: false,
    code: err.code,
    message: err.message,
    suggestions: err.suggestions,
    summary: err.suggestions.length
      ? `${prefix ? prefix + '：' : ''}${err.message}。可选房间号：${err.suggestions.join('、')}`
      : (prefix ? `${prefix}：` : '') + err.message
  };
}

function internalError(toolName: string, err: unknown): ToolExecution {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    code: 'tool_internal_error',
    message: `${toolName} 执行时发生未预期错误：${message}`,
    suggestions: [],
    summary: '工具执行失败，请稍后重试或联系管理员'
  };
}

function executeQuerySchedule(args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  const normalized = coerceQueryScheduleArgs(args);
  try {
    const result = runQuerySchedule(normalized, ctx.dataset, ctx.now);
    return { ok: true, resultKind: 'schedule', result, summary: summarizeSchedule(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) return fail(err);
    return internalError('query_schedule', err);
  }
}

function executeQueryLabStatus(args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  const normalized = coerceLabStatusArgs(args);
  try {
    const result = runQueryLabStatus(normalized, ctx.dataset, ctx.now);
    return { ok: true, resultKind: 'lab_status', result, summary: summarizeLabStatus(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) return fail(err);
    return internalError('query_lab_status', err);
  }
}

function executeQueryFreeRooms(args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  const normalized = coerceFreeRoomsArgs(args);
  try {
    const result = runQueryFreeRooms(normalized, ctx.dataset, ctx.now);
    return { ok: true, resultKind: 'free_rooms', result, summary: summarizeFreeRooms(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) return fail(err);
    return internalError('query_free_rooms', err);
  }
}

export const REGISTRY: RegisteredTool[] = [
  { spec: QUERY_SCHEDULE_SPEC, execute: executeQuerySchedule },
  { spec: QUERY_LAB_STATUS_SPEC, execute: executeQueryLabStatus },
  { spec: QUERY_FREE_ROOMS_SPEC, execute: executeQueryFreeRooms }
];

const BY_NAME = new Map(REGISTRY.map((t) => [t.spec.name, t]));

export function toolSpecs(): ToolSpec[] {
  return REGISTRY.map((t) => t.spec);
}

export function toolNames(): string[] {
  return REGISTRY.map((t) => t.spec.name);
}

/** Agnes 的 tools 参数格式（OpenAI 兼容）。danger 是本项目内部标记，不发给模型。 */
export function toolSpecsForAgnes(): Array<{ type: 'function'; function: Omit<ToolSpec, 'danger'> }> {
  return REGISTRY.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.spec.name,
      description: t.spec.description,
      parameters: t.spec.parameters
    }
  }));
}

export function isRegisteredTool(name: unknown): boolean {
  return typeof name === 'string' && BY_NAME.has(name);
}

/**
 * 统一的工具入口。工具名不在白名单时**不抛异常**，而是返回可恢复错误，
 * 附带可用工具清单 —— 让模型有一次自我纠正的机会（难点 1 对策 2）。
 */
export function executeTool(name: unknown, args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  const tool = typeof name === 'string' ? BY_NAME.get(name) : undefined;
  if (!tool) {
    return {
      ok: false,
      code: 'unknown_tool',
      message: `工具 ${String(name)} 不存在`,
      suggestions: toolNames(),
      summary: `工具 ${String(name)} 不存在，可用工具：${toolNames().join('、')}`
    };
  }
  return tool.execute(args ?? {}, ctx);
}

// ===========================================================================
//  人话摘要 —— 一行结论，不塞明细（明细在结构化 result 里）
// ===========================================================================

export function summarizeSchedule(r: ScheduleQueryResult): string {
  const src = `【${DATA_SOURCE_LABELS[r.provenance.sourceType]}】`;
  if (r.reason === 'lab_not_found') {
    return `${src}系统里查不到房间号「${r.labName ?? ''}」；可选：${r.suggestions.slice(0, 6).join('、')}${r.suggestions.length > 6 ? ' 等' : ''}`;
  }
  const head = `${src}${r.labName} ${r.date}（${r.weekdayLabel}）课表：`;
  if (r.lessons.length === 0) {
    return `${head}无排课（${reasonText(r)}${r.periodFilter ? '，节次 ' + r.periodFilter : ''}）`;
  }
  return `${head}共 ${r.lessons.length} 条排课（合班已展开）`;
}

export function summarizeLabStatus(r: LabStatusResult): string {
  const src = `【${DATA_SOURCE_LABELS[r.provenance.sourceType]}】`;
  if (r.labName === null) {
    return `${src}系统里查不到房间号；可选：${r.suggestions.slice(0, 6).join('、')}${r.suggestions.length > 6 ? ' 等' : ''}`;
  }
  const next = r.schedule.nextLesson ? `，下一节 ${r.schedule.nextLesson.startTime} ${r.schedule.nextLesson.courseName}` : '';
  return `${src}${r.labName}：${r.statusLabel}，容量 ${r.capacity ?? '未知'}，${r.date}（${r.weekdayLabel}）${r.schedule.lessonCount} 条排课${next}；在室人数未知（无数据来源）`;
}

export function summarizeFreeRooms(r: FreeRoomsResult): string {
  const src = `【${DATA_SOURCE_LABELS[r.provenance.sourceType]}】`;
  if (r.periodFilter) {
    const p = r.freeByPeriod[0];
    return `${src}${r.date}（${r.weekdayLabel}）${p.periodLabel}空闲房间 ${p.rooms.length} 间：${p.rooms.map((x) => x.labName).join('、') || '（无）'}`;
  }
  const total = r.freeByPeriod.reduce((n, p) => n + p.rooms.length, 0);
  return `${src}${r.date}（${r.weekdayLabel}）全天分节次空闲名单，共 ${r.freeByPeriod.length} 个节次 ${total} 房·次`;
}

// ---- 兼容旧导出名（tests / 其他模块可能引用）----
export const summarize = summarizeSchedule;

function reasonText(r: ScheduleQueryResult): string {
  switch (r.reason) {
    case 'no_class_that_day':
      return `${r.weekdayLabel}当天无课${r.weekDeterminable ? '' : '（注意：教学周不可确定，结果未做周次过滤）'}`;
    case 'no_class_in_that_period':
      return `该节次（${r.periodFilter}）无课`;
    case 'lab_not_active':
      return `该房间当前状态非「开放」，且当天无排课`;
    case 'timetable_empty':
      return '系统内课表为空';
    default:
      return '无数据';
  }
}

/** 供调试/管理端使用：把可用房号压成一行可读文本 */
export function roomListHint(ds: Dataset): string {
  return `已收录房间号：${availableRoomNames(ds).join('、')}`;
}
