import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectReadComposition, runReadComposition, READ_LABEL } from '../server/agent/read-compose.ts';
import type { ReadDeps } from '../server/agent/read-compose.ts';

const now = { date: '2026-11-10', weekday: 2, weekNo: 10, iso: '2026-11-10T09:00:00+08:00' } as never;
const intent = (over: Record<string, unknown> = {}) => ({
  date: { date: '2026-11-09', raw: '2026-11-09', source: 'explicit' }, dateInvalid: null,
  periodKey: null, periodKeys: null, labName: null, className: null, ...over
}) as never;
const ds = { labs: [{ id: 'lab_1', name: 'E310' }], openLabs: [{ id: 'ol_D525', name: 'D525' }], term: {} } as never;

const ok = (resultKind: string, result: unknown) => ({ ok: true, resultKind, summary: '桩摘要', result } as never);
function spyOf(map: Record<string, () => never>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const execute = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const f = map[tool];
    return f ? f() : ({ ok: false, code: 'stub_missing', message: '桩未覆盖' } as never);
  };
  return { calls, execute };
}
const deps = (question: string, over: Partial<ReadDeps> & { intent?: never } = {}): ReadDeps => ({
  question, intent: intent(), ds, now, mode: 'task', execute: async () => ok('records', {}) as never, ...over
} as ReadDeps);

// ============================ 检测：只在"两半都命中且不是办理话术"时接手 ============================

test('L1 三种只读组合各自命中；只命中一半不进编排', () => {
  assert.equal(detectReadComposition({ question: '2026-11-09 E310 有哪些人签到了？那天的值班是谁', mode: 'task', intent: intent({ labName: 'E310' }) }), 'checkin_duty');
  assert.equal(detectReadComposition({ question: 'D525 今天开放吗？最近有谁进出过', mode: 'task', intent: intent({ labName: 'D525' }) }), 'openlab_presence');
  assert.equal(detectReadComposition({ question: 'E312 现在钥匙在谁手里？今天下午第一节那间有课吗', mode: 'task', intent: intent({ labName: 'E312' }) }), 'key_schedule');
  assert.equal(detectReadComposition({ question: '2026-11-09 E310 有哪些人签到了', mode: 'task', intent: intent({ labName: 'E310' }) }), null, '只问签到＝单工具，交给单轮短路');
  assert.equal(detectReadComposition({ question: 'D525 今天开放吗', mode: 'task', intent: intent({ labName: 'D525' }) }), null, '只问状态＝单工具');
});

test('L2 办理话术一律让位给写链；聊天模式与学生通道不接手；开关可关', () => {
  assert.equal(detectReadComposition({ question: '把 E312 的钥匙借给 student，顺便看看那节有课吗', mode: 'task', intent: intent({ labName: 'E312' }) }), null, '借还话术必须走钥匙链');
  assert.equal(detectReadComposition({ question: '2026-11-09 E310 有谁签到？那节谁值班', mode: 'chat', intent: intent({ labName: 'E310' }) }), null, '聊天模式不做组合');
  process.env['AGENT_READONLY_COMPOSITION'] = '0';
  assert.equal(detectReadComposition({ question: '2026-11-09 E310 有哪些人签到了？那天的值班是谁', mode: 'task', intent: intent({ labName: 'E310' }) }), null, '设 0 应回退纯模型链');
  delete process.env['AGENT_READONLY_COMPOSITION'];
});

// ============================ 参数缺口：零执行交回模型，不猜 ============================

test('L3 缺日期/缺房间时零执行交回模型（不许把空结果说成"没人签到"）', async () => {
  const noDate = deps('E310 有谁签到了？那天谁值班', { intent: intent({ labName: 'E310', date: null }) });
  const out1 = await runReadComposition('checkin_duty', noDate);
  assert.equal(out1.steps.length, 0);
  assert.match(String(out1.stoppedReason), /哪一天/);
  const noRoom = deps('今天开放吗？最近有谁进出过', { intent: intent({ date: { date: '2026-11-10', raw: '今天', source: 'explicit' } }) });
  const out2 = await runReadComposition('openlab_presence', noRoom);
  assert.equal(out2.steps.length, 0);
  assert.match(String(out2.stoppedReason), /哪间实验室/);
});

// ============================ 执行：两份查询按固定接口跑，参数按用户原话 ============================

test('L4 签到+值班组合两步执行，日期/房间/节次按原话传，正文用既有渲染器拼两份', async () => {
  const s = spyOf({
    query_checkin_records: () => ok('records', { date: '2026-11-09', total: 1, records: [{ name: '熊海诺', user: '2025****36', at: '2026-11-09 16:21:09', labName: 'E310', periodKey: 'pm2', type: '签到', scope: 'student' }] }),
    query_term_schedule: () => ok('term_schedule', {
      contractVersion: 3, date: '2026-11-09', queriedAt: '2026-11-10T09:00:00+08:00', sourceRevision: 'r1',
      termSchedule: { enabled: true, notImported: false, term: '2026-2027-1', weeks: 18, week: 10, weekday: 1, sessions: [], cancelled: [], changes: [], notes: [] },
      volunteerSchedule: { enabled: true, notImported: false, days: [{ weekday: 1 }, { weekday: 2 }], persons: [{ name: '尉佳琳', className: '', group: '' }], personsMissingProfile: [], expected: { slotCode: '78', weekday: 1, names: ['李传国'], vacantCount: 0 }, dutyRoom: null },
      hint: ''
    })
  });
  const out = await runReadComposition('checkin_duty', deps('2026-11-09 E310 有哪些人签到了？那天的值班是谁', { intent: intent({ labName: 'E310' }), execute: s.execute }));
  assert.deepEqual(s.calls.map(c => c.tool), ['query_checkin_records', 'query_term_schedule']);
  assert.deepEqual(s.calls[0]!.args, { date: '2026-11-09', labId: 'E310' });
  assert.equal(out.steps.length, 2);
  assert.match(out.answer!, /熊海诺/);
  assert.match(out.answer!, /2025\*\*\*\*36/);
  assert.match(out.answer!, /李传国/);
  assert.match(out.answer!, /周值班模板/);
});

test('L5 带节次时把节次同时传给两份查询；不带节次时不替用户挑节次', async () => {
  const s = spyOf({
    query_key_records: () => ok('records', { date: '2026-11-10', total: 1, keys: [{ id: 'key_lab_2', name: 'E312钥匙', labName: 'E312', location: '在E316钥匙柜', holder: '', borrowed: false }] }),
    query_schedule: () => ok('schedule', { labId: 'E312', labName: 'E312', date: '2026-11-10', weekday: 2, weekdayLabel: '周二', lessons: [], byPeriod: [], reason: 'ok', suggestions: [], notes: [], provenance: [] })
  });
  await runReadComposition('key_schedule', deps('E312 钥匙在谁手里？今天下午第一节有课吗', { intent: intent({ labName: 'E312', periodKey: 'pm1' }), execute: s.execute }));
  assert.equal(s.calls[1]!.args['periodKey'], 'pm1');
  assert.equal(s.calls[1]!.args['labName'], 'E312');
  const s2 = spyOf({
    query_key_records: () => ok('records', { date: '2026-11-10', total: 1, keys: [{ id: 'k', name: 'E312钥匙', labName: 'E312', location: '柜', holder: '', borrowed: false }] }),
    query_schedule: () => ok('schedule', { labId: 'E312', labName: 'E312', date: '2026-11-10', weekday: 2, weekdayLabel: '周二', lessons: [], byPeriod: [], reason: 'ok', suggestions: [], notes: [], provenance: [] })
  });
  await runReadComposition('key_schedule', deps('E312 钥匙在谁手里？今天有课吗', { intent: intent({ labName: 'E312' }), execute: s2.execute }));
  assert.equal('periodKey' in s2.calls[1]!.args, false, '用户没说节次就不该传');
});

// ============================ 半份失败：保留已得的一半，并如实交代 ============================

test('L6 第二步失败时仍交出已取到的依据并说明另一半缺依据，不静默重来', async () => {
  const s = spyOf({
    query_lab_status: () => ok('lab_status', { labId: 'ol_D525', labName: 'D525', labLocation: '文渊D区5层D525', status: 'closed', statusLabel: '关闭', capacity: 30, date: '2026-11-10', weekdayLabel: '周二', occupancy: null, schedule: { lessonCount: 0, nextLesson: null, nextLessonReason: 'no_lesson' }, key: null, notes: [], note: '' }),
    query_openlab_records: () => ({ ok: false, code: 'business_unreachable', message: '主系统暂时不可达' } as never)
  });
  const out = await runReadComposition('openlab_presence', deps('D525 今天开放吗？最近有谁进出过', { intent: intent({ labName: 'D525' }), execute: s.execute }));
  assert.equal(out.answer, null);
  assert.equal(out.steps.length, 2);
  assert.match(out.partial, /D525/);
  assert.match(String(out.stoppedReason), /query_openlab_records 失败：business_unreachable/);
});

test('L7 红线：组合里只允许只读工具，绝不出现写类接口', async () => {
  for (const kind of ['checkin_duty', 'openlab_presence', 'key_schedule'] as const) {
    const s = spyOf({});
    await runReadComposition(kind, deps('2026-11-09 E310 有谁签到了？那节谁值班，钥匙在谁手里，D525 开放吗有课吗', { intent: intent({ labName: 'E310' }), execute: s.execute }));
    assert.ok(s.calls.every(c => /^query_/.test(c.tool)), `${kind} → ${s.calls.map(c => c.tool).join(',')}`);
    assert.ok(!s.calls.some(c => /prepare|commit|draft|apply|write/i.test(c.tool)));
  }
});

test('L8 接线守卫：run.ts 必须真的调用只读组合，并带 strategy 与零执行交回分支', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/agent/run.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bdetectReadComposition\b[^}]*\brunReadComposition\b[^}]*\} from '\.\/read-compose\.ts'/, 'run.ts 未接入 read-compose');
  assert.match(src, /strategy: 'deterministic_readonly'/, 'run_completed 未标注只读组合策略');
  assert.match(src, /read_composition'\W*\{[^}]*steps: 0[^}]*handback/, '缺少"零执行交回模型"的分支');
  const handback = src.slice(src.indexOf('log.info(\'read_composition\', { runId, kind: readKind, steps: 0'), 200);
  assert.ok(!/yield emit/.test(handback), '交回模型前不该 emit 任何事件');
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /AGENT_READONLY_COMPOSITION/, '.env.example 应写明这个开关');
  const types = fs.readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8');
  assert.match(types, /'deterministic_readonly'/, 'RunCompletedPayload.strategy 应含只读组合');
});

test('L9 停下时的名称要说清是哪一种组合', () => {
  assert.equal(READ_LABEL.checkin_duty, '签到明细 + 周值班模板');
  assert.equal(READ_LABEL.openlab_presence, '开放实验室状态 + 进出记录');
  assert.equal(READ_LABEL.key_schedule, '钥匙台账 + 该节课表');
});

test('L10 参数名必须与注册表声明一致（桩替身挡不住真接口口径，实机曾把 labName 写成 labId）', async () => {
  const { toolSpecs } = await import('../server/tools/registry.ts');
  const declared = new Map<string, string[]>(toolSpecs().map((s) => [s.name, Object.keys(((s.parameters ?? {}) as { properties?: Record<string, unknown> }).properties ?? {})]));
  const cases: Array<[keyof typeof READ_LABEL, string, never]> = [
    ['checkin_duty', '2026-11-09 E310 有哪些人签到了？那天的值班是谁', intent({ labName: 'E310', periodKey: 'pm2' })],
    ['openlab_presence', 'D525 今天开放吗？最近有谁进出过', intent({ labName: 'D525' })],
    ['key_schedule', 'E312 钥匙在谁手里？今天下午第一节有课吗', intent({ labName: 'E312', periodKey: 'pm1' })]
  ];
  for (const [kind, question, it] of cases) {
    const s = spyOf({});
    await runReadComposition(kind, deps(question, { intent: it, execute: s.execute }));
    assert.ok(s.calls.length >= 1, `${kind} 应有调用`);
    for (const c of s.calls) {
      const names = declared.get(c.tool);
      assert.ok(names, `${c.tool} 不在注册表里`);
      for (const key of Object.keys(c.args)) {
        assert.ok(names!.includes(key), `${c.tool} 不接受 ${key}；注册表声明的参数是 ${names!.join(',')}`);
      }
    }
  }
});
