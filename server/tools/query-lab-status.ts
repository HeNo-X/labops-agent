/**
 * 只读工具：query_lab_status —— 房间档案 + 该日排课统计（阶段 2A）
 * ============================================================================
 *  数据全部来自现有的 labs / openLabs / timetable，零编造。
 *  ⚠️ 在室人数（occupancy）永远返回 null：本系统没有任何签到/门禁数据来源，
 *     无论是工具、界面还是模型话术都不允许给出人数 —— 没有数据就明说没有。
 */

import type { LabStatusArgs, LabStatusResult, ScheduleQueryResult } from '../../shared/types.ts';
import type { Dataset, LabRow, TimetableRow } from '../data/store.ts';
import { findLab, findOpenLab, normalizeLabName } from '../data/store.ts';
import { APP_TZ, APP_TZ_OFFSET, describeWeek, isHoliday, isValidDateString, weekMatches, weekdayLabelOf, weekdayOf } from '../time/term.ts';
import { PERIODS, toMinutes } from '../../shared/periods.ts';
import { ToolArgumentError, availableRoomNames } from './query-schedule.ts';
import type { ServerNow } from '../time/term.ts';

const STATUS_LABELS: Record<string, string> = {
  active: '开放',
  closed: '关闭',
  inactive: '停用/修整'
};

export function runQueryLabStatus(
  args: LabStatusArgs,
  ds: Dataset,
  now: ServerNow
): LabStatusResult {
  const rawLabName = typeof args.labName === 'string' ? args.labName.trim() : '';
  if (!rawLabName) {
    throw new ToolArgumentError(
      'missing_lab',
      'query_lab_status 必须指定 labName（房间号）',
      availableRoomNames(ds)
    );
  }

  const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : now.date;
  if (!isValidDateString(date)) {
    throw new ToolArgumentError(
      'bad_date',
      `date 参数不是合法的 YYYY-MM-DD 日期：${String(args.date)}（服务端当前日期为 ${now.date}）`
    );
  }

  const lab: LabRow | null = findLab(ds, rawLabName) ?? findOpenLab(ds, rawLabName);
  const base = {
    date,
    weekdayLabel: weekdayLabelOf(date),
    term: ds.term.term,
    suggestions: [] as string[],
    provenance: {
      sourceType: ds.sourceType,
      sourceLabel: ds.sourceLabel,
      ...(ds.meta.snapshotAt ? { snapshotAt: ds.meta.snapshotAt } : {}),
      ...(ds.meta.sourceSha256Prefix ? { sourceSha256Prefix: ds.meta.sourceSha256Prefix } : {}),
      queryTime: now.iso,
      timezone: `${APP_TZ} (UTC${APP_TZ_OFFSET})`,
      coverage:
        ds.sourceType === 'live'
          ? '实时数据：直接读取当前真实 state.json'
          : ds.sourceType === 'snapshot'
            ? '脱敏快照：从真实 state.json 导出后已脱敏，非实时'
            : '模拟演示：内置构造的示例数据，与真实实验室无关'
    } satisfies ScheduleQueryResult['provenance']
  };

  if (!lab) {
    const names = availableRoomNames(ds);
    return {
      ...base,
      labId: null,
      labName: null,
      labLocation: null,
      capacity: null,
      status: null,
      statusLabel: '未知',
      description: '',
      weekNo: null,
      weekDeterminable: false,
      schedule: { lessonCount: 0, occupiedPeriods: [], nextLesson: null, nextLessonReason: 'unknown' },
      occupancy: null,
      registryStatusNote: '',
      suggestions: names,
      notes: [
        `系统里没有收录房间号「${rawLabName}」`,
        names.length ? `本系统收录的房间号共 ${names.length} 个：${names.join('、')}` : '本系统当前未收录任何房间'
      ]
    };
  }

  const weekday = weekdayOf(date);
  const week = describeWeek(date, ds.term);
  const holiday = isHoliday(date, ds.term);

  const notes: string[] = [week.note];
  if (!week.determinable) notes.push('⚠️ 教学周不可确定，以下排课统计未做周次过滤');
  if (holiday) notes.push(`⚠️ ${date} 在学期配置中被标记为假期`);
  // F19：档案状态 ≠ 实时门禁。措辞必须避免把静态档案解释成"此刻能否进入"
  notes.push('开放状态来自房间档案（随数据快照更新），不是实时门禁——实际此刻能否进入以现场为准');
  notes.push('在室人数没有数据来源（无签到/门禁数据），本工具无法提供，请勿据此回答人数问题');

  const labKey = normalizeLabName(lab.name);
  const matched: TimetableRow[] =
    ds.timetable.filter(
      (row) =>
        Number(row.weekday) === weekday &&
        normalizeLabName(row.labName) === labKey &&
        row.status !== 'cancelled' &&
        (!row.term || !ds.term.term || row.term === ds.term.term) &&
        (week.determinable ? weekMatches(row.weeks, week.weekNo) : true)
    ) ?? [];

  const occupiedPeriods: LabStatusResult['schedule']['occupiedPeriods'] = [];
  for (const p of PERIODS) {
    const rows = matched.filter((r) => r.periodKey === p.key);
    if (!rows.length) continue;
    occupiedPeriods.push({
      periodKey: p.key,
      periodLabel: p.label,
      startTime: p.start,
      endTime: p.end,
      courseNames: [...new Set(rows.map((r) => r.courseName || '（课程名未录入）'))]
    });
  }

  // 下一节课：仅对"今天"计算（F18）；非当天显式标注不适用，绝不冒充"当天无更多排课"
  let nextLesson: LabStatusResult['schedule']['nextLesson'] = null;
  let nextLessonReason: LabStatusResult['schedule']['nextLessonReason'];
  if (!week.determinable) {
    nextLessonReason = 'unknown';
  } else if (date !== now.date) {
    nextLessonReason = 'not_applicable';
  } else {
    const upcoming = occupiedPeriods
      .filter((p) => toMinutes(p.startTime) >= toMinutes(now.time))
      .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime))[0];
    if (upcoming) {
      nextLesson = {
        periodLabel: upcoming.periodLabel,
        startTime: upcoming.startTime,
        courseName: upcoming.courseNames[0] ?? ''
      };
    }
    nextLessonReason = 'no_more_today';
  }

  return {
    ...base,
    labId: lab.id,
    labName: lab.name,
    labLocation: lab.location,
    capacity: lab.capacity,
    status: (lab.status as LabStatusResult['status']) ?? null,
    statusLabel: STATUS_LABELS[lab.status] ?? `未知(${lab.status})`,
    description: lab.description,
    weekNo: week.weekNo,
    weekDeterminable: week.determinable,
    schedule: {
      lessonCount: matched.length,
      occupiedPeriods,
      nextLesson,
      nextLessonReason
    },
    occupancy: null,
    registryStatusNote: `档案状态「${STATUS_LABELS[lab.status] ?? lab.status}」随数据快照更新，非实时门禁`,
    suggestions: [],
    notes
  };
}

/** 供注册表做参数收敛 */
export function coerceLabStatusArgs(raw: Record<string, unknown>): LabStatusArgs {
  const out: LabStatusArgs = {};
  const labName = raw['labName'];
  if (typeof labName === 'string' && labName.trim()) out.labName = labName.trim();
  const date = raw['date'];
  if (typeof date === 'string' && date.trim()) out.date = date.trim();
  return out;
}
