/**
 * 只读工具：query_checkin_summary（批次 2，仅管理员）
 * ============================================================================
 *  数据源：主系统 GET /api/integration/checkin-summary（admin 鉴权；应到=名册人数
 *  或班级档案人数；实到=当日有效签到去重；缺口=应到−实到；未签到名单=已登记名册
 *  中未出现的学号（账号），**不含姓名**）。
 *
 *  红线（写进 description，模型每次都会读到）：
 *    · 缺口只是"应到−实到"的账面差，必须现场核实后才能定性（人到未签/请假/旷课
 *      由人工判断），不得据此断言某人缺勤；
 *    · 请勿代替学生签到（主系统立场 + 不造假数据）；
 *    · 逐人签到明细（谁在什么时候签的）依旧没有开放接口，本工具只给聚合与缺口名单；
 *    · 仅管理员可用；学生/志愿者调用会被主系统 403，如实转述。
 */

import type { CheckinSummaryArgs, CheckinSummaryResult, CheckinSummarySession } from '../../shared/types.ts';
import { PERIOD_KEYS } from '../../shared/periods.ts';
import type { ToolContext, ToolExecution } from './registry.ts';
import { businessRequest } from '../business/bridge.ts';
import { isValidDateString } from '../time/term.ts';
import { ToolArgumentError } from './query-schedule.ts';

/** 「签到汇总/缺口」类问法（管理员向；business.ts 路由用；先于本人问法判断但按角色门控） */
export const CHECKIN_SUMMARY_RE = /签到.{0,6}(情况|统计|汇总|缺口|异常|出勤)|签到汇总|出勤率|缺勤|未签到.{0,8}(名单|学号|谁)|哪些.{0,10}没签到/;

/** 把模型给的任意对象收敛成严格类型（F17）：显式非法必须报错，不静默放宽 */
export function coerceCheckinSummaryArgs(raw: Record<string, unknown>): CheckinSummaryArgs {
  const out: CheckinSummaryArgs = {};
  const date = raw['date'];
  if (date !== undefined && date !== null && date !== '') {
    if (typeof date !== 'string' || !isValidDateString(date.trim())) {
      throw new ToolArgumentError('bad_date', `date 参数必须是 YYYY-MM-DD 格式的日期，收到：${typeof date}(${String(date)})`);
    }
    out.date = date.trim();
  }
  const labId = raw['labId'];
  if (labId !== undefined && labId !== null && labId !== '') {
    if (typeof labId !== 'string' || !labId.trim()) throw new ToolArgumentError('bad_lab', `labId 参数必须是房间编号字符串，收到：${typeof labId}(${String(labId)})`);
    out.labId = labId.trim();
  }
  const periodKey = raw['periodKey'];
  if (periodKey !== undefined && periodKey !== null && periodKey !== '') {
    const trimmed = typeof periodKey === 'string' ? periodKey.trim() : '';
    if (!trimmed) {
      /* 空串视为未提供 */
    } else if (PERIOD_KEYS.includes(trimmed as (typeof PERIOD_KEYS)[number])) {
      out.periodKey = trimmed;
    } else {
      throw new ToolArgumentError('bad_period', `periodKey 非法：${trimmed}（合法值：${PERIOD_KEYS.join(' / ')}）`);
    }
  } else if (periodKey !== undefined && periodKey !== null && periodKey !== '') {
    throw new ToolArgumentError('bad_period', `periodKey 必须是字符串节次键，收到：${typeof periodKey}(${String(periodKey)})`);
  }
  return out;
}

export async function runQueryCheckinSummary(args: CheckinSummaryArgs, ctx: ToolContext): Promise<CheckinSummaryResult> {
  const params = new URLSearchParams();
  if (args.date) params.set('date', args.date);
  if (args.labId) params.set('labId', args.labId);
  if (args.periodKey) params.set('periodKey', args.periodKey);
  const query = params.toString();
  const raw = await businessRequest('/checkin-summary' + (query ? `?${query}` : ''), 'GET', undefined, ctx.signal) as Record<string, unknown>;
  const sessionsRaw = raw['sessions'];
  if (!Array.isArray(sessionsRaw)) {
    throw new Error('主系统返回的签到汇总缺少 sessions 数组，无法如实转述');
  }
  const sessions = sessionsRaw as CheckinSummarySession[];
  const totalsRaw = (raw['totals'] || {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    actor: { username: String((raw['actor'] as Record<string, unknown> | undefined)?.['username'] ?? ''), identity: String((raw['actor'] as Record<string, unknown> | undefined)?.['identity'] ?? ''), className: String((raw['actor'] as Record<string, unknown> | undefined)?.['className'] ?? '') },
    date: typeof raw['date'] === 'string' ? raw['date'] : ctx.now.date,
    timezone: 'Asia/Shanghai',
    scope: { labId: (raw['scope'] as CheckinSummaryResult['scope'])?.labId ?? null, periodKey: (raw['scope'] as CheckinSummaryResult['scope'])?.periodKey ?? null },
    sessions,
    totals: {
      sessions: num(totalsRaw['sessions']), expected: num(totalsRaw['expected']), checkedIn: num(totalsRaw['checkedIn']), absent: num(totalsRaw['absent']),
      checkedOut: num(totalsRaw['checkedOut']), late: num(totalsRaw['late']), mismatch: num(totalsRaw['mismatch']), locationFailed: num(totalsRaw['locationFailed']),
      unknownExpected: num(totalsRaw['unknownExpected'])
    },
    note: typeof raw['note'] === 'string' ? raw['note'] : null,
    provenance: { source: 'authorized_api', queriedAt: typeof raw['queriedAt'] === 'string' ? raw['queriedAt'] : ctx.now.iso, sourceRevision: typeof raw['sourceRevision'] === 'string' ? raw['sourceRevision'] : '' },
    boundaryNote: '缺口需现场核实，请勿代替学生签到；未签到名单为学号（账号），不含姓名'
  };
}

/** 一行可读结论：总量 + 有缺口的课节（名单在结果卡/正文里，摘要最多列 3 个学号） */
export function summarizeCheckinSummary(r: CheckinSummaryResult): string {
  if (!r.sessions.length) return `${r.date} 所选范围内没有排课，无签到汇总`;
  const t = r.totals;
  const expectedText = t.unknownExpected ? `${t.expected}+（${t.unknownExpected} 节应到未知）` : String(t.expected);
  const gapped = r.sessions.filter(s => (s.absentCount ?? 0) > 0 || s.expected === null);
  const head = `${r.date} 签到汇总：${t.sessions} 节课，应到 ${expectedText}，已签到 ${t.checkedIn}，缺口 ${t.absent}`;
  if (!gapped.length) return `${head}；无缺口`;
  const lines = gapped.slice(0, 3).map(s => {
    const names = s.absentUsernames && s.absentUsernames.length ? `（未签到：${s.absentUsernames.slice(0, 3).join('、')}${s.absentUsernames.length > 3 ? ' 等' : ''}）` : '';
    return `${s.periodLabel || s.periodKey}《${s.courseName || '课程'}》${s.labName || ''} 应到 ${s.expected ?? '未知'} 缺 ${s.absentCount ?? '未知'}${names}`;
  });
  return `${head}；${lines.join('；')}${gapped.length > 3 ? `等 ${gapped.length} 节有缺口` : ''}`;
}

/** registry 与确定性路由共用的执行入口（read：任何模式可调用；主系统 403 由工具如实转述） */
export async function queryCheckinSummary(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const normalized = coerceCheckinSummaryArgs(args);
    const result = await runQueryCheckinSummary(normalized, ctx);
    return { ok: true, resultKind: 'checkin_summary', result, summary: summarizeCheckinSummary(result) };
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
      summary: '未取得签到汇总（未连接主系统、上游不可用或非管理员身份），不作猜测'
    };
  }
}
