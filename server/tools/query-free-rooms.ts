/**
 * 只读工具：query_free_rooms —— 找空实验室（阶段 2A）
 * ============================================================================
 *  「明天下午第二大节哪些实验室空着」的正解。与 query_schedule 同源同口径：
 *  一个房间在某节次"空闲" = 该节次没有命中周次的排课（停课、跨学期、周次/单双周
 *  过滤与 query_schedule 完全一致 —— 这不是巧合，是同一条过滤链）。
 *
 *  ⚠️ 空闲 ≠ 无人：没有签到数据，"空闲"只表示课表上没有排课，界面与模型话术都要带这层说明。
 */

import type { FreeRoomsArgs, FreeRoomsResult, ScheduleQueryResult } from '../../shared/types.ts';
import type { Dataset, TimetableRow } from '../data/store.ts';
import { normalizeLabName } from '../data/store.ts';
import { APP_TZ, APP_TZ_OFFSET, describeWeek, isHoliday, isValidDateString, weekMatches, weekdayLabelOf, weekdayOf } from '../time/term.ts';
import type { ServerNow } from '../time/term.ts';
import { PERIODS, periodByKey } from '../../shared/periods.ts';
import type { PeriodKey } from '../../shared/periods.ts';
import { ToolArgumentError } from './query-schedule.ts';

export function runQueryFreeRooms(
  args: FreeRoomsArgs,
  ds: Dataset,
  now: ServerNow
): FreeRoomsResult {
  const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : now.date;
  if (!isValidDateString(date)) {
    throw new ToolArgumentError(
      'bad_date',
      `date 参数不是合法的 YYYY-MM-DD 日期：${String(args.date)}（服务端当前日期为 ${now.date}）`
    );
  }

  let periodFilter: PeriodKey | null = null;
  if (args.periodKey !== undefined && args.periodKey !== null && String(args.periodKey).trim() !== '') {
    const p = periodByKey(String(args.periodKey).trim());
    if (!p) {
      throw new ToolArgumentError(
        'bad_period',
        `periodKey 只能是 ${PERIODS.map((x) => x.key).join(' / ')}，收到：${String(args.periodKey)}`
      );
    }
    periodFilter = p.key;
  }

  const weekday = weekdayOf(date);
  const week = describeWeek(date, ds.term);
  const holiday = isHoliday(date, ds.term);

  const notes: string[] = [week.note];
  if (!week.determinable) notes.push('⚠️ 教学周不可确定，以下结果未做周次过滤，可能包含非本周的占用');
  if (holiday) notes.push(`⚠️ ${date} 在学期配置中被标记为假期`);
  notes.push('「空闲」指课表上无排课，不代表房间内无人（无签到数据）');
  notes.push('开放状态来自房间档案；关闭/停用的房间即使课表空闲也建议先确认是否可借用');

  const periodsToList = periodFilter ? PERIODS.filter((p) => p.key === periodFilter) : PERIODS;

  // 该星期几、当前学期、未停课、周次匹配的全部排课（教学周不可确定时不过滤并声明）
  const dayRows: TimetableRow[] = ds.timetable.filter(
    (row) =>
      Number(row.weekday) === weekday &&
      row.status !== 'cancelled' &&
      (!row.term || !ds.term.term || row.term === ds.term.term) &&
      (week.determinable ? weekMatches(row.weeks, week.weekNo) : true)
  );

  const rooms = [...ds.labs, ...ds.openLabs].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  );

  const freeByPeriod: FreeRoomsResult['freeByPeriod'] = periodsToList.map((p) => {
    const busy = new Set(
      dayRows.filter((r) => r.periodKey === p.key).map((r) => normalizeLabName(r.labName))
    );
    return {
      periodKey: p.key,
      periodLabel: p.label,
      startTime: p.start,
      endTime: p.end,
      rooms: rooms
        .filter((l) => !busy.has(normalizeLabName(l.name)))
        .map((l) => ({
          labName: l.name,
          location: l.location,
          status: (l.status as FreeRoomsResult['freeByPeriod'][number]['rooms'][number]['status']) ?? null,
          capacity: l.capacity
        }))
    };
  });

  const provenance: ScheduleQueryResult['provenance'] = {
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
  };

  return {
    date,
    weekdayLabel: weekdayLabelOf(date),
    periodFilter,
    term: ds.term.term,
    weekNo: week.weekNo,
    weekDeterminable: week.determinable,
    freeByPeriod,
    notes,
    provenance
  };
}

/** 供注册表做参数收敛 */
export function coerceFreeRoomsArgs(raw: Record<string, unknown>): FreeRoomsArgs {
  const out: FreeRoomsArgs = {};
  const date = raw['date'];
  if (typeof date === 'string' && date.trim()) out.date = date.trim();
  const periodKey = raw['periodKey'];
  if (typeof periodKey === 'string' && periodKey.trim()) out.periodKey = periodKey.trim() as PeriodKey;
  return out;
}
