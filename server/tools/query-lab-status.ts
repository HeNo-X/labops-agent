import { effectiveSchedule } from '../data/calendar.ts';
import { closuresFor } from '../data/closures.ts';
import { isBusinessConnected, businessRequest } from '../business/bridge.ts';
/**
 * 只读工具：query_lab_status —— 房间档案 + 该日排课统计（阶段 2A）
 * ============================================================================
 *  数据全部来自现有的 labs / openLabs / timetable，零编造。
 *  ⚠️ 在室人数（occupancy）永远返回 null：本系统没有任何签到/门禁数据来源，
 *     无论是工具、界面还是模型话术都不允许给出人数 —— 没有数据就明说没有。
 */

import type { LabStatusArgs, LabStatusResult, ScheduleQueryResult } from '../../shared/types.ts';
import type { Dataset, LabRow, TimetableRow } from '../data/store.ts';
import { findLab, findOpenLab, normalizeLabName, findLabsByNameSuffix } from '../data/store.ts';
import { APP_TZ, APP_TZ_OFFSET, describeWeek, isHoliday, isValidDateString, weekdayLabelOf } from '../time/term.ts';
import { PERIODS, toMinutes } from '../../shared/periods.ts';
import { ToolArgumentError, availableRoomNames } from './query-schedule.ts';
import type { ServerNow } from '../time/term.ts';

const STATUS_LABELS: Record<string, string> = {
  active: '开放',
  closed: '关闭',
  inactive: '停用/修整'
};

export async function runQueryLabStatus(
  args: LabStatusArgs,
  ds: Dataset,
  now: ServerNow
): Promise<LabStatusResult> {
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

  let lab: LabRow | null = findLab(ds, rawLabName) ?? findOpenLab(ds, rawLabName);
  const base = {
    date,
    weekdayLabel: weekdayLabelOf(date),
    term: ds.term.term,
    suggestions: [] as string[],
    provenance: {
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
            : '模拟演示：内置构造的示例数据，与真实实验室无关'
    } satisfies ScheduleQueryResult['provenance']
  };

  // A7：裸数字房间号（"310有人吗"）按后缀解析——唯一命中自动收敛并在 notes
  // 如实标注，多个命中如实报歧义（suggestions=候选，不替用户猜），零个走下方 lab_not_found。
  let bareResolved = false;
  if (!lab) {
    const bare = findLabsByNameSuffix(ds, rawLabName);
    if (bare.length === 1) {
      lab = bare[0]!;
      bareResolved = true;
    } else if (bare.length > 1) {
      const candidates = bare.map((b) => b.name);
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
        suggestions: candidates,
        notes: [
          `房间号「${rawLabName}」未带字母前缀，匹配到多个房间：${candidates.join('、')}。未替你猜测。`,
          names.length ? `本系统收录的房间号共 ${names.length} 个：${names.join('、')}` : '本系统当前未收录任何房间'
        ]
      };
    }
  }

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

  // 2026-10-05：接入主系统实时在室人数。
  //   此前工具恒返回 null（当时确实没有签到数据来源）→ 问「某房间现在有多少人」会落到
  //   evidence_missing 兜底失败。0.5.0 打通业务通道后主系统已有签到数据，这里取值。
  //   ⚠️ 仅在**业务通道已连接**（经主系统授权）时取；取不到就保持 null 并如实说明 —— 绝不编造。
  let occupancy: LabStatusResult['occupancy'] = null;
  let keySummary:LabStatusResult['keySummary']={state:'unknown',location:null,recordedAt:null,note:'未取得授权钥匙登记，不推测位置或借用人'};
  if (isBusinessConnected()) {
    try {
      const occ = await businessRequest('/occupancy?roomId='+encodeURIComponent(lab.id)+'&date='+encodeURIComponent(date), 'GET');
      const rows = occ['rooms'] as Array<Record<string, unknown>> | undefined;
      const key = normalizeLabName(lab.name);
      const row = rows?.find((r) => normalizeLabName(String(r['roomName'])) === key || String(r['roomId']) === lab.id);
      if (row && typeof row['present'] === 'number') {
        occupancy = {
          present: row['present'],
          source: 'authorized_api',
          date: String(occ['date'] ?? date),
          note: String(row['note'] ?? occ['note'] ?? '')
        };
      }
    } catch { /* 取不到 → 保持 null，由下面的 notes 如实说明 */ }
  }

  if(isBusinessConnected())try{const response=await businessRequest('/key-status?roomId='+encodeURIComponent(lab.id),'GET');keySummary=(response['keys'] as Array<NonNullable<LabStatusResult['keySummary']>>)?.[0]||keySummary;}catch{/* Unknown is an explicit fact, never substitute a guessed location. */}
  const week = describeWeek(date, ds.term);
  const holiday = isHoliday(date, ds.term);

  const notes: string[] = [week.note];
  if (!week.determinable) notes.push('⚠️ 教学周不可确定，以下排课统计未做周次过滤');
  if (holiday) notes.push(`⚠️ ${date} 在学期配置中被标记为假期`);
  // A7：裸数字自动解析必须让用户看见（工具消息 reminder 要求 notes 原样转达）
  if (bareResolved && lab) notes.push(`房间号「${rawLabName}」未带字母前缀，已按 ${lab.name} 理解`);
  // F19：档案状态 ≠ 实时门禁。措辞必须避免把静态档案解释成"此刻能否进入"
  const dynamic=ds.openLabStatus?.[lab.name]??ds.openLabStatus?.[lab.id],record=typeof dynamic==='object'?dynamic.status:dynamic;
  const actualStatus=['active','closed'].includes(record||'')?record!:lab.status;
  const doorNote=['active','closed'].includes(record||'')?'开放状态来自主系统人员动态登记，非门禁传感器状态':'无动态登记，回退房间档案，登记时间未知';
  notes.push(doorNote);
  if(ds.principal?.identity==='student')notes.push('当前课表仅为本人的课程；排课条数不代表该房间所有班级的教学活动。');
  notes.push(occupancy
    ? `在室人数 ${occupancy.present} 人（${occupancy.date}，来源：主系统授权的实时签到数据；口径=上海当日有效签到记录逐条配对签退；非现场传感器人数，与主系统页面同源）`
    : '在室人数没有数据来源（业务通道未连接或未取得授权），本工具无法提供，请勿据此回答人数问题');

  const labKey = normalizeLabName(lab.name);
  const matched: TimetableRow[] = effectiveSchedule(ds,date).filter(row=>normalizeLabName(row.labName)===labKey);
  const closures=closuresFor(ds,date).filter(c=>c.roomId===lab.id||normalizeLabName(c.roomId)===labKey);
  if(closures.length) notes.push('该日期包含'+(ds.sourceType==='live'?'原系统':'沙盒/快照')+'临时停用，按停用节次限制使用；关门与停用分别判断。');

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
    serviceState: closures.length||lab.status==='inactive'?'suspended':'normal',
    suspendedPeriods: [...new Set(closures.flatMap(c=>c.periodKeys))],
    labId: lab.id,
    labName: lab.name,
    labLocation: lab.location,
    capacity: lab.capacity,
    status: (actualStatus as LabStatusResult['status']) ?? null,
    statusLabel: STATUS_LABELS[actualStatus] ?? `未知(${lab.status})`,
    description: lab.description,
    weekNo: week.weekNo,
    weekDeterminable: week.determinable,
    schedule: {
      lessonCount: matched.length,
      occupiedPeriods,
      nextLesson,
      nextLessonReason
    },
    occupancy,
    keySummary,
    registryStatusNote: doorNote+'；档案状态 '+lab.status,
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
