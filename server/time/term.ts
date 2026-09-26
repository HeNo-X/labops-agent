/**
 * 时间与教学周解算 —— 服务端唯一事实来源
 * ============================================================================
 *  难点 3 的对策：日期与周次**绝不让模型自己算**。所有时间判断走这里，
 *  结果以人话摘要注入模型上下文；模型只负责"选工具 + 组织语言"。
 *
 *  三点纪律：
 *   1. 不信任客户端时钟 —— 全部以服务端 Asia/Shanghai 为准。
 *   2. 日期运算用它自己的 'YYYY-MM-DD' 串 + UTC 基准，绝不用 Date 隐式解析
 *      （历史坑：`new Date('2026-09-26T9:50')` 在某些引擎得到 NaN，必须补零）。
 *   3. 教学周算不出来就返回 null，并如实说明"无法确定"，不猜。
 *
 *  口径来源：老系统 Pages/lib/lab-time.js 的 weekNo / weekMatches（兼容性红线）。
 *    · weekNo = floor((目标日 - termStart) / 7天) + 1；termStart 缺失或目标日早于
 *      termStart → null。
 *    · weekMatches：wn 为 null 时**返回 true**（宁可宽松，不可误判无课）；
 *      否则按 from..to 区间 + parity(all/odd/even) 过滤。
 */

import { WEEKDAY_LABELS } from '../../shared/periods.ts';

export const APP_TZ = 'Asia/Shanghai';
/** 自 1991 年起中国大陆不再实行夏令时，Asia/Shanghai 恒为 +08:00 */
export const APP_TZ_OFFSET = '+08:00';

export interface ServerNow {
  /** 带偏移的 ISO 8601，如 2026-09-26T15:38:30+08:00 */
  iso: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm:ss */
  time: string;
  /** 0=周日 .. 6=周六（与课表 weekday 同语义） */
  weekday: number;
  weekdayLabel: string;
}

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

export function serverNow(at: Date = new Date()): ServerNow {
  const date = dateFmt.format(at);
  const time = timeFmt.format(at);
  const weekday = weekdayOf(date);
  return {
    iso: `${date}T${time}${APP_TZ_OFFSET}`,
    date,
    time,
    weekday,
    weekdayLabel: WEEKDAY_LABELS[weekday]
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格校验 YYYY-MM-DD，并拒绝 2026-02-30 这类"格式对但日期不存在"的输入 */
export function isValidDateString(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const utc = Date.UTC(y, m - 1, d);
  const back = new Date(utc);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

export function parseDateUtc(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  // 用 UTC 构造：dateStr 本身已经是"上海当地日期"，不需要再做时区换算
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(dateStr: string, days: number): string {
  const t = parseDateUtc(dateStr).getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function weekdayOf(dateStr: string): number {
  return parseDateUtc(dateStr).getUTCDay();
}

export function weekdayLabelOf(dateStr: string): string {
  return WEEKDAY_LABELS[weekdayOf(dateStr)];
}

export function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((parseDateUtc(toDate).getTime() - parseDateUtc(fromDate).getTime()) / 86400000);
}

// ===========================================================================
//  教学周
// ===========================================================================

export interface TermConfig {
  term: string;
  termStart: string | null;
  holidays: string[];
  labMismatchPolicy?: string;
}

export interface WeekContext {
  /** null = 无法确定 */
  weekNo: number | null;
  /** false 时 lessons 未做周次过滤，界面与回答必须明说 */
  determinable: boolean;
  /** 给人和模型看的一句话说明 */
  note: string;
}

/**
 * 教学周解算。返回 null 的三种情况（都不猜，如实上报）：
 *   ① termStart 未配置 / 格式非法
 *   ② 目标日期早于 termStart
 */
export function weekNumber(dateStr: string, termStart: string | null | undefined): number | null {
  if (!termStart) return null;
  if (!isValidDateString(termStart)) return null;
  const diff = daysBetween(termStart, dateStr);
  if (diff < 0) return null;
  return Math.floor(diff / 7) + 1;
}

export function describeWeek(dateStr: string, term: TermConfig): WeekContext {
  if (!term.termStart) {
    return {
      weekNo: null,
      determinable: false,
      note: '学期起始日（termStart）未配置，无法确定该日期属于第几教学周'
    };
  }
  if (!isValidDateString(term.termStart)) {
    return {
      weekNo: null,
      determinable: false,
      note: `学期起始日格式非法（${term.termStart}），无法确定教学周`
    };
  }
  const wn = weekNumber(dateStr, term.termStart);
  if (wn === null) {
    return {
      weekNo: null,
      determinable: false,
      note: `目标日期 ${dateStr} 早于学期起始日 ${term.termStart}，不属于本学期的教学周`
    };
  }
  return {
    weekNo: wn,
    determinable: true,
    note: `学期 ${term.term}，起始日 ${term.termStart}，${dateStr} 是第 ${wn} 教学周（${wn % 2 === 1 ? '单周' : '双周'}）`
  };
}

export interface WeeksSpec {
  from?: number;
  to?: number;
  parity?: 'all' | 'odd' | 'even';
}

/**
 * 周次匹配。**与老系统口径一致**：wn 为 null（教学周不可确定）时返回 true，
 * 宁可宽松列出全部可能排课并声明"未做周次过滤"，也不误判成"没课"。
 */
export function weekMatches(weeks: WeeksSpec | undefined | null, wn: number | null): boolean {
  if (wn === null) return true;
  if (!weeks || typeof weeks !== 'object') return true;
  const from = Number(weeks.from ?? 1);
  const to = Number(weeks.to ?? 99);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  if (wn < from || wn > to) return false;
  const parity = weeks.parity ?? 'all';
  if (parity === 'odd' && wn % 2 === 0) return false;
  if (parity === 'even' && wn % 2 === 1) return false;
  return true;
}

export function isHoliday(dateStr: string, term: TermConfig): boolean {
  return Array.isArray(term.holidays) && term.holidays.includes(dateStr);
}

export function weeksLabel(weeks: WeeksSpec | undefined | null): string {
  if (!weeks) return '周次未标注';
  const from = weeks.from ?? 1;
  const to = weeks.to ?? 99;
  const parity = weeks.parity ?? 'all';
  const p = parity === 'odd' ? '单周' : parity === 'even' ? '双周' : '每周';
  return `${from}-${to}周 ${p}`;
}
