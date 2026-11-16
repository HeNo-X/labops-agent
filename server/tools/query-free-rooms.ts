import { calendar,effectiveSchedule } from '../data/calendar.ts';
import { closuresFor } from '../data/closures.ts';
/**
 * 只读工具：query_free_rooms —— 找空实验室
 * ============================================================================
 *  「明天下午哪些实验室空着」的正解。与 query_schedule 同源同口径：
 *  一个房间在某节次"空闲" = 该节次没有命中周次的排课（停课、跨学期、周次/单双周
 *  过滤与 query_schedule 完全一致）。
 *
 *  事实边界：
 *    · coverage='complete' 仅当课表数据非空——空表不能从"没有记录"推出"全部空闲"；
 *    · rooms[] 只列**档案开放**的房间；关闭/停用进 excluded[] 并给理由；
 *    · 「空闲」= 课表无排课 ≠ 室内无人 ≠ 可预约，notes 固定声明。
 */

import type { FreeRoomsArgs, FreeRoomsResult, ScheduleQueryResult } from '../../shared/types.ts';
import type { Dataset, TimetableRow } from '../data/store.ts';
import { normalizeLabName } from '../data/store.ts';
import { APP_TZ, APP_TZ_OFFSET, describeWeek, isHoliday, isValidDateString, weekdayLabelOf } from '../time/term.ts';
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

  // 支持节次范围（如"下午"= pm1+pm2）；periodKey 仍兼容
  let wanted: PeriodKey[];
  if (args.periodKey !== undefined && args.periodKey !== null && String(args.periodKey).trim() !== '') {
    const p = periodByKey(String(args.periodKey).trim());
    if (!p) {
      throw new ToolArgumentError(
        'bad_period',
        `periodKey 只能是 ${PERIODS.map((x) => x.key).join(' / ')}，收到：${String(args.periodKey)}`
      );
    }
    wanted = [p.key];
  } else if (Array.isArray(args.periodKeys) && args.periodKeys.length) {
    wanted = [];
    for (const raw of args.periodKeys) {
      const p = periodByKey(String(raw).trim());
      if (!p) {
        throw new ToolArgumentError(
          'bad_period',
          `periodKeys 里含非法节次：${String(raw)}（合法值：${PERIODS.map((x) => x.key).join(' / ')}）`
        );
      }
      if (!wanted.includes(p.key)) wanted.push(p.key);
    }
  } else {
    wanted = [...PERIODS.map((p) => p.key)];
  }

  const week = describeWeek(date, ds.term);
  const holiday = isHoliday(date, ds.term);

  // 覆盖判断以数据契约为准 —— termEnd 缺失就不能证明任何日期的完整覆盖，
  // 绝不用"教学周不超过 N 周"之类的臆造阈值代替证明。
  let coverage: FreeRoomsResult['coverage'];
  if (ds.timetable.length === 0) {
    coverage = 'missing';
  } else if (ds.term.termEnd && ds.term.termStart) {
    coverage = date >= ds.term.termStart && date <= ds.term.termEnd ? 'complete' : 'out_of_range';
    if (coverage === 'complete' && (!week.determinable || week.weekNo === null)) coverage = 'unknown';
  } else {
    coverage = 'unknown';
  }

  if(ds.principal?.identity==='student')coverage='unknown';
  const notes: string[] = [week.note];
  if(ds.principal?.identity==='student')notes.push('学生通道仅提供本人课表，不能据此确认其他班级占用；候选空闲状态保留未知，请查询房间的公开教学状态。');
  if (!week.determinable) notes.push('⚠️ 教学周不可确定，以下结果未做周次过滤，可能包含非本周的占用');
  if (holiday) notes.push(`⚠️ ${date} 在学期配置中被标记为假期`);
  if (coverage === 'missing') {
    notes.push('⚠️ 系统内课表数据为空，无法判断哪些房间空闲——本结果不可作为找空房间的依据');
  } else if (coverage === 'out_of_range') {
    notes.push(`⚠️ 日期超出学期覆盖范围（${ds.term.termStart ?? '?'} ~ ${ds.term.termEnd ?? '?'}），无法判断空闲——本结果不可作为依据`);
  } else if (coverage === 'unknown') {
    notes.push('⚠️ 学期结束日未配置（或教学周不可确定），无法证明该日期的课表完整覆盖——以下候选状态未知，不能当作确认空闲');
  }
  notes.push('「空闲」指课表上无排课，不代表房间内无人，也不代表可以预约借用');
  notes.push('主名单使用同源人员开放登记，无登记时回退档案；档案停用仍排除。登记不是门禁传感器，也不保证未来日期可以进入');

  const periodsToList = PERIODS.filter((p) => wanted.includes(p.key));

  // 该星期几、当前学期、未停课、周次匹配的全部排课（教学周不可确定时不过滤并声明）
  const dayRows: TimetableRow[] = effectiveSchedule(ds,date);

  // 档案开放 → 主名单；关闭/停用 → excluded 并给理由
  const allRooms = [...ds.labs, ...ds.openLabs].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  );
  const activeRooms = allRooms.filter((l) => l.status!=='inactive'&&calendar.roomState(l,ds,date).door==='open');
  const excluded = allRooms
    .filter((l) => !activeRooms.includes(l))
    .map((l) => ({
      labName: l.name,
      location: l.location,
      status: l.status==='inactive'?'inactive' as const:'closed' as const,
      reason: l.status === 'inactive' ? '档案状态：停用/修整' : calendar.roomState(l,ds,date).doorNote
    }));

  const freeByPeriod: FreeRoomsResult['freeByPeriod'] = periodsToList.map((p) => {
    const busy = new Set(
      dayRows.filter((r) => r.periodKey === p.key).map((r) => normalizeLabName(r.labName))
    );
    return {
      periodKey: p.key,
      periodLabel: p.label,
      startTime: p.start,
      endTime: p.end,
      // 非 complete 覆盖时绝不输出"已确认空闲"名单
      rooms:
        coverage === 'complete'
          ? activeRooms
              .filter((l) => !busy.has(normalizeLabName(l.name)) && !closuresFor(ds,date,p.key).some(c => c.roomId===l.id || normalizeLabName(c.roomId) === normalizeLabName(l.name)))
              .map((l) => ({
                labName: l.name,
                location: l.location,
                status: 'active' as const,
                capacity: l.capacity
              }))
          : []
    };
  });

  if (closuresFor(ds,date).length) notes.push(ds.sourceType==='live'?'已依据原系统同版本临时停用范围逐节次排除房间。':'已按快照及当前身份的沙盒停用记录排除，不能当作原系统当前状态。');
  for (const l of activeRooms) {
    const blocked=periodsToList.filter(p=>closuresFor(ds,date,p.key).some(c=>c.roomId===l.id||normalizeLabName(c.roomId)===normalizeLabName(l.name)));
    if(blocked.length) excluded.push({labName:l.name,location:l.location,status:'inactive',reason:'临时停用：'+blocked.map(p=>p.label).join('、')});
  }
  const provenance: ScheduleQueryResult['provenance'] = {
    sourceRevision: ds.sourceRevision,
    sourceType: ds.sourceType,
      ...(ds.sourceRevision?{sourceRevision:ds.sourceRevision}:{}),
    sourceLabel: ds.sourceLabel,
    ...(ds.meta.snapshotAt ? { snapshotAt: ds.meta.snapshotAt } : {}),
    ...(ds.meta.sourceSha256Prefix ? { sourceSha256Prefix: ds.meta.sourceSha256Prefix } : {}),
    queryTime: now.iso,
    timezone: `${APP_TZ} (UTC${APP_TZ_OFFSET})`,
    coverage:
      ds.sourceType === 'live'
        ? '实时数据：经授权读取原系统业务数据，来源见查询信息'
        : ds.sourceType === 'snapshot'
          ? '脱敏快照：从真实 state.json 导出后已脱敏，非实时'
          : '内置示例：随仓库提供的示例数据，与真实实验室无关'
  };

  return {
    date,
    weekdayLabel: weekdayLabelOf(date),
    periodFilter: wanted.length === 1 ? wanted[0]! : null,
    periodKeys: wanted,
    coverage,
    term: ds.term.term,
    weekNo: week.weekNo,
    weekDeterminable: week.determinable,
    freeByPeriod,
    excluded,
    unknownCandidates: coverage === 'complete' ? [] : activeRooms.map((l) => l.name),
    notes,
    provenance
  };
}

/** 供注册表做参数收敛。显式非法的节次抛错而不是静默丢弃 */
export function coerceFreeRoomsArgs(raw: Record<string, unknown>): FreeRoomsArgs {
  const out: FreeRoomsArgs = {};
  const date = raw['date'];
  if (typeof date === 'string' && date.trim()) out.date = date.trim();
  else if (date !== undefined && date !== null && date !== '') {
    throw new ToolArgumentError('bad_date', `date 参数必须是字符串（YYYY-MM-DD），收到：${typeof date}`);
  }
  const periodKey = raw['periodKey'];
  if (typeof periodKey === 'string' && periodKey.trim()) out.periodKey = periodKey.trim() as PeriodKey;
  else if (periodKey !== undefined && periodKey !== null && periodKey !== '') {
    // 显式给了错误类型（如数字 999）也是参数错误，不能静默丢弃后放宽为全天
    throw new ToolArgumentError('bad_period', `periodKey 必须是字符串节次键，收到：${typeof periodKey}(${String(periodKey)})`);
  }
  const periodKeys = raw['periodKeys'];
  if (Array.isArray(periodKeys) && periodKeys.length) {
    out.periodKeys = periodKeys.map((k) => String(k).trim() as PeriodKey);
  } else if (periodKeys !== undefined && periodKeys !== null && periodKeys !== '') {
    throw new ToolArgumentError('bad_period', `periodKeys 必须是字符串数组，收到：${typeof periodKeys}(${String(periodKeys)})`);
  }
  return out;
}
