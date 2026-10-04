import { effectiveSchedule, calendar } from '../data/calendar.ts';
/**
 * 只读工具：query_schedule
 * ============================================================================
 *  职责边界：**只查课表，只读，绝不写**。查询逻辑与模型适配层完全分离 ——
 *  拿掉 Agnes，这个函数照样能被单测直接调用（验收要求：可替换数据源的只读工具）。
 *
 *  口径逐条对齐老系统 Pages/lib/lab-time.js（兼容性红线，不得"优化"）：
 *    · weekday 用 getDay() 语义（0=周日..6=周六）
 *    · term 不等则跳过（行有 term 且学期配置有 term 时才比）
 *    · status === 'cancelled' 跳过
 *    · 周次过滤 weekMatches()，教学周不可确定时不过滤（并如实声明）
 *    · 同一实验室同一节次命中多个班 → 各自成行（合班时 classNames 多于 1）
 */

import type { QueryScheduleArgs, ScheduleLesson, ScheduleQueryResult } from '../../shared/types.ts';
import type { Dataset, LabRow, TimetableRow } from '../data/store.ts';
import { findLab, findOpenLab, normalizeLabName } from '../data/store.ts';
import {
  APP_TZ,
  APP_TZ_OFFSET,
  describeWeek,
  isHoliday,
  isValidDateString,
  weekdayLabelOf,
  weekdayOf
} from '../time/term.ts';
import type { ServerNow } from '../time/term.ts';
import { PERIODS, periodByKey } from '../../shared/periods.ts';
import type { PeriodKey } from '../../shared/periods.ts';

/** 工具参数非法 —— 由上层翻译成 tool_result.ok=false，再由模型纠正或直接回话 */
export class ToolArgumentError extends Error {
  readonly code: string;
  readonly suggestions: string[];
  constructor(code: string, message: string, suggestions: string[] = []) {
    super(message);
    this.name = 'ToolArgumentError';
    this.code = code;
    this.suggestions = suggestions;
  }
}

const PERIOD_ORDER = new Map<string, number>(PERIODS.map((p, i) => [p.key, i]));

export function runQuerySchedule(
  args: QueryScheduleArgs,
  ds: Dataset,
  now: ServerNow
): ScheduleQueryResult {
  // ---------- 1. 参数校验（服务端白名单 + 类型校验，不信模型给的任何东西）----------
  const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : now.date;
  if (!isValidDateString(date)) {
    throw new ToolArgumentError(
      'bad_date',
      `date 参数不是合法的 YYYY-MM-DD 日期：${String(args.date)}（服务端当前日期为 ${now.date}）`
    );
  }

  const periodFilterRaw = args.periodKey;
  let periodFilter: PeriodKey | null = null;
  if (periodFilterRaw !== undefined && periodFilterRaw !== null && String(periodFilterRaw).trim() !== '') {
    const p = periodByKey(String(periodFilterRaw).trim());
    if (!p) {
      throw new ToolArgumentError(
        'bad_period',
        `periodKey 只能是 ${PERIODS.map((x) => x.key).join(' / ')}，收到：${String(periodFilterRaw)}`
      );
    }
    periodFilter = p.key;
  }

  const rawLabName = typeof args.labName === 'string' ? args.labName.trim() : '';
  if (!rawLabName) {
    throw new ToolArgumentError(
      'missing_lab',
      '第一阶段必须指定 labName（房间号），否则结果无法收敛到可读规模',
      availableRoomNames(ds)
    );
  }

  // ---------- 2. 找房间（普通实验室 + 开放实验室都认）----------
  const lab: LabRow | null = findLab(ds, rawLabName) ?? findOpenLab(ds, rawLabName);

  const weekday = weekdayOf(date);
  const week = describeWeek(date, ds.term);
  const holiday = isHoliday(date, ds.term);

  const notes: string[] = [];
  if (!week.determinable) {
    notes.push(`⚠️ ${week.note}；以下结果**未做周次过滤**，列出的是该星期几的全部排课，可能包含非本周的课`);
  } else {
    notes.push(week.note);
  }
  if (holiday) notes.push(`⚠️ ${date} 在学期配置中被标记为假期`);

  const provenance: ScheduleQueryResult['provenance'] = {
    sourceType: ds.sourceType,
    sourceLabel: ds.sourceLabel,
    ...(ds.meta.snapshotAt ? { snapshotAt: ds.meta.snapshotAt } : {}),
    ...(ds.meta.sourceSha256Prefix ? { sourceSha256Prefix: ds.meta.sourceSha256Prefix } : {}),
    queryTime: now.iso,
    timezone: `${APP_TZ} (UTC${APP_TZ_OFFSET})`,
    coverage:
      ds.sourceType === 'live'
        ? '实时数据：经授权读取原系统排课，来源与读取时间见查询信息'
        : ds.sourceType === 'snapshot'
          ? '脱敏快照：从真实 state.json 导出后已脱敏（教师姓名伪名化，不含用户/名册/凭据），非实时'
          : '模拟演示：内置构造的示例数据，与真实实验室无关，仅用于验证链路'
  };

  const base: Omit<ScheduleQueryResult, 'lessons' | 'byPeriod' | 'reason'> = {
    labId: lab?.id ?? null,
    labName: lab?.name ?? null,
    labLocation: lab?.location ?? null,
    labStatus: (lab?.status as ScheduleQueryResult['labStatus']) ?? null,
    date,
    weekday,
    weekdayLabel: weekdayLabelOf(date),
    periodFilter,
    term: ds.term.term,
    weekNo: week.weekNo,
    weekDeterminable: week.determinable,
    weekNote: week.note,
    suggestions: [],
    notes,
    provenance
  };

  // ---------- 3. 房间不存在：明确说没有，并给出可选房号（不编造）----------
  if (!lab) {
    const names = availableRoomNames(ds);
    base.suggestions = names;
    base.notes.push(
      names.length
        ? `本系统收录的房间号共 ${names.length} 个：${names.join('、')}`
        : '本系统当前未收录任何房间'
    );
    return { ...base, lessons: [], byPeriod: emptyByPeriod(), reason: 'lab_not_found' };
  }

  // ---------- 4. 课表整体为空 ----------
  if (ds.timetable.length === 0) {
    return { ...base, lessons: [], byPeriod: emptyByPeriod(), reason: 'timetable_empty' };
  }

  // ---------- 5. 过滤 ----------
  const labKey = normalizeLabName(lab.name);
  const sameWeekday = ds.timetable.filter(
    (row) => Number(row.weekday) === weekday && normalizeLabName(row.labName) === labKey
  );

  const matched: TimetableRow[] = effectiveSchedule(ds,date).filter(row => normalizeLabName(row.labName) === labKey && (!periodFilter || row.periodKey === periodFilter));
  const statistics = calendar.stats(matched);
  notes.push(`统计口径：${statistics.recordCount} 条班级展开记录、${statistics.activityCount} 个教学活动、${statistics.classCount} 个班级、${statistics.occupiedPeriodCount} 个占用大节。`);
  if (statistics.conflicts.length) notes.push(`⚠️ 存在 ${statistics.conflicts.length} 个疑似冲突时段，须核实合班或导入数据；不能据此确认房间可用。`);

  // ---------- 6. 展开成 lessons（合班时每班一条，与老系统一致）----------
  const lessons: ScheduleLesson[] = [];
  for (const row of matched) {
    const p = periodByKey(row.periodKey);
    if (!p) continue; // 节次不认识 → 跳过并留痕，不猜
    const names = row.classNames.length ? row.classNames : row.className ? [row.className] : [''];
    for (const cn of names) {
      lessons.push({
        timetableId: row.id,
        periodKey: p.key,
        periodLabel: p.label,
        startTime: p.start,
        endTime: p.end,
        courseName: row.courseName || '（课程名未录入）',
        teacher: row.teacher || '（未录入）',
        classNames: names,
        className: cn,
        merged: names.length > 1,
        labId: row.labId || lab.id,
        labName: row.labName || lab.name,
        term: row.term,
        weeks: row.weeks,
        updatedAt: row.updatedAt
      });
    }
  }

  lessons.sort((a, b) => {
    const d = (PERIOD_ORDER.get(a.periodKey) ?? 99) - (PERIOD_ORDER.get(b.periodKey) ?? 99);
    if (d !== 0) return d;
    return a.courseName.localeCompare(b.courseName, 'zh-Hans-CN');
  });

  // ---------- 7. 原因判定（顺序即优先级，前端按码渲染，不靠猜文案）----------
  let reason: ScheduleQueryResult['reason'];
  if (lessons.length > 0) {
    reason = 'ok';
    if (lab.status !== 'active') {
      notes.push(`注意：该房间当前状态为「${lab.status === 'inactive' ? '停用/修整' : lab.status}」，排课信息仍然有效，但现场可能无法使用`);
    }
  } else if (holiday) {
    reason = 'no_class_that_day';
  } else if (periodFilter) {
    reason = 'no_class_in_that_period';
  } else if (lab.status !== 'active') {
    reason = 'lab_not_active';
  } else {
    reason = 'no_class_that_day';
  }

  if (reason === 'no_class_that_day' && sameWeekday.length > 0) {
    // 该星期几有排课，但本周被周次/单双周过滤掉了 —— 这是最容易误判"没课"的地方，必须说清
    notes.push(
      `该房间在${weekdayLabelOf(date)}共有 ${sameWeekday.length} 条排课记录，但按当前周次（${
        week.weekNo === null ? '未知' : `第 ${week.weekNo} 周` })过滤后均不落在本周`
    );
  }
  if (reason === 'ok' && lessons.length > 0) {
    notes.push(`该房间在${weekdayLabelOf(date)}当天的排课共 ${lessons.length} 条（合班已按班展开）`);
  }

  return { ...base, lessons, byPeriod: aggregateByPeriod(lessons), reason };
}

function emptyByPeriod(): ScheduleQueryResult['byPeriod'] {
  return PERIODS.map((p) => ({
    periodKey: p.key,
    periodLabel: p.label,
    startTime: p.start,
    endTime: p.end,
    count: 0
  }));
}

function aggregateByPeriod(lessons: ScheduleLesson[]): ScheduleQueryResult['byPeriod'] {
  const counts = new Map<string, number>();
  for (const l of lessons) counts.set(l.periodKey, (counts.get(l.periodKey) ?? 0) + 1);
  return PERIODS.map((p) => ({
    periodKey: p.key,
    periodLabel: p.label,
    startTime: p.start,
    endTime: p.end,
    count: counts.get(p.key) ?? 0
  }));
}

export function availableRoomNames(ds: Dataset): string[] {
  return [...ds.labs, ...ds.openLabs]
    .map((l) => l.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
}
