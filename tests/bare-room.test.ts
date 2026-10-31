/**
 * A7：口语裸房间号（"310有人吗"）全链路解析
 * ============================================================================
 *  2026-10-31 用户实测："310有人吗"（真实房间 E310，口语不带字母前缀）被判成
 *  「超出服务范围」。四处断点，本文件逐层锁死：
 *    ① domain 判定：裸 3 位数字 + 占用/状态问法 → query（4 位年份天然排除）；
 *    ② 意图抽取：无字母前缀时取裸 3 位数字为候选（不是定论）；
 *    ③ 工具解析：后缀匹配——唯一命中自动收敛并在 notes 如实标注「已按 E310
 *       理解」，多个命中如实报歧义（suggestions=候选，不猜），零个报查无此房间；
 *    ④ demo 引擎路由：LAB_STATUS_RE 补「有人/空吗/在吗」口语问法。
 *  诚实口径：解析错了的代价是一次「查无此房间 + 可选项」，绝不是拒绝回答或猜测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLabRequest } from '../server/agent/domain.ts';
import { parseIntent } from '../server/agent/intent.ts';
import { runQuerySchedule } from '../server/tools/query-schedule.ts';
import { runQueryLabStatus } from '../server/tools/query-lab-status.ts';
import { planDemo, LAB_STATUS_RE } from '../server/agent/demo-engine.ts';
import { DATA_SOURCE_LABELS } from '../shared/types.ts';
import type { Dataset } from '../server/data/store.ts';

const NOW = { iso: '2026-09-30T10:00:00+08:00', date: '2026-09-30', time: '10:00:00', weekday: 3, weekdayLabel: '周三' };

function ds(over: Partial<Dataset> = {}): Dataset {
  return {
    sourceType: 'snapshot',
    sourceLabel: DATA_SOURCE_LABELS['snapshot'],
    meta: {},
    term: { term: 'T1', termStart: '2026-09-07', holidays: [] },
    labs: [
      { id: 'lab_1', sortOrder: 1, name: 'E310', location: 'E区3层', capacity: 100, status: 'active', description: '' },
      { id: 'lab_2', sortOrder: 2, name: 'D517', location: 'D区5层', capacity: 100, status: 'closed', description: '' }
    ],
    openLabs: [{ id: 'olab_1', sortOrder: 1, name: 'D526', location: 'D区5层', capacity: 30, status: 'closed', description: '' }],
    timetable: [],
    loadedAt: '2026-09-26T00:00:00Z',
    warnings: [],
    ...over
  } as Dataset;
}

// ---------- ① domain 判定 ----------

test('A7-01 裸房间号+状态问法 → query（用户实测案例）', () => {
  for (const q of ['310有人吗', '310有没有人', '310有人么', '310空吗', '310空着吗', '310在吗', '310现在有人吗', '517什么情况']) {
    assert.equal(classifyLabRequest(q), 'query', q);
  }
});

test('A7-02 4 位年份/日期不误判（(?!\\d) 看 assertions）', () => {
  assert.equal(classifyLabRequest('2026有人吗'), 'redirect', '4 位纯数字是年份，不是房间');
  assert.equal(classifyLabRequest('10月31日有人吗'), 'redirect', '日期里没有 3 位连续数字');
  assert.equal(classifyLabRequest('明天天气怎么样'), 'redirect', '既有越界用例不回退');
});

test('A7-03 带上下文的口语追问（"里面有人吗"）→ query', () => {
  assert.equal(classifyLabRequest('里面有人吗', true), 'query');
  assert.equal(classifyLabRequest('里面有人吗', false), 'redirect', '无上下文时依旧如实引导');
});

// ---------- ② 意图抽取 ----------

test('A7-04 parseIntent：无字母前缀取裸 3 位数字为候选，且如实记 note', () => {
  const intent = parseIntent('310有人吗', NOW);
  assert.equal(intent.labName, '310');
  assert.ok(intent.notes.some((n) => n.includes('310') && n.includes('未带字母前缀')));
});

test('A7-05 parseIntent 边界：字母前缀优先、4 位不取、纯日期不误取', () => {
  assert.equal(parseIntent('E310 有人吗', NOW).labName, 'E310', '字母前缀形态照旧优先');
  assert.equal(parseIntent('3105 有人吗', NOW).labName, null, '4 位数字串不是房间候选');
  assert.equal(parseIntent('2026 有人吗', NOW).labName, null, '年份不是房间候选');
});

// ---------- ③ 工具解析 ----------

test('A7-06 课表查询：唯一命中自动收敛 + notes 如实标注「已按 E310 理解」', () => {
  const r = runQuerySchedule({ date: '2026-09-30', labName: '310' }, ds(), NOW);
  assert.equal(r.labName, 'E310', '310 → E310（系统里唯一后缀命中）');
  assert.ok(r.notes.some((n) => n.includes('310') && n.includes('已按 E310 理解')));
  assert.notEqual(r.reason, 'lab_not_found', '不该落在 lab_not_found（成功路径 reason 是 ok/no_class_* 等）');
});

test('A7-07 课表查询：多个后缀命中如实报歧义，不替用户猜', () => {
  const ambiguous = ds({
    labs: [
      { id: 'a', sortOrder: 1, name: 'E310', location: 'E区3层', capacity: 100, status: 'active', description: '' },
      { id: 'b', sortOrder: 2, name: 'D310', location: 'D区3层', capacity: 80, status: 'active', description: '' }
    ]
  });
  try {
    runQuerySchedule({ date: '2026-09-30', labName: '310' }, ambiguous, NOW);
    assert.fail('应抛 lab_ambiguous');
  } catch (err) {
    const e = err as { code?: string; suggestions?: string[] };
    assert.equal(e.code, 'lab_ambiguous');
    assert.deepEqual([...(e.suggestions ?? [])].sort(), ['D310', 'E310']);
  }
});

test('A7-08 状态查询：唯一命中收敛（含在室人数无来源的诚实说明）', async () => {
  const r = await runQueryLabStatus({ labName: '310' }, ds(), NOW);
  assert.equal(r.labName, 'E310');
  assert.ok(r.notes.some((n) => n.includes('已按 E310 理解')));
  assert.ok(r.notes.some((n) => n.includes('在室人数没有数据来源')), '业务通道未连接时如实说明');
});

test('A7-09 状态查询：多个命中返回候选（statusLabel=未知），零个走查无此房间', async () => {
  const ambiguous = ds({
    labs: [
      { id: 'a', sortOrder: 1, name: 'E310', location: 'E区3层', capacity: 100, status: 'active', description: '' },
      { id: 'b', sortOrder: 2, name: 'D310', location: 'D区3层', capacity: 80, status: 'active', description: '' }
    ]
  });
  const amb = await runQueryLabStatus({ labName: '310' }, ambiguous, NOW);
  assert.equal(amb.statusLabel, '未知');
  assert.deepEqual([...amb.suggestions].sort(), ['D310', 'E310']);
  assert.ok(amb.notes.some((n) => n.includes('匹配到多个房间')));

  const missing = await runQueryLabStatus({ labName: '999' }, ds(), NOW);
  assert.equal(missing.labName, null);
  assert.ok(missing.suggestions.includes('E310'), '查无此房间时带回全部可选项');
});

// ---------- ④ demo 引擎路由 ----------

test('A7-10 demo 引擎：LAB_STATUS_RE 认「有人/空吗」口语，planDemo 路由到 query_lab_status', () => {
  assert.ok(LAB_STATUS_RE.test('310有人吗'));
  assert.ok(LAB_STATUS_RE.test('310空吗'));
  const intent = parseIntent('310有人吗', NOW);
  const plan = planDemo('310有人吗', intent, ds());
  assert.equal(plan.callTool, true);
  assert.equal(plan.tool, 'query_lab_status');
  assert.equal(plan.args['labName'], '310', '参数带裸数字候选，解析交给工具层');
});
