/**
 * 只读工具：query_checkin_status
 * ============================================================================
 *  数据源：主系统 GET /api/integration/checkin-status（委托令牌即当前会话本人；
 *  服务端按会话身份计算，只返回本人记录，节次/时间窗/课程归属全部以主系统为准）。
 *
 *  红线（写进 description，模型每次都会读到）：
 *    · Agent 不代签：签到须本人在实验室现场完成（扫码主链）。本工具只做查询与
 *      引导，不提供、不转述任何"代签方法"；
 *    · 身份、时间、课程归属由主系统服务端校验，工具结果只作如实转述；
 *    · 未连接主系统 / 上游不可用时如实报错，绝不编造签到状态。
 */

import type { CheckinStatusArgs, CheckinStatusResult, CheckinStatusLesson } from '../../shared/types.ts';
import type { ToolContext, ToolExecution } from './registry.ts';
import { businessRequest } from '../business/bridge.ts';
import { isValidDateString } from '../time/term.ts';
import { ToolArgumentError } from './query-schedule.ts';

/** 「本人签到状态」问法（business.ts 原生路由与 demo-engine 未连接兜底共用，避免两处口径漂移） */
export const PERSONAL_CHECKIN_RE = /签到(?:了吗|状态|情况|没[有吗]?)|我的?签[到退]|签退了吗/;

/** 把模型给的任意对象收敛成严格类型（F17）：显式非法必须报错，不静默放宽 */
export function coerceCheckinStatusArgs(raw: Record<string, unknown>): CheckinStatusArgs {
  const out: CheckinStatusArgs = {};
  const date = raw['date'];
  if (date === undefined || date === null || date === '') return out;
  if (typeof date !== 'string' || !isValidDateString(date.trim())) {
    throw new ToolArgumentError('bad_date', `date 参数必须是 YYYY-MM-DD 格式的日期，收到：${typeof date}(${String(date)})`);
  }
  out.date = date.trim();
  return out;
}

export async function runQueryCheckinStatus(args: CheckinStatusArgs, ctx: ToolContext): Promise<CheckinStatusResult> {
  const query = args.date ? `?date=${encodeURIComponent(args.date)}` : '';
  const raw = await businessRequest('/checkin-status' + query, 'GET', undefined, ctx.signal) as Record<string, unknown>;
  const lessonsRaw = raw['lessons'];
  if (!Array.isArray(lessonsRaw)) {
    throw new Error('主系统返回的签到状态缺少 lessons 数组，无法如实转述');
  }
  const lessons = lessonsRaw as CheckinStatusLesson[];
  const queriedAt = typeof raw['queriedAt'] === 'string' ? raw['queriedAt'] : ctx.now.iso;
  const sourceRevision = typeof raw['sourceRevision'] === 'string' ? raw['sourceRevision'] : '';
  const actorRaw = (raw['actor'] || {}) as Record<string, unknown>;
  return {
    actor: {
      username: String(actorRaw['username'] ?? ''),
      identity: String(actorRaw['identity'] ?? ''),
      className: String(actorRaw['className'] ?? '')
    },
    date: typeof raw['date'] === 'string' ? raw['date'] : ctx.now.date,
    timezone: 'Asia/Shanghai',
    currentPeriod: (raw['currentPeriod'] as CheckinStatusResult['currentPeriod']) ?? null,
    lessons,
    note: typeof raw['note'] === 'string' ? raw['note'] : null,
    provenance: { source: 'authorized_api', queriedAt, sourceRevision },
    boundaryNote: '签到须本人在实验室现场完成，Agent 不代签'
  };
}

/** 一行可读结论；明细在结构化 result 里（界面渲染，模型读全量） */
export function summarizeCheckinStatus(r: CheckinStatusResult): string {
  if (r.note) return r.note;
  if (!r.lessons.length) return `${r.date} 没有本人的课程安排，无签到状态可查`;
  const label = (l: CheckinStatusLesson): string => {
    const course = l.courseName ? `《${l.courseName}》` : '课程';
    const room = l.labName ? `在 ${l.labName}` : '';
    if (l.status === 'signed_out') return `${l.periodLabel || l.periodKey} ${course}${room} 已签退${l.autoSignout ? '（自动）' : ''}`;
    if (l.status === 'signed') return `${l.periodLabel || l.periodKey} ${course}${room} 已签到${l.lateSignin ? '（补签到）' : ''}`;
    if (l.phase === 'open') return `${l.periodLabel || l.periodKey} ${course}${room} 未签到，现可签到${l.lateWindow ? '（将记补签到）' : ''}`;
    if (l.phase === 'ended') return `${l.periodLabel || l.periodKey} ${course}${room} 未签到，节次已结束`;
    if (l.phase === 'upcoming') return `${l.periodLabel || l.periodKey} ${course}${room} 未签到，未到可签时间`;
    return `${l.periodLabel || l.periodKey} ${course}${room} 未签到`;
  };
  const openUnsigned = r.lessons.find(l => l.status === 'unsigned' && l.phase === 'open');
  const base = r.lessons.map(label).join('；');
  return openUnsigned && openUnsigned.checkinPath
    ? `${base}。请到 ${openUnsigned.checkinPath} 本人在场签到`
    : base;
}

/** registry 与确定性路由共用的执行入口（read：任何模式可调用） */
export async function queryCheckinStatus(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const normalized = coerceCheckinStatusArgs(args);
    const result = await runQueryCheckinStatus(normalized, ctx);
    return { ok: true, resultKind: 'checkin_status', result, summary: summarizeCheckinStatus(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) {
      return { ok: false, code: err.code, message: err.message, suggestions: err.suggestions, summary: err.message };
    }
    const e = err as { code?: string; status?: number };
    return {
      ok: false,
      code: e.code || 'business_unavailable',
      message: err instanceof Error ? err.message : '主系统不可用',
      suggestions: [],
      summary: '未取得本人签到状态（未连接主系统或上游不可用），不作猜测'
    };
  }
}
