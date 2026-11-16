/**
 * 只读工具：query_term_schedule（学期安排 / 志愿者周值班模板）
 * ============================================================================
 *  数据源：主系统 GET /api/integration/term-schedule（contractVersion=3，三角色可读）。
 *
 *  红线（写进 description，模型每次都会读到）：
 *    · 未导入时 enabled=false / notImported=true 是「尚未接入」，绝不可表述为
 *      「今天没课 / 本节没人值班」；
 *    · 独立档案，不参与课表实时解算，不得据此断言签到可行性；
 *    · 不含学号与手机号；停开课保留原始依据；地点错位等冲突由管理员裁决，Agent 不得自行更正；
 *    · 上游不可用如实报错，不得用旧快照代替当前数据。
 */

import { businessRequest } from '../business/bridge.ts';
import { isValidDateString } from '../time/term.ts';
import { ToolArgumentError } from './query-schedule.ts';

export interface TermScheduleArgs {
  date?: string;
  periodKey?: string;
  labId?: string;
}

export interface TermScheduleResult {
  contractVersion: number;
  date: string;
  queriedAt: string;
  sourceRevision: string;
  termSchedule: {
    enabled: boolean;
    notImported: boolean;
    term: string;
    weeks: number | null;
    week: number | null;
    weekday: number | null;
    sessions: Array<Record<string, unknown>>;
    cancelled: Array<Record<string, unknown>>;
    changes: Array<Record<string, unknown>>;
    notes: string[];
  };
  volunteerSchedule: {
    enabled: boolean;
    notImported: boolean;
    days: Array<Record<string, unknown>>;
    persons: Array<{ name: string; className: string; group: string }>;
    personsMissingProfile: string[];
    expected: { slotCode: string; weekday: number; names: string[]; vacantCount: number } | null;
    dutyRoom: Record<string, unknown> | null;
  };
  hint: string;
}

export const QUERY_TERM_SCHEDULE_SPEC = {
  name: 'query_term_schedule',
  description:
    '查询学期实验排课档案与志愿者周值班模板（独立只读数据，不参与课表实时解算）。' +
    '可查某日/某节次/某实验室的实验安排，以及该节次应值班的志愿者姓名、本周值班矩阵、有班无档案名单。' +
    '用户问「这学期有什么实验课」「今天 E310 上什么课」「这节谁值班」「我的值班表」时用本工具。' +
    '红线：返回 enabled=false / notImported=true 表示管理员尚未导入，必须如实回答「学期安排尚未导入，请联系管理员」，' +
    '绝不能说成「今天没课」「本节无人值班」；空数组同样不得当成事实。' +
    '该档案不写 timetable，不得用它判断学生签到是否可行（签到仍以主系统课表解算为准）。' +
    '不含学号与手机号；停开课保留原始依据；地点错位与重复课须由管理员裁决，Agent 不得自行更正数据。' +
    '未连接主系统或上游报错时如实说明，不编造。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD，默认今日（Asia/Shanghai）' },
      periodKey: { type: 'string', enum: ['am1', 'am2', 'pm1', 'pm2', 'eve_ab', 'eve_cd'], description: '六节次 key' },
      labId: { type: 'string', description: '实验室房号，如 E310（按源文件原值匹配）' }
    },
    additionalProperties: false
  },
  danger: false
};

const PERIOD_KEYS = ['am1', 'am2', 'pm1', 'pm2', 'eve_ab', 'eve_cd'];

export function coerceTermScheduleArgs(raw: Record<string, unknown>): TermScheduleArgs {
  const out: TermScheduleArgs = {};
  const date = raw['date'];
  if (date !== undefined && date !== null && date !== '') {
    if (typeof date !== 'string' || !isValidDateString(date.trim())) {
      throw new ToolArgumentError('bad_date', `date 必须是 YYYY-MM-DD，收到：${typeof date}(${String(date)})`);
    }
    out.date = date.trim();
  }
  const periodKey = raw['periodKey'];
  if (periodKey !== undefined && periodKey !== null && periodKey !== '') {
    if (typeof periodKey !== 'string' || !PERIOD_KEYS.includes(periodKey)) {
      throw new ToolArgumentError('bad_period', `periodKey 必须是六节次 key 之一，收到：${String(periodKey)}`);
    }
    out.periodKey = periodKey;
  }
  const labId = raw['labId'];
  if (labId !== undefined && labId !== null && labId !== '') {
    if (typeof labId !== 'string' || labId.trim().length > 50) {
      throw new ToolArgumentError('bad_lab', 'labId 必须是 50 字以内的房号字符串');
    }
    out.labId = labId.trim();
  }
  return out;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function objArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
}

/**
 * 名单兼容两种形态：**姓名字符串数组**（31 人）与对象数组。
 * 只按对象取 name 会把字符串名单整体丢成空表 → 用户读到"0 名志愿者"。
 */
export function normalizePersons(v: unknown): Array<{ name: string; className: string; group: string }> {
  if (!Array.isArray(v)) return [];
  return v.map((p): { name: string; className: string; group: string } | null => {
    if (typeof p === 'string') return p.trim() ? { name: p.trim(), className: '', group: '' } : null;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const o = p as Record<string, unknown>;
      const name = String(o['name'] || '').trim();
      return name ? { name, className: String(o['className'] || ''), group: String(o['group'] || '') } : null;
    }
    return null;
  }).filter((p): p is { name: string; className: string; group: string } => p !== null);
}

/** 未接入呈现：即便上游缺字段，也把「尚未导入」显式落到结果里，杜绝把空当事实 */
export async function runQueryTermSchedule(args: TermScheduleArgs, signal?: AbortSignal): Promise<TermScheduleResult> {
  const q = new URLSearchParams();
  if (args.date) q.set('date', args.date);
  if (args.periodKey) q.set('periodKey', args.periodKey);
  if (args.labId) q.set('labId', args.labId);
  const suffix = q.toString() ? '?' + q.toString() : '';
  const raw = await businessRequest('/term-schedule' + suffix, 'GET', undefined, signal) as Record<string, unknown>;

  const t = (raw['termSchedule'] && typeof raw['termSchedule'] === 'object' ? raw['termSchedule'] : {}) as Record<string, unknown>;
  const v = (raw['volunteerSchedule'] && typeof raw['volunteerSchedule'] === 'object' ? raw['volunteerSchedule'] : {}) as Record<string, unknown>;
  const tImported = t['enabled'] === true && t['notImported'] !== true;
  const vImported = v['enabled'] === true && v['notImported'] !== true;

  return {
    contractVersion: typeof raw['contractVersion'] === 'number' ? raw['contractVersion'] : 3,
    date: String(raw['date'] || ''),
    queriedAt: String(raw['queriedAt'] || ''),
    sourceRevision: String(raw['sourceRevision'] || ''),
    termSchedule: {
      enabled: tImported,
      notImported: !tImported,
      term: String(t['term'] || ''),
      weeks: typeof t['weeks'] === 'number' ? t['weeks'] : null,
      week: typeof t['week'] === 'number' ? t['week'] : null,
      weekday: typeof t['weekday'] === 'number' ? t['weekday'] : null,
      sessions: objArray(t['sessions']),
      cancelled: objArray(t['cancelled']),
      changes: objArray(t['changes']),
      notes: strArray(t['notes'])
    },
    volunteerSchedule: {
      enabled: vImported,
      notImported: !vImported,
      days: objArray(v['days']),
      persons: normalizePersons(v['persons']),
      personsMissingProfile: strArray(v['personsMissingProfile']),
      expected: (v['expected'] && typeof v['expected'] === 'object')
        ? v['expected'] as TermScheduleResult['volunteerSchedule']['expected'] : null,
      dutyRoom: (v['dutyRoom'] && typeof v['dutyRoom'] === 'object')
        ? v['dutyRoom'] as Record<string, unknown> : null
    },
    hint: (!tImported || !vImported)
      ? '学期安排或志愿者值班表尚未导入，请如实告知用户并提示联系管理员；不得把空数组表述为「无课/无人值班」。'
      : '数据来自主系统独立只读档案，不参与课表实时解算；如与现场不一致，以管理员确认后的数据为准。'
  };
}
