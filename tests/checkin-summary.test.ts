/**
 * 学生签到接入：批次 2（读·管理侧）验收
 * ============================================================================
 *  A 部分：主系统 GET /api/integration/checkin-summary 的 dispatch 直测（隔离夹具，
 *          固定时钟）——应到/实到/缺口/未签到学号名单、异常计数、过滤参数、角色门控。
 *  B 部分：真实双服务 HTTP（主系统 serve.js + LabOps，评审夹具）——
 *          · 管理员问"今天签到情况怎么样" → query_checkin_summary 返回真实计数与名单；
 *          · 学生问同一句 → 路由到 query_checkin_status（本人状态），拿不到缺口名单；
 *          · 学生/志愿者令牌直连端点 403。
 *
 *  口径锁定：名单只含学号（账号）不含姓名；缺口=应到−实到的账面差，需现场核实；
 *  逐人签到明细（谁在何时签的）依旧无开放接口（occupancy 三锁定不破坏）。
 *
 *  运行：node --test tests/checkin-summary.test.ts
 */

process.env.TZ = 'Asia/Shanghai';
process.env.LABOPS_AUTH_MODE = 'demo';
// 本文件可直接 node --test 运行：必须与 run-tests.mjs 同口径切断磁盘 .env（测试不得调用付费模型）
process.env.LABOPS_SKIP_ENV_FILE = '1';
for (const k of ['AGNES_API_KEY', 'DASHSCOPE_API_KEY', 'VISION_API_KEY']) delete process.env[k];
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Fixture CLI is ordinary JavaScript, also runnable without a transpiler.
import { createReviewFixture } from '../scripts/create-review-fixture.mjs';

const require = createRequire(import.meta.url);
const { dispatch } = require('../../Pages/server/operations.js');

// ============================ A 部分：dispatch 直测 ============================

const admin = { username: 'adm', identity: 'admin' };
// 2026-11-09 是周一；pm1=14:00–15:30
const MONDAY = (h: number, m: number) => new Date(`2026-11-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
function fixtureState(records: unknown[] = []) {
  return {
    sysConfig: { term: 'fixture', termStart: '2026-09-07', termEnd: '2027-01-31', holidays: [], specialDays: [] },
    labs: [{ id: 'a', name: 'E310', capacity: 60, status: 'active' }, { id: 'b', name: 'E312', capacity: 60, status: 'active' }], openLabs: [],
    timetable: [
      { id: 'tt1', labId: 'a', labName: 'E310', className: 'Fixture A', classNames: ['Fixture A'], courseId: 'c', courseName: 'Fixture Course', teacher: 'T1', term: 'fixture', weekday: 1, periodKey: 'pm1', status: 'normal', weeks: { from: 1, to: 20, parity: 'all' } },
      { id: 'tt2', labId: 'b', labName: 'E312', className: 'Fixture B', classNames: ['Fixture B'], courseId: 'c2', courseName: 'Second Course', teacher: 'T2', term: 'fixture', weekday: 1, periodKey: 'am1', status: 'normal', weeks: { from: 1, to: 20, parity: 'all' } }
    ],
    courses: [{ id: 'c', name: 'Fixture Course' }, { id: 'c2', name: 'Second Course' }],
    classes: [{ id: 'ca', name: 'Fixture A', size: 5 }, { id: 'cb', name: 'Fixture B', size: 4 }],
    classRoster: [
      { sno: '2023001', className: 'Fixture A' }, { sno: '2023002', className: 'Fixture A' }, { sno: '2023003', className: 'Fixture A' },
      { sno: '3004001', className: 'Fixture B' }, { sno: '3004002', className: 'Fixture B' }, { sno: '3004003', className: 'Fixture B' }, { sno: '3004004', className: 'Fixture B' }
    ],
    users: [], scheduleAdjust: [], dutyShifts: [], notifications: [], openLabStatus: {}, openLabStatusMeta: {},
    checkinRecords: records
  };
}
const rec = (over: Record<string, unknown>) => ({
  id: 'r1', labId: 'a', labName: 'E310', type: 'checkin', username: '2023001', periodKey: 'pm1', timetableId: 'tt1',
  time: '2026-11-09 14:05:00', status: '签到', valid: true, ...over
});
const call = (state: unknown, actor: unknown, now: Date, query: Record<string, string> = {}) =>
  dispatch({ method: 'GET', path: '/checkin-summary', query, actor, state, now, commit: () => { throw new Error('read-only'); } });

test('A1 计数与未签到学号名单：应到=名册数、缺口=名册−实到、异常计数如实', () => {
  const out = call(fixtureState([
    rec({ id: 'r1', username: '2023001' }),
    rec({ id: 'r2', username: '2023002', time: '2026-11-09 14:35:00', status: '补签到', locationFailed: true }),
    rec({ id: 'r3', type: 'checkout', username: '2023001', time: '2026-11-09 15:00:00' })
  ]), admin, MONDAY(15, 40));
  assert.equal(out.contractVersion, 3);
  assert.equal(out.sessions.length, 2, 'pm1 + am1 两节课');
  const s1 = out.sessions.find((s: any) => s.timetableId === 'tt1');
  assert.equal(s1.expected, 3);
  assert.equal(s1.checkedIn, 2);
  assert.deepEqual(s1.absentUsernames, ['2023003']);
  assert.equal(s1.absentCount, 1);
  assert.equal(s1.checkedOut, 1);
  assert.equal(s1.late, 1);
  assert.equal(s1.locationFailed, 1);
  assert.equal(s1.mismatch, 0);
  assert.equal(out.totals.expected, 7);
  assert.equal(out.totals.checkedIn, 2);
  assert.equal(out.totals.absent, 5);
  // 名单只含学号：不存在任何姓名字段
  for (const s of out.sessions) {
    assert.ok(!Object.hasOwn(s, 'name') && !Object.hasOwn(s, 'names'));
    for (const sno of s.absentUsernames ?? []) assert.match(String(sno), /^\d+$/);
  }
});

test('A2 名册缺失：只有计数没有名单（absentUsernames=null）并如实注明', () => {
  const state = fixtureState([rec({ id: 'r9' })]);
  state.classRoster = state.classRoster.filter((x: any) => x.className !== 'Fixture A');
  const out = call(state, admin, MONDAY(14, 30));
  const s1 = out.sessions.find((s: any) => s.timetableId === 'tt1');
  assert.equal(s1.expected, 5, '回落到班级档案人数');
  assert.equal(s1.rosterKnown, false);
  assert.equal(s1.absentUsernames, null);
  assert.equal(s1.absentCount, 4, '账面缺口=应到−实到，与名册无关（无名册也必须如实报缺口）');
  assert.match(s1.note, /名册/);
});

test('A3 过滤：periodKey / labId / 非法参数', () => {
  const state = fixtureState([]);
  assert.equal(call(state, admin, MONDAY(14, 30), { periodKey: 'pm1' }).sessions.length, 1);
  assert.equal(call(state, admin, MONDAY(14, 30), { labId: 'b' }).sessions.length, 1);
  assert.equal(call(state, admin, MONDAY(14, 30), { labId: 'b', periodKey: 'pm1' }).sessions.length, 0, 'B 班课在 am1，组合过滤为空');
  assert.throws(() => call(state, admin, MONDAY(14, 30), { labId: 'nope' }), /实验室不存在/);
  assert.throws(() => call(state, admin, MONDAY(14, 30), { periodKey: 'bad' }), /节次/);
  assert.throws(() => call(state, admin, MONDAY(14, 30), { date: '2026-13-99' }), /YYYY-MM-DD/);
});

test('A4 角色门控：志愿者与学生一律 403，学生业务门禁不被放大', () => {
  const state = fixtureState([]);
  assert.throws(() => call(state, { username: 'v', identity: 'volunteer' }, MONDAY(14, 30)), /管理员/);
  assert.throws(() => call(state, { username: 's', identity: 'student', className: 'Fixture A' }, MONDAY(14, 30)), /学生通道|权限/);
  assert.throws(() => dispatch({ method: 'GET', path: '/tasks', body: undefined, actor: { username: 's', identity: 'student', className: 'Fixture A' }, state, now: MONDAY(14, 30), commit: () => {} }), /学生|权限/);
});

test('A5 隐私与口径：他人课的签到不串账；作废记录不参与；非名册学号计入实到但绝不进名单', () => {
  const state = fixtureState([
    rec({ id: 'x1', username: '2023001', timetableId: 'tt1' }),
    rec({ id: 'x2', username: '9999', periodKey: 'pm1', timetableId: 'tt1' }),
    rec({ id: 'x3', username: '2023002', timetableId: 'tt1', valid: false }),
    rec({ id: 'x4', username: '7777', periodKey: 'pm1', labId: 'b', timetableId: '' })
  ]);
  const out = call(state, admin, MONDAY(14, 30));
  const s1 = out.sessions.find((s: any) => s.timetableId === 'tt1');
  assert.equal(s1.checkedIn, 2, '2023001 + 非名册 9999 都是真实有效记录');
  assert.deepEqual(s1.absentUsernames, ['2023002', '2023003']);
  assert.equal(s1.absentCount, 1, '账面缺口=应到−实到；名单(2)与缺口(1)不一致时由 note 说明');
  assert.match(s1.note, /不一致/);
  const s2 = out.sessions.find((s: any) => s.timetableId === 'tt2');
  assert.equal(s2.checkedIn, 0, 'B 班课不受 A 班记录影响');
  assert.equal(out.totals.checkedIn, 2, 'legacy 无 timetableId 记录在另一实验室（lab b + pm1）不得误归任何课节');
});

// ============================ B 部分：真实双服务 HTTP ============================

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-checkin-sum-'));
const nativeDir = path.join(temp, 'native');
createReviewFixture(nativeDir);
// 夹具名册只有 review-student 一人：补两名未签到学号让缺口可见（只动名册，不造假签到记录）
{
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(nativeDir, f), 'utf8'));
  const write = (f: string, v: unknown) => fs.writeFileSync(path.join(nativeDir, f), JSON.stringify(v, null, 2), { mode: 0o600 });
  const wrapped = read('state.json');
  wrapped.state.classRoster.push({ sno: '2023002', className: '评审示例班' }, { sno: '2023003', className: '评审示例班' });
  write('state.json', wrapped);
}
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
// ⚠️ 记录类唯一权威是 SQLite：签到数据必须走主系统数据层写入，改 JSON 是假的
process.env.DATA_DIR = nativeDir;
const nativeDb = require('../../Pages/lib/db.js') as { insertCheckin: (r: Record<string, unknown>) => string };
nativeDb.insertCheckin({ id: 'ck-sum-1', labId: 'fixture-e310', type: 'checkin', time: `${shDate} 14:05:00`, valid: true, username: 'review-student', className: '评审示例班', timetableId: 'fixture-lesson' });

process.env.LABOPS_DB_PATH = path.join(temp, 'agent.sqlite');
process.env.AGNES_API_KEY = '';

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const nativePort = await freePort();
process.env.LABOPS_BUSINESS_URL = `http://127.0.0.1:${nativePort}`;
const nativeSrv = spawn(process.execPath, [fileURLToPath(new URL('../../Pages/serve.js', import.meta.url))], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(nativePort), DATA_DIR: nativeDir, REGISTER_OPEN: '0', ENABLE_SEED_ACCOUNTS: '0', ENABLE_BASE_SEED: '0' },
  stdio: ['ignore', 'ignore', 'pipe']
});
let startupError = '';
nativeSrv.stderr.on('data', (c) => { startupError += c.toString(); });
for (let i = 0; i < 80; i++) {
  if (nativeSrv.exitCode !== null) throw new Error('原系统启动失败：' + startupError);
  try { if ((await fetch(`http://127.0.0.1:${nativePort}/api/health`)).ok) break; } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 50));
}
after(() => nativeSrv.kill());

const { withHttpIdentity } = await import('../server/security/http.ts');
const { handleRequest } = await import('../server/index.ts');
const fixture = JSON.parse(fs.readFileSync(path.join(nativeDir, 'review-access.json'), 'utf8')) as { accounts: Array<{ account: string; password: string; identity: string }> };

const agent = http.createServer((req, res) => {
  withHttpIdentity(req, res, () => handleRequest(req, res)).catch((e) => {
    if (!res.headersSent) { res.writeHead(500); res.end(String(e)); }
  });
});
await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r));
after(() => agent.close());
const base = `http://127.0.0.1:${(agent.address() as { port: number }).port}`;

async function client(connect: boolean, identity: string) {
  const boot = await fetch(base + '/api/conversations');
  const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
  const call = async (url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  if (connect) {
    const account = fixture.accounts.find((a) => a.identity === identity)!;
    assert.equal((await call('/api/business/connect', account)).status, 200);
  }
  const ask = async (question: string, mode: 'chat' | 'task' = 'chat') => {
    const conv = await call('/api/conversations', { mode });
    const res = await fetch(base + `/api/conversations/${conv.data.id}/messages`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, clientRequestId: `req-${Math.random().toString(36).slice(2, 10)}` })
    });
    const events = (await res.text()).split('\n\n')
      .map((s) => s.split('\n').find((l) => l.startsWith('data: ')))
      .filter(Boolean)
      .map((l) => JSON.parse(String(l).slice(6))) as any[];
    const done = events.find((e) => e.type === 'run_completed');
    assert.ok(done, '本轮必须有终态事件：' + JSON.stringify(events.map((e) => ({ type: e.type, code: e.payload?.code ?? e.error?.code, message: e.payload?.message ?? e.error?.message }))));
    return { answer: String(done.payload.answer ?? ''), toolResults: events.filter((e) => e.type === 'tool_result'), events };
  };
  return { call, ask };
}

test('B1 管理员问"签到情况"得到真实汇总（计数+缺口学号），红线随附', async () => {
  const c = await client(true, 'admin');
  const { answer, toolResults } = await c.ask('今天签到情况怎么样');
  const tr = toolResults.find((t) => t.payload?.tool === 'query_checkin_summary');
  assert.ok(tr, '必须调用 query_checkin_summary：' + JSON.stringify(toolResults.map((t) => t.payload?.tool)));
  assert.equal(tr.payload.ok, true);
  assert.equal(tr.payload.resultKind, 'checkin_summary');
  const result = tr.payload.result;
  assert.match(result.boundaryNote, /请勿代替学生签到/);
  const lesson = result.sessions.find((s: any) => s.timetableId === 'fixture-lesson');
  assert.ok(lesson, '评审夹具 pm1 课程必须在汇总中');
  assert.equal(lesson.expected, 3, '名册 3 人（含补录的两名未签到学号）');
  assert.equal(lesson.checkedIn, 1);
  assert.deepEqual(lesson.absentUsernames, ['2023002', '2023003']);
  assert.equal(result.totals.absent, 2);
  assert.match(answer, /应到 3/);
  assert.match(answer, /2023002/);
  assert.match(answer, /请勿代替学生签到/);
  assert.ok(!lesson.absentUsernames.some((s: string) => /[评审核]/.test(s)), '名单只含学号，不含姓名');
});

test('B2 学生问"签到情况"路由到本人状态，拿不到缺口名单', async () => {
  const c = await client(true, 'student');
  const { toolResults } = await c.ask('今天签到情况怎么样');
  const tools = toolResults.map((t) => t.payload?.tool);
  assert.ok(!tools.includes('query_checkin_summary'), '学生不得触发汇总工具：' + JSON.stringify(tools));
  const status = toolResults.find((t) => t.payload?.tool === 'query_checkin_status');
  assert.ok(status && status.payload.ok, '学生应得到本人签到状态');
  const lesson = status.payload.result.lessons.find((l: any) => l.timetableId === 'fixture-lesson');
  assert.equal(lesson.status, 'signed');
  assert.equal(status.payload.result.boundaryNote, '签到须本人在实验室现场完成，Agent 不代签');
});

test('B3 直连端点角色矩阵：管理员 200、志愿者/学生 403、访客令牌 401', async () => {
  const login = async (identity: string) => {
    const account = fixture.accounts.find((a) => a.identity === identity)!;
    return (await (await fetch(`http://127.0.0.1:${nativePort}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: account.account, password: account.password })
    })).json()).token as string;
  };
  const adminToken = await login('admin');
  const ok = await fetch(`http://127.0.0.1:${nativePort}/api/integration/checkin-summary`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(ok.status, 200);
  for (const identity of ['volunteer', 'student']) {
    const token = await login(identity);
    const res = await fetch(`http://127.0.0.1:${nativePort}/api/integration/checkin-summary`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403, `${identity} 必须被拒绝`);
  }
  const visitor = await fetch(`http://127.0.0.1:${nativePort}/api/integration/checkin-summary`, { headers: { 'X-Lab-Token': 'anything' } });
  assert.equal(visitor.status, 401);
});
