import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_RESULT_RENDERERS, renderDemoAnswer } from '../server/agent/demo-engine.ts';
import type { ToolExecution } from '../server/tools/registry.ts';
import type { TermScheduleResult } from '../server/tools/query-term-schedule.ts';
import type { ScheduleQueryResult } from '../shared/types.ts';

type Success = Extract<ToolExecution, { ok: true }>;
type Kind = Success['resultKind'];
type Payload<K extends Kind> = Extract<Success, { resultKind: K }>['result'];
type Fixtures = { [K in Kind]: { payload: Payload<K>; includes: string[] } };

// 仅测试夹具，不写入业务数据；所有强类型载荷由 ToolExecution 校验，禁止 as never 掩盖缺字段。
const date = '2026-11-08';
const at = '2026-11-08T08:30:00+08:00';
const provenance: ScheduleQueryResult['provenance'] = {
  sourceType: 'snapshot', sourceLabel: '渲染测试快照', queryTime: at,
  timezone: 'Asia/Shanghai', coverage: '仅测试夹具'
};
const apiProvenance = { source: 'authorized_api', queriedAt: at, sourceRevision: 'fixture-r1' } as const;
const lesson: ScheduleQueryResult['lessons'][number] = {
  timetableId: 'fixture-lesson', periodKey: 'am1', periodLabel: '上午第一节',
  startTime: '08:20', endTime: '09:50', courseName: '夹具课程', teacher: '教师T01',
  classNames: ['夹具班级'], className: '夹具班级', merged: false, labId: 'E310', labName: 'E310',
  term: '测试学期', weeks: { from: 1, to: 18, parity: 'all' }, updatedAt: at
};
const schedule: ScheduleQueryResult = {
  labId: 'E310', labName: 'E310', labLocation: '测试楼', labStatus: 'active', date,
  weekday: 7, weekdayLabel: '星期日', periodFilter: null, term: '测试学期', weekNo: 10,
  weekDeterminable: true, weekNote: '', lessons: [lesson],
  byPeriod: [{ periodKey: 'am1', periodLabel: '上午第一节', startTime: '08:20', endTime: '09:50', count: 1 }],
  reason: 'ok', suggestions: [], notes: [], provenance
};
const termSchedule = {
  contractVersion: 3, date, queriedAt: at, sourceRevision: 'fixture-r1',
  termSchedule: {
    enabled: true, notImported: false, term: '测试学期档案', weeks: 18, week: 10, weekday: 7,
    sessions: [], cancelled: [], changes: [], notes: []
  },
  volunteerSchedule: {
    enabled: true, notImported: false, days: [],
    persons: [{ name: '夹具志愿者', className: '夹具班级', group: '测试组' }],
    personsMissingProfile: [], expected: null, dutyRoom: null
  },
  hint: '只读档案测试口径'
} satisfies TermScheduleResult;

// records 注册表载荷为 Record<string, unknown>；字段依据 Pages/server/operations.js 的三个 GET 返回值。
const checkinRecords = {
  date, timezone: 'Asia/Shanghai', contractVersion: 3, total: 1,
  records: [{ user: '2026****01', name: '夹具志愿者', type: 'checkin', at,
    periodKey: 'am1', dutySource: 'substitute', dutyMatched: false, rosterSlot: null, substituteFor: '2026****02' }],
  meta: { masked: true, note: '替班不改变签到主体' }
};

const fixtures = {
  schedule: { payload: schedule, includes: ['共有 1 条排课', '夹具课程', 'E310'] },
  lab_status: {
    payload: {
      labId: 'D517', labName: 'D517', labLocation: '测试楼', capacity: 40, status: 'active',
      statusLabel: '开放', description: '测试档案', date, weekdayLabel: '星期日',
      schedule: { lessonCount: 0, occupiedPeriods: [], nextLesson: null, nextLessonReason: 'no_more_today' },
      occupancy: { present: 3, source: 'authorized_api', date, note: '有效签到口径' },
      registryStatusNote: '非门禁状态', term: '测试学期', weekNo: 10, weekDeterminable: true,
      suggestions: [], notes: [], provenance
    }, includes: ['D517', '在室人数：3 人', '容量 40 人']
  },
  free_rooms: {
    payload: {
      date, weekdayLabel: '星期日', periodFilter: 'am1', periodKeys: ['am1'], coverage: 'complete',
      unknownCandidates: [], term: '测试学期', weekNo: 10, weekDeterminable: true,
      freeByPeriod: [{ periodKey: 'am1', periodLabel: '上午第一节', startTime: '08:20', endTime: '09:50',
        rooms: [{ labName: 'E312', location: '测试楼', status: 'active', capacity: 6 }] }],
      excluded: [], notes: [], provenance
    }, includes: ['空闲房间', 'E312', '不代表室内无人']
  },
  operation_proposal: {
    payload: {
      proposalId: 'fixture-proposal', taskId: 'fixture-task', actionType: 'create_issue', version: 1,
      state: 'awaiting_confirmation', executionEnvironment: 'sandbox', canExecute: true, cannotExecuteReason: null,
      title: '夹具报修单', summary: '夹具投影故障待核对',
      effects: [{ label: '创建夹具工单', objectType: 'issue', objectId: null, before: null, after: '待处理' }],
      missingDependencies: [], requiredCapabilities: [], createdAt: at, expiresAt: '2026-11-08T09:30:00+08:00',
      evidence: [provenance], payloadKind: 'issue', payloadView: { roomId: 'E310' }
    }, includes: ['夹具报修单', '等待你确认', '创建夹具工单']
  },
  operations_report: {
    payload: {
      reportId: 'fixture-report', artifactVersion: 1, createdAt: at, range: { startDate: date, endDate: date },
      sections: ['issues'], metrics: [{ key: 'issues', label: '夹具工单数', value: 2, unit: '件', status: 'known', note: '' }],
      evidence: [], notes: []
    }, includes: ['运营日报草稿', '夹具工单数：2 件', '未自动发布']
  },
  knowledge: {
    payload: {
      summary: '夹具知识检索', scope: '只依据给定制度', hits: [{ id: 'fixture-knowledge', title: '夹具制度',
        version: '2', effectiveFrom: date, source: 'fixture', url: '',
        paragraphs: [{ locator: '§1', text: '夹具规则甲' }, { locator: '§2', text: '夹具规则乙' }] }]
    }, includes: ['[1] 夹具制度（v2）· §1', '夹具规则甲', '[2] 夹具制度（v2）· §2', '夹具规则乙']
  },
  business_plan: {
    payload: { summary: '夹具业务方案待确认', planId: null, candidates: [], workbenchUrl: '', source: 'fixture' },
    includes: ['夹具业务方案待确认']
  },
  evidence_observation: {
    payload: {
      provenance: { sourceLabel: '夹具照片', queryTime: at, sourceRevision: 'fixture-r1', coverage: '仅测试照片' },
      scope: '照片仅提供线索', model: 'fixture-vision', ms: 1,
      attachments: [{ id: 'fixture-image', fileName: 'fixture-projector.png', mimeType: 'image/png', sha256: 'a'.repeat(64), uploadedAt: at }],
      skipped: ['fixture-unreadable.png：附件不可读'],
      observation: { deviceType: '投影仪', visibleSymptoms: ['指示灯闪烁'], nameplateText: 'TEST-P01',
        severityGuess: 'moderate', confidence: 0.72, whatNotVisible: ['无法确认内部电路'] },
      notHumanVerification: true
    }, includes: ['非人工验收', '投影仪', '指示灯闪烁', 'TEST-P01', '中等', '72%', '无法确认内部电路',
      'fixture-projector.png', 'fixture-unreadable.png：附件不可读', '照片仅提供线索', '不能证明设备已修复']
  },
  checkin_status: {
    payload: {
      actor: { username: 'fixture-student', identity: 'student', className: '夹具班级' }, date,
      timezone: 'Asia/Shanghai', currentPeriod: { key: 'am1', label: '上午第一节', start: '08:20', end: '09:50' },
      lessons: [{ timetableId: 'fixture-lesson', periodKey: 'am1', periodLabel: '上午第一节', start: '08:20', end: '09:50',
        courseId: 'fixture-course', courseName: '夹具签到课', teacher: '教师T01', labId: 'E310', labName: 'E310',
        status: 'unsigned', phase: 'open', lateWindow: false, lateSignin: false, autoSignout: false,
        mismatch: false, locationFailed: false, checkinTime: null, checkoutTime: null, checkinPath: '/student-checkin.html' }],
      note: null, provenance: apiProvenance, boundaryNote: '签到须本人在场完成'
    }, includes: ['夹具签到课', '尚未签到', '/student-checkin.html', 'Agent 不代签']
  },
  checkin_summary: {
    payload: {
      actor: { username: 'fixture-admin', identity: 'admin', className: '' }, date, timezone: 'Asia/Shanghai',
      scope: { labId: 'E310', periodKey: 'am1' },
      sessions: [{ timetableId: 'fixture-lesson', periodKey: 'am1', periodLabel: '上午第一节', start: '08:20', end: '09:50',
        courseId: 'fixture-course', courseName: '夹具汇总课', teacher: '教师T01', labId: 'E310', labName: 'E310',
        classNames: ['夹具班级'], expected: 2, rosterKnown: true, checkedIn: 1, absentUsernames: ['fixture-absent'],
        absentCount: 1, checkedOut: 0, late: 0, mismatch: 0, locationFailed: 0, note: null }],
      totals: { sessions: 1, expected: 2, checkedIn: 1, absent: 1, checkedOut: 0, late: 0, mismatch: 0, locationFailed: 0, unknownExpected: 0 },
      note: null, provenance: apiProvenance, boundaryNote: '缺口需现场核实'
    }, includes: ['签到汇总：共 1 节课', '夹具汇总课', 'fixture-absent', '需现场核实']
  },
  vision_field: {
    payload: {
      configured: true, generatedAt: at, note: '视觉是线索不是结论', knownLabs: ['E310'],
      labs: [{ labId: 'E310', online: true, count: 2, capacity: 40, recognized: null, unknownFaces: null,
        library: [], alert: false, ageSeconds: 1 }], detailLines: ['E310：夹具视觉 AI 计数 2 人']
    }, includes: ['夹具视觉 AI 计数 2 人', '视觉是线索不是结论']
  },
  task_plan: {
    payload: { steps: [{ id: 's1', text: '查询夹具课表', status: 'done' },
      { id: 's2', text: '等待夹具确认', status: 'pending' }, { id: 's3', text: '放弃夹具方案', status: 'dropped' }], updatedAt: at },
    includes: ['任务计划：3 步', 's1｜已完成｜查询夹具课表', 's2｜待办｜等待夹具确认', 's3｜已放弃｜放弃夹具方案', at, '不代表业务已执行']
  },
  term_schedule: { payload: termSchedule, includes: ['测试学期档案', '18 周', '夹具志愿者', '只读档案测试口径'] },
  term_schedule_applied: {
    payload: { target: 'term', revision: 7, count: 12, updatedBy: 'fixture-admin', droppedKeys: ['fixture-ignored'] },
    includes: ['学期安排已更新', 'revision=7', '12 条', 'fixture-admin', 'fixture-ignored']
  },
  records: { payload: checkinRecords, includes: ['签到签退明细：共 1 条', '2026****01', '夹具志愿者', at,
    '类型：签到', '值班来源：替班', '模板匹配：否', '2026****02', '替班不改变签到主体', '不作考勤定性'] }
} satisfies Fixtures;

const kinds = Object.keys(fixtures) as Kind[];
const extras = { dateWasDefaulted: false, periodFiltered: false };
function verifyFixture(kind: Kind, textOnly: boolean): void {
  const fixture = fixtures[kind];
  // 不用工具 summary 兜底冒充专用分支输出。
  const out = renderDemoAnswer({ kind, payload: structuredClone(fixture.payload), summary: '不应替代真实呈现的摘要' }, { ...extras, textOnly });
  assert.doesNotMatch(out, /暂无专用呈现|不应替代真实呈现的摘要|undefined|\[object Object\]/);
  for (const text of fixture.includes) assert.ok(out.includes(text), `${kind} 缺少实际数据：${text}\n${out}`);
}

test('实际分派表与所有成功 ToolExecution fixture 一一对应', () => {
  assert.deepEqual(Object.keys(DEMO_RESULT_RENDERERS).sort(), kinds.slice().sort());
});

for (const kind of kinds) {
  test(`${kind}：合法载荷在普通与 textOnly 模式均进入专用呈现`, () => {
    verifyFixture(kind, false);
    verifyFixture(kind, true);
  });
  test(`${kind}：入口确实调用实际 dispatch，而不是独立覆盖名单`, (t) => {
    const marker = `dispatch:${kind}`;
    const renderer = t.mock.method(DEMO_RESULT_RENDERERS, kind, () => marker);
    for (const textOnly of [false, true]) {
      const out = renderDemoAnswer({ kind, payload: fixtures[kind].payload }, { ...extras, textOnly });
      assert.equal(out.split('\n')[0], marker);
      if (kind !== 'schedule' || !textOnly) assert.equal(out, marker);
    }
    assert.equal(renderer.mock.callCount(), 2);
    assert.equal(renderer.mock.calls[0].arguments[0], fixtures[kind].payload);
  });
}

test('负向验证：删除任一实际分支，合法 fixture 验收必须报错（两种模式）', () => {
  for (const kind of kinds) {
    const descriptor = Object.getOwnPropertyDescriptor(DEMO_RESULT_RENDERERS, kind)!;
    try {
      Reflect.deleteProperty(DEMO_RESULT_RENDERERS, kind);
      for (const textOnly of [false, true]) {
        assert.throws(() => verifyFixture(kind, textOnly), assert.AssertionError, `${kind} 缺失未被发现`);
      }
    } finally {
      Object.defineProperty(DEMO_RESULT_RENDERERS, kind, descriptor);
    }
  }
});

test('未知 kind（包括原型属性名）不读取载荷，安全降级并保留可用 summary', () => {
  const unreadablePayload = new Proxy({}, { get() { throw new Error('未知载荷不应被读取'); } });
  for (const kind of ['future_kind', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    for (const textOnly of [false, true]) {
      for (const payload of [null, undefined, {}, [], unreadablePayload]) {
        assert.equal(renderDemoAnswer({ kind, payload, summary: '  可用工具摘要  ' }, { ...extras, textOnly }), '暂无专用呈现。\n可用工具摘要');
        assert.equal(renderDemoAnswer({ kind, payload }, { ...extras, textOnly }), '暂无专用呈现。');
        assert.equal(renderDemoAnswer({ kind, payload, summary: '  ' }, { ...extras, textOnly }), '暂无专用呈现。');
      }
      // 历史回放的非字符串摘要也不应抛异常或被强行字符串化。
      assert.equal(renderDemoAnswer({ kind, payload: null, summary: 42 as unknown as string }, { ...extras, textOnly }), '暂无专用呈现。');
    }
  }
});

test('schedule 显式分派保留旧入口、节次/默认日期说明及 textOnly 明细', () => {
  for (const textOnly of [false, true]) {
    const options = { dateWasDefaulted: true, periodFiltered: true, textOnly };
    const out = renderDemoAnswer(schedule, options);
    assert.equal(out, renderDemoAnswer({ kind: 'schedule', payload: schedule }, options));
    assert.match(out, /已按你指定的节次过滤/);
    assert.match(out, /以上按服务端当天 2026-11-08 计算/);
    if (textOnly) {
      assert.match(out, /班级 夹具班级｜教师 教师T01｜编号 fixture-lesson/);
      assert.doesNotMatch(out, /见下方课表卡/);
    } else assert.match(out, /逐节明细见下方课表卡/);
  }
});

test('证据观察无征象/盲区时仍说明不确定性，不推断设备正常或验收通过', () => {
  const payload: Payload<'evidence_observation'> = { ...fixtures.evidence_observation.payload,
    observation: { deviceType: '', visibleSymptoms: [], nameplateText: '', severityGuess: 'unknown', confidence: 0, whatNotVisible: [] },
    attachments: [], skipped: [] };
  for (const textOnly of [false, true]) {
    const out = renderDemoAnswer({ kind: 'evidence_observation', payload }, { ...extras, textOnly });
    assert.match(out, /非人工验收/);
    assert.match(out, /无法初判；置信度 0%/);
    assert.match(out, /画面中没有可确认的异常征象/);
    assert.match(out, /模型未列出盲区，请人工复核/);
    assert.doesNotMatch(out, /设备正常|已通过验收/);
  }
});

test('records 覆盖开放实验室历史字段与钥匙台账，保留掩码、零值和借出状态', () => {
  const openlab = {
    date, timezone: 'Asia/Shanghai', contractVersion: 3, total: 3,
    records: [
      { username: '2026****03', name: '夹具访客', labId: 'E312', time: at, type: 'checkout' },
      { actorId: '2026****04', labId: 'D517', ts: at, type: 'checkin' },
      { user: '2026****05', at, periodKey: 'am1', type: 'checkin', dutySource: 'roster', dutyMatched: true, rosterSlot: 'SUN-am1-1' }
    ], meta: { masked: true, note: '开放实验室签到/签退；学号与借用人已掩码' }
  };
  const keys = {
    timezone: 'Asia/Shanghai', contractVersion: 3, total: 2,
    keys: [
      { id: 'key-0', labId: 'E310', labName: 'E310', labType: 'student', name: '夹具钥匙甲', location: '测试柜A', holder: '2026****06', remark: '夹具备注', borrowed: true },
      { id: 'key-1', labId: 'E312', labName: 'E312', labType: 'openlab', name: '夹具钥匙乙', location: '测试柜B', holder: '', remark: '', borrowed: false }
    ], meta: { masked: true, note: '借用人已掩码；空借用人表示钥匙在柜' }
  };
  for (const textOnly of [false, true]) {
    const out = renderDemoAnswer({ kind: 'records', payload: openlab }, { ...extras, textOnly });
    for (const expected of ['2026****03', '2026****04', '2026****05', at, 'E312', 'D517', '类型：签退', '周值班模板', '模板匹配：是', 'SUN-am1-1']) assert.ok(out.includes(expected), expected);
    const keyOut = renderDemoAnswer({ kind: 'records', payload: keys }, { ...extras, textOnly });
    for (const expected of ['钥匙台账：共 2 条', 'key-0', '夹具钥匙甲', '测试柜A', '2026****06', '夹具备注', '已借出', '夹具钥匙乙', '未借出']) assert.ok(keyOut.includes(expected), expected);
    const zero = renderDemoAnswer({ kind: 'records', payload: { total: 0, records: [] } }, { ...extras, textOnly });
    assert.match(zero, /共 0 条/);
    assert.match(zero, /不据此推断现场状态/);
  }
});

test('records 缺字段/异常行不崩溃、不将缺载荷说成零记录，不泄漏任意未知字段', () => {
  for (const textOnly of [false, true]) {
    const options = { ...extras, textOnly };
    assert.match(renderDemoAnswer({ kind: 'records', payload: {} }, options), /不能据此判断没有记录/);
    const out = renderDemoAnswer({ kind: 'records', payload: { records: [null, 1, [], {}, { privateField: '不应展示', at: 0 }] } }, options);
    assert.match(out, /记录字段不可用/);
    assert.match(out, /暂无可呈现的明细字段/);
    assert.match(out, /时间：0/);
    assert.doesNotMatch(out, /不应展示|undefined|\[object Object\]/);
    const partial = renderDemoAnswer({ kind: 'records', payload: { total: 50, records: checkinRecords.records } }, options);
    assert.match(partial, /共 50 条.*本次返回 1 条/);
    const many = renderDemoAnswer({ kind: 'records', payload: { records: Array.from({ length: 31 }, (_, i) => ({ name: `夹具记录${i}` })) } }, options);
    assert.match(many, /仅显示前 30 条/);
    assert.doesNotMatch(many, /姓名：夹具记录30/);
  }
});

test('空知识命中、空工作计划及未导入档案仍保留能力边界', () => {
  for (const textOnly of [false, true]) {
    const options = { ...extras, textOnly };
    assert.match(renderDemoAnswer({ kind: 'knowledge', payload: { summary: '未命中', scope: '测试', hits: [] } satisfies Payload<'knowledge'> }, options), /知识库未命中，不作答制度细节/);
    const plan = renderDemoAnswer({ kind: 'task_plan', payload: { steps: [], updatedAt: at } satisfies Payload<'task_plan'> }, options);
    assert.match(plan, /暂无计划步骤/);
    assert.match(plan, /不代表业务已执行/);
    const term: TermScheduleResult = { ...termSchedule,
      termSchedule: { ...termSchedule.termSchedule, enabled: false, notImported: true },
      volunteerSchedule: { ...termSchedule.volunteerSchedule, enabled: false, notImported: true, persons: [] } };
    const out = renderDemoAnswer({ kind: 'term_schedule', payload: term }, options);
    assert.match(out, /学期安排.*尚未导入/);
    assert.match(out, /周值班模板.*尚未导入/);
    assert.doesNotMatch(out, /没有课|无人值班/);
  }
});
