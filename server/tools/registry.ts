/**
 * 工具注册表 —— JSON Schema + 白名单 + 参数类型校验 + 人话摘要
 * ============================================================================
 *  第一阶段**只注册 1 个工具**。方案规格书列了 9 个，但第一阶段执行提示词明确要求
 *  「不要接入 RAG、MCP、语音、照片巡检或写操作」。注册了却不实现，只会让模型选到
 *  一个必然失败的工具 —— 那是自己给自己制造事故。所以：注册表 = 真实能力清单。
 *
 *  难点 1 对策 2/3 落在这里：
 *    · 工具名不在注册表 → 回一条"工具 X 不存在，可用工具有：…"，让模型重试
 *    · 参数值非法       → 回"没有 E999，可选：E310/E312/…"，让模型改正
 *  两条都是**可恢复错误**（ok=false + 结构化提示），而不是抛异常中断任务。
 */

import type { QueryScheduleArgs, ScheduleQueryResult, ToolSpec } from '../../shared/types.ts';
import { DATA_SOURCE_LABELS } from '../../shared/types.ts';
import type { Dataset } from '../data/store.ts';
import type { ServerNow } from '../time/term.ts';
import { ToolArgumentError, availableRoomNames, runQuerySchedule } from './query-schedule.ts';
import { PERIOD_KEYS } from '../../shared/periods.ts';
import { isPeriodKey } from '../../shared/periods.ts';

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
  | { ok: true; result: ScheduleQueryResult; summary: string }
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
    '本工具只读、不改动任何数据。不要用它回答签到人数、钥匙位置、人员名单类问题——那些数据本阶段没有收录，应直接说明查不到。',
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

function executeQuerySchedule(args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  const normalized = coerceQueryScheduleArgs(args);
  try {
    const result = runQuerySchedule(normalized, ctx.dataset, ctx.now);
    return { ok: true, result, summary: summarize(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) {
      return {
        ok: false,
        code: err.code,
        message: err.message,
        suggestions: err.suggestions,
        summary: err.suggestions.length
          ? `${err.message}。可选房间号：${err.suggestions.join('、')}`
          : err.message
      };
    }
    // 未预期错误：不吞，按"未知错误"上报（C4：禁止静默失败）
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'tool_internal_error',
      message: `query_schedule 执行时发生未预期错误：${message}`,
      suggestions: [],
      summary: '工具执行失败，请稍后重试或联系管理员'
    };
  }
}

export const REGISTRY: RegisteredTool[] = [
  { spec: QUERY_SCHEDULE_SPEC, execute: executeQuerySchedule }
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
      summary: `工具 ${String(name)} 不存在，可用工具只有：${toolNames().join('、')}`
    };
  }
  return tool.execute(args ?? {}, ctx);
}

// ===========================================================================
//  人话摘要（难点 2：塞人话摘要，不塞 JSON）
// ===========================================================================

export function summarize(r: ScheduleQueryResult): string {
  const src = `【${DATA_SOURCE_LABELS[r.provenance.sourceType]}】`;
  if (r.reason === 'lab_not_found') {
    return `${src}系统里查不到这个房间号；可选房间号：${r.suggestions.join('、') || '（无）'}`;
  }
  const head = `${src}${r.labName}（${r.labLocation ?? '位置未录入'}）${r.date} ${r.weekdayLabel}：`;
  if (r.lessons.length === 0) {
    return `${head}没有排课。原因：${reasonText(r)}`;
  }
  const lines = r.lessons.map(
    (l) =>
      `${l.periodLabel}(${l.startTime}-${l.endTime}) ${l.courseName}／${l.className}／${l.teacher}／${weeksShort(l.weeks)}`
  );
  return `${head}共 ${r.lessons.length} 条排课。${lines.join('；')}`;
}

function weeksShort(w: ScheduleLessonWeeks): string {
  const p = w.parity === 'odd' ? '单周' : w.parity === 'even' ? '双周' : '每周';
  return `${w.from}-${w.to}周${p}`;
}
type ScheduleLessonWeeks = ScheduleQueryResult['lessons'][number]['weeks'];

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

/** 供调试/管理端使用：把结果压成一行可读文本，不返回原始 JSON */
export function roomListHint(ds: Dataset): string {
  return `已收录房间号：${availableRoomNames(ds).join('、')}`;
}
