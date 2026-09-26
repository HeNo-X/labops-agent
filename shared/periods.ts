/**
 * 六节次定义 —— 全项目唯一事实来源
 * ============================================================================
 *  前车之鉴：老系统把六节次硬编码在 6 个文件里，改一次作息要改 6 处，还导致
 *  「同一时刻、同一实验室、四个入口行为不一致」。这里只写一份，前后端共用。
 *
 *  与老系统 Pages/lib/lab-time.js 口径一致（这是兼容性红线，不得"优化"）：
 *    am1 08:20-09:50   am2 10:10-11:40   pm1 14:00-15:30
 *    pm2 15:50-17:20   eve_ab 17:30-19:00   eve_cd 19:10-20:40
 *
 *  ⚠️ 老系统里写成 '8:20'（不补零）并留有"直接比较字符串会得到错误结果"的血泪注释。
 *     本文件统一补零为 '08:20'，但**任何比较都必须先走 toMinutes()**，禁止比字符串。
 */

export const PERIOD_KEYS = ['am1', 'am2', 'pm1', 'pm2', 'eve_ab', 'eve_cd'] as const;

export type PeriodKey = (typeof PERIOD_KEYS)[number];

export interface PeriodDef {
  key: PeriodKey;
  label: string;
  /** HH:mm（补零） */
  start: string;
  /** HH:mm（补零） */
  end: string;
}

export const PERIODS: readonly PeriodDef[] = Object.freeze([
  { key: 'am1', label: '上午第一大节', start: '08:20', end: '09:50' },
  { key: 'am2', label: '上午第二大节', start: '10:10', end: '11:40' },
  { key: 'pm1', label: '下午第一大节', start: '14:00', end: '15:30' },
  { key: 'pm2', label: '下午第二大节', start: '15:50', end: '17:20' },
  { key: 'eve_ab', label: '晚上AB节', start: '17:30', end: '19:00' },
  { key: 'eve_cd', label: '晚上CD节', start: '19:10', end: '20:40' }
]);

const PERIOD_INDEX: Record<string, PeriodDef> = Object.fromEntries(PERIODS.map((p) => [p.key, p]));

export function isPeriodKey(v: unknown): v is PeriodKey {
  return typeof v === 'string' && v in PERIOD_INDEX;
}

export function periodByKey(key: unknown): PeriodDef | null {
  return isPeriodKey(key) ? PERIOD_INDEX[key] : null;
}

/** 'HH:mm' → 当日分钟数。禁止对时间字符串做直接比较。 */
export function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':');
  return Number(h) * 60 + Number(m || 0);
}

/**
 * weekday 语义 —— 与老系统 `tt.weekday === date.getDay()` 完全一致：
 *   0 = 周日, 1 = 周一, 2 = 周二, 3 = 周三, 4 = 周四, 5 = 周五, 6 = 周六
 * 真实课表里出现过的 weekday 取值是 1..6（没有 0，即周日无排课）。
 */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function weekdayLabel(weekday: number): string {
  const i = Number(weekday);
  return Number.isInteger(i) && i >= 0 && i <= 6 ? WEEKDAY_LABELS[i] : `未知(${weekday})`;
}

/** 中文星期词 → getDay() 语义的编号。"星期三"/"周三"/"礼拜三" 都能认。 */
export const WEEKDAY_WORDS: Readonly<Record<string, number>> = Object.freeze({
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
  星期日: 0, 星期天: 0, 星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6,
  周日: 0, 周天: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6,
  礼拜日: 0, 礼拜天: 0, 礼拜一: 1, 礼拜二: 2, 礼拜三: 3, 礼拜四: 4, 礼拜五: 5, 礼拜六: 6
});
