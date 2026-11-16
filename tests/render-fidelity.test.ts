/**
 * 渲染忠实性回归
 * ============================================================================
 *  核心约束：渲染器产出的回答里，**每个数字与名称都必须来自 payload**——
 *    · 数量断言 = payload 数组长度（不臆造、不遗漏）；
 *    · 缺失字段 → 显式「未录入/未知/尚未导入」，绝不编一个值补位；
 *    · 越界数据（payload 里没有的课/人）→ 不得出现在输出里。
 *  渲染器是确定性兜底（模型失败时的最后一道岗），它编造 = 系统编造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDemoAnswer } from '../server/agent/demo-engine.ts';
import type { ScheduleQueryResult } from '../shared/types.ts';

const NOW = { iso: '2026-11-11T14:00:00+08:00', date: '2026-11-11', weekday: 3, weekdayLabel: '周三' } as unknown as import('./../server/time/term.ts').ServerNow;

function schedulePayload(lessons: Array<Partial<ScheduleQueryResult['lessons'][number]>>): ScheduleQueryResult {
  return {
    labId: 'lab-x',
    labName: 'E310',
    labLocation: '文渊E区3层',
    labStatus: 'open',
    date: '2026-11-11',
    weekday: 3,
    weekdayLabel: '周三',
    periodFilter: null,
    term: '2026-2027-1',
    weekNo: 10,
    weekDeterminable: true,
    weekNote: '第 10 教学周（单周）',
    suggestions: [],
    notes: [],
    provenance: { sourceType: 'snapshot', sourceLabel: '快照', queryTime: NOW.iso, snapshotRevision: 'rev-x' } as never,
    byPeriod: [],
    reason: lessons.length ? null : 'no_class_that_day',
    lessons: lessons.map((l, i) => ({
      timetableId: `tt-${i}`,
      periodKey: 'am1',
      periodLabel: '上午第一大节',
      startTime: '08:20',
      endTime: '09:50',
      courseName: '（课程名未录入）',
      teacher: '（未录入）',
      classNames: ['班A'],
      className: '班A',
      merged: false,
      labId: 'lab-x',
      labName: 'E310',
      term: '2026-2027-1',
      weeks: '1-16周',
      updatedAt: NOW.iso,
      ...l
    })) as ScheduleQueryResult['lessons']
  } as unknown as ScheduleQueryResult;
}

test('忠实性①：数量断言与课程清单严格来自 payload', () => {
  const payload = schedulePayload([
    { courseName: 'Java 程序设计', teacher: '教师T54', className: '智能本2501' },
    { courseName: '操作系统', teacher: '教师T16', className: '智能本2501' }
  ]);
  const text = renderDemoAnswer(payload, { dateWasDefaulted: false, periodFiltered: false });
  assert.match(text, /共有 2 条排课/, '数量 = payload 行数');
  for (const l of payload.lessons) assert.match(text, new RegExp(l.courseName!), '每门课都出现');
  // 越界：payload 里没有的课程不得出现
  assert.doesNotMatch(text, /计算机网络原理/);
  assert.doesNotMatch(text, /机器学习与模式识别/);
});

test('忠实性②：缺失字段显式标「未录入」，不编造', () => {
  const payload = schedulePayload([{ courseName: '' , teacher: '' }]);
  const text = renderDemoAnswer(payload, { dateWasDefaulted: false, periodFiltered: false });
  assert.match(text, /课程名未录入/);
  assert.match(text, /未录入/);
  assert.doesNotMatch(text, /教师T\d+/);
});

test('忠实性③：0 条排课时输出「没有课」且不列任何课程', () => {
  const payload = schedulePayload([]);
  payload.reason = 'no_class_that_day';
  const text = renderDemoAnswer(payload, { dateWasDefaulted: false, periodFiltered: false });
  assert.match(text, /没有课/);
  assert.doesNotMatch(text, /共有 \d+ 条排课/);
});

test('忠实性④：term_schedule 未导入 → 明说未导入，不冒充数据', () => {
  const payload = {
    termSchedule: { enabled: false, notImported: true, term: '', weeks: null, sessions: [], cancelled: [], notes: [] },
    volunteerSchedule: { enabled: false, notImported: true, days: [], persons: [], dutyRoom: null },
    hint: '学期安排或志愿者值班表尚未导入，请如实告知用户并提示联系管理员；不得把空数组表述为「无课/无人值班」。'
  };
  const text = renderDemoAnswer({ kind: 'term_schedule', payload } as never, { dateWasDefaulted: false, periodFiltered: false });
  assert.match(text, /尚未导入/);
  assert.match(text, /学期安排/);
  assert.match(text, /志愿者周值班模板/);
  // 未导入状态下不得声称有任何课时/人数
  assert.doesNotMatch(text, /\d+ 条课时/);
  assert.doesNotMatch(text, /\d+ 名志愿者/);
});

test('忠实性⑤：term_schedule 已导入 → 人数/课时数严格等于 payload', () => {
  const payload = {
    termSchedule: { enabled: true, notImported: false, term: '2026-2027-1', weeks: 16, sessions: [{}, {}, {}], cancelled: [], notes: [] },
    volunteerSchedule: {
      enabled: true, notImported: false, days: [{}, {}],
      persons: [{ name: '张三', className: '计本2501', group: 'A 组' }, { name: '李四', className: '计本2501', group: '' }],
      dutyRoom: null
    },
    hint: ''
  };
  const text = renderDemoAnswer({ kind: 'term_schedule', payload } as never, { dateWasDefaulted: false, periodFiltered: false });
  assert.match(text, /3 条课时/);
  assert.match(text, /2 天/);
  assert.match(text, /2 名志愿者/);
  for (const p of payload.volunteerSchedule.persons) assert.match(text, new RegExp(p.name));
  // payload 里没有的人不得出现
  assert.doesNotMatch(text, /王五/);
});
