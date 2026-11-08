/**
 * 学生签到状态接入：批次 1（读·学生侧）验收
 * ============================================================================
 *  A 部分：主系统 GET /api/integration/checkin-status 的 dispatch 直测（隔离夹具，
 *          固定时钟）——课程归属、逐节状态、phase/lateWindow、越权与降级口径。
 *  B 部分：真实双服务 HTTP（主系统 serve.js + LabOps，评审夹具）——学生经悬浮窗
 *          通道（demo 引擎 + 确定性路由）问"我签到了吗"，工具 query_checkin_status
 *          返回本人真实状态；管理端如实说无本人数据；学生业务门禁不被放大。
 *
 *  口径锁定（与 occupancy.test.ts 三锁定一致）：
 *    · 只回本人记录，他人明细依旧无开放接口；
 *    · 签到须本人在场完成，Agent 不代签（boundaryNote 固定文案）；
 *    · 取不到时如实说明，不编造。
 *
 *  运行：node --test tests/checkin-status.test.ts
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

const student = { username: '2023001', identity: 'student', className: 'Fixture A' };
// 2026-11-09 是周一；pm1=14:00–15:30（开课前 10 分钟开放，开课 20 分钟后记补签到）
const MONDAY = (h: number, m: number) => new Date(`2026-11-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
const rec = (over: Record<string, unknown>) => ({
  id: 'r1', labId: 'a', labName: 'E310', type: 'checkin', username: '2023001', name: 'S',
  periodKey: 'pm1', timetableId: 't1', time: '2026-11-09 14:05:00', status: '签到', valid: true, ...over
});
function fixtureState(records: unknown[] = []) {
  return {
    sysConfig: { term: 'fixture', termStart: '2026-09-07', termEnd: '2027-01-31', holidays: [], specialDays: [] },
    labs: [{ id: 'a', name: 'E310', capacity: 60, status: 'active' }, { id: 'b', name: 'E312', capacity: 60, status: 'active' }], openLabs: [],
    timetable: [{ id: 't1', labId: 'a', labName: 'E310', className: 'Fixture A', classNames: ['Fixture A'], courseId: 'c', courseName: 'Fixture Course', teacher: 'Fixture Teacher', term: 'fixture', weekday: 1, periodKey: 'pm1', status: 'normal', weeks: { from: 1, to: 20, parity: 'all' } }],
    courses: [{ id: 'c', name: 'Fixture Course' }], classes: [{ id: 'class-a', name: 'Fixture A', size: 30 }], classRoster: [],
    users: [], scheduleAdjust: [], dutyShifts: [], notifications: [], openLabStatus: {}, openLabStatusMeta: {},
    checkinRecords: records
  };
}
const call = (state: unknown, actor: unknown, now: Date, query: Record<string, string> = {}) =>
  dispatch({ method: 'GET', path: '/checkin-status', query, actor, state, now, commit: () => { throw new Error('read-only'); } });

test('A1 已签到：状态、节次窗口与入口路径来自服务端口径', () => {
  const out = call(fixtureState([rec({})]), student, MONDAY(14, 30));
  assert.equal(out.date, '2026-11-09');
  assert.equal(out.timezone, 'Asia/Shanghai');
  assert.equal(out.contractVersion, 3);
  assert.equal(out.currentPeriod.key, 'pm1');
  const l = out.lessons[0];
  assert.equal(l.timetableId, 't1');
  assert.equal(l.courseName, 'Fixture Course');
  assert.equal(l.labName, 'E310');
  assert.equal(l.status, 'signed');
  assert.equal(l.phase, 'open');
  assert.equal(l.lateWindow, true, '14:30 已超过开课 20 分钟，现在去签会记补签到——但已有记录不再是补签窗口');
  assert.equal(l.lateSignin, false);
  assert.equal(l.checkinTime, '2026-11-09 14:05:00');
  assert.equal(l.checkinPath, '/student-checkin.html?lab=a');
  assert.equal(out.boundary, undefined, '边界文案由 Agent 侧固定，主系统只给数据');
});

test('A2 未签到开窗内不判补签；开课后 20 分钟内 lateWindow=false', () => {
  const out = call(fixtureState([]), student, MONDAY(14, 10));
  assert.equal(out.lessons[0].status, 'unsigned');
  assert.equal(out.lessons[0].phase, 'open');
  assert.equal(out.lessons[0].lateWindow, false);
});

test('A3 未开窗 upcoming、下课 ended', () => {
  assert.equal(call(fixtureState([]), student, MONDAY(13, 40)).lessons[0].phase, 'upcoming');
  assert.equal(call(fixtureState([]), student, MONDAY(16, 0)).lessons[0].phase, 'ended');
});

test('A4 签退（含自动签退幂等 id）', () => {
  const manual = call(fixtureState([rec({}), rec({ id: 'r2', type: 'checkout', time: '2026-11-09 15:00:00' })]), student, MONDAY(16, 0));
  assert.equal(manual.lessons[0].status, 'signed_out');
  assert.equal(manual.lessons[0].autoSignout, false);
  assert.equal(manual.lessons[0].checkoutTime, '2026-11-09 15:00:00');
  const auto = call(fixtureState([rec({}), rec({ id: 'r1_autoend', type: 'checkout', time: '2026-11-09 15:30:00', auto: true })]), student, MONDAY(16, 0));
  assert.equal(auto.lessons[0].status, 'signed_out');
  assert.equal(auto.lessons[0].autoSignout, true);
});

test('A5 记录标记如实透传：补签到、扫错实验室、定位失败', () => {
  const late = call(fixtureState([rec({ status: '补签到', time: '2026-11-09 14:40:00' })]), student, MONDAY(14, 45));
  assert.equal(late.lessons[0].lateSignin, true);
  const mismatch = call(fixtureState([rec({ labId: 'b' })]), student, MONDAY(14, 30));
  assert.equal(mismatch.lessons[0].mismatch, true);
  const failed = call(fixtureState([rec({ locationFailed: true })]), student, MONDAY(14, 30));
  assert.equal(failed.lessons[0].locationFailed, true);
});

test('A6 隐私：只匹配本人记录；作废记录不参与；legacy 无 timetableId 记录按节次+实验室归属', () => {
  const others = call(fixtureState([rec({ username: '2023002' }), rec({ id: 'r9', valid: false })]), student, MONDAY(14, 30));
  assert.equal(others.lessons[0].status, 'unsigned');
  // 无 timetableId 的记录：同节次但另一实验室 → 不得算到本课头上
  const legacy = call(fixtureState([rec({ id: 'lg', username: '2023001', timetableId: '', periodKey: 'pm1', labId: 'b' })]), student, MONDAY(14, 30));
  assert.equal(legacy.lessons[0].status, 'unsigned', 'lab 不一致的 legacy 记录不误归');
  // 无 timetableId 但实验室一致 → 按节次归属（兼容老记录）
  const legacySame = call(fixtureState([rec({ id: 'lg2', username: '2023001', timetableId: '', periodKey: 'pm1', labId: 'a' })]), student, MONDAY(14, 30));
  assert.equal(legacySame.lessons[0].status, 'signed');
});

test('A7 降级与越权：非学生如实说明、无班级如实说明、坏日期 400、学生业务门禁不放大', () => {
  const admin = call(fixtureState([]), { username: 'adm', identity: 'admin' }, MONDAY(14, 30));
  assert.equal(admin.lessons.length, 0);
  assert.match(admin.note, /仅面向学生身份/);
  const noClass = call(fixtureState([]), { username: 's2', identity: 'student' }, MONDAY(14, 30));
  assert.match(noClass.note, /尚未关联班级/);
  assert.throws(() => call(fixtureState([]), student, MONDAY(14, 30), { date: '2026-13-99' }), /YYYY-MM-DD/);
  const other = call(fixtureState([]), student, MONDAY(14, 30), { date: '2026-11-10' });
  assert.equal(other.lessons.length, 0, '非当天合法日期只回当天无课的空清单');
  assert.throws(() => dispatch({ method: 'GET', path: '/tasks', body: undefined, actor: student, state: fixtureState([]), now: MONDAY(14, 30), commit: () => {} }), /学生|forbidden|403/);
});

// ============================ B 部分：真实双服务 HTTP ============================

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-checkin-'));
const nativeDir = path.join(temp, 'native');
createReviewFixture(nativeDir);
// 夹具只有一名学生，而 B1/B2 需要"有记录 / 无记录"两个独立账号——
// 在启动前给夹具补第二个学生账号（凭证 scrypt 口径与夹具生成器一致）。
{
  const crypto = await import('node:crypto');
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(nativeDir, f), 'utf8'));
  const write = (f: string, v: unknown) => fs.writeFileSync(path.join(nativeDir, f), JSON.stringify(v, null, 2), { mode: 0o600 });
  const credentials = read('credentials.json'), wrapped = read('state.json'), access = read('review-access.json');
  const state = wrapped.state as { users: unknown[]; classRoster: unknown[] };
  const password = 'CheckinFixture2-2026', salt = crypto.randomBytes(16).toString('hex');
  credentials['review-student2'] = { username: 'review-student2', identity: 'student', name: '评审学生二', className: '评审示例班', status: 'active', salt, hash: crypto.scryptSync(password, salt, 64).toString('hex'), mustChangePassword: false };
  state.users.push({ username: 'review-student2', identity: 'student', name: '评审学生二', className: '评审示例班' });
  state.classRoster.push({ sno: 'review-student2', className: '评审示例班' });
  access.accounts.push({ account: 'review-student2', password, identity: 'student' });
  write('credentials.json', credentials); write('state.json', wrapped); write('review-access.json', access);
}
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
// ⚠️ 记录类唯一权威是 SQLite：签到数据必须走主系统数据层写入，改 JSON 是假的
process.env.DATA_DIR = nativeDir;
const nativeDb = require('../../Pages/lib/db.js') as { insertCheckin: (r: Record<string, unknown>) => string };
// review-student 在 pm1（示例程序设计 @ E310）已有一条签到；另一学生 2023002 无记录
nativeDb.insertCheckin({ id: 'ck-b1', labId: 'fixture-e310', type: 'checkin', time: `${shDate} 14:05:00`, valid: true, username: 'review-student', className: '评审示例班', timetableId: 'fixture-lesson' });

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
    const account = identity === 'student2'
      ? fixture.accounts.find((a) => a.account === 'review-student2')!
      : fixture.accounts.find((a) => a.identity === identity)!;
    assert.equal((await call('/api/business/connect', account)).status, 200);
  }  const ask = async (question: string, mode: 'chat' | 'task' = 'chat') => {
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

test('B1 学生经悬浮窗通道查询本人签到状态（已签到侧）', async () => {
  const c = await client(true, 'student');
  const { answer, toolResults } = await c.ask('我签到了吗');
  const tr = toolResults.find((t) => t.payload?.tool === 'query_checkin_status');
  assert.ok(tr, '必须调用 query_checkin_status：' + JSON.stringify(toolResults.map((t) => t.payload?.tool)));
  assert.equal(tr.payload.ok, true);
  assert.equal(tr.payload.resultKind, 'checkin_status');
  const result = tr.payload.result;
  assert.equal(result.boundaryNote, '签到须本人在实验室现场完成，Agent 不代签');
  const lesson = result.lessons.find((l: any) => l.timetableId === 'fixture-lesson');
  assert.ok(lesson, '评审夹具 pm1 课程必须在结果中');
  assert.equal(lesson.status, 'signed');
  assert.equal(lesson.courseName, '示例程序设计');
  assert.equal(lesson.labName, 'E310');
  assert.equal(lesson.checkinPath, '/student-checkin.html?lab=fixture-e310');
  assert.match(answer, /签到/);
  assert.match(tr.payload.summary, /已签到/);
});

test('B2 无记录学生如实报未签到，不编造', async () => {
  // 第二个学生账号（同一班级同一课表），未插入任何签到记录
  const c = await client(true, 'student2');
  const { answer, toolResults } = await c.ask('我现在签到状态怎么样？');
  const tr = toolResults.find((t) => t.payload?.tool === 'query_checkin_status');
  assert.ok(tr && tr.payload.ok, '工具必须成功返回结构');
  const lesson = tr.payload.result.lessons.find((l: any) => l.timetableId === 'fixture-lesson');
  assert.ok(lesson, '课程归属照常返回');
  assert.equal(lesson.status, 'unsigned');
  assert.match(tr.payload.summary, /未签到/);
  assert.match(answer, /签到/);
});

test('B3 管理员查询如实说明仅面向学生身份', async () => {
  const c = await client(true, 'admin');
  const { toolResults } = await c.ask('我签到了吗');
  const tr = toolResults.find((t) => t.payload?.tool === 'query_checkin_status');
  assert.ok(tr, '管理员也走同一工具');
  assert.match(tr.payload.summary, /仅面向学生身份/);
});

test('B5 任务模式（桌面工作会话默认）同样出真实签到状态', async () => {
  const c = await client(true, 'student');
  const { answer, toolResults } = await c.ask('我签到了吗', 'task');
  const tr = toolResults.find((t) => t.payload?.tool === 'query_checkin_status');
  assert.ok(tr && tr.payload.ok, '任务模式必须调用同一工具');
  const lesson = tr.payload.result.lessons.find((l: any) => l.timetableId === 'fixture-lesson');
  assert.equal(lesson.status, 'signed');
  assert.match(answer, /示例程序设计/);
});

test('B6 未连接沙盒：本人签到问法如实说取不到，不再伪装成"无接口"', async () => {
  const c = await client(false, 'student');
  const { answer, toolResults } = await c.ask('我签到了吗');
  assert.equal(toolResults.filter((t) => t.payload?.tool === 'query_checkin_status').length, 0, '未连接不应调用签到工具');
  assert.match(answer, /没有连接原系统|取不到本人签到状态/);
  assert.match(answer, /不代签/);
  assert.match(answer, /没有对 LabOps 开放的接口/, '他人明细的口径保留在同一回答内');
});

test('B4 主系统端点直接访问：本人数据放行、他人业务 403、坏参数 400、访客令牌 401', async () => {
  const account = fixture.accounts.find((a) => a.identity === 'student')!;
  const login = await (await fetch(`http://127.0.0.1:${nativePort}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: account.account, password: account.password })
  })).json();
  const token = login.token as string;
  assert.ok(token, '学生登录成功');
  const status = await (await fetch(`http://127.0.0.1:${nativePort}/api/integration/checkin-status`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(status.actor.username, 'review-student');
  assert.ok(Array.isArray(status.lessons));
  const forbidden = await fetch(`http://127.0.0.1:${nativePort}/api/integration/tasks`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(forbidden.status, 403, '学生业务门禁不被新端点放大');
  const bad = await fetch(`http://127.0.0.1:${nativePort}/api/integration/checkin-status?date=2026-13-99`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bad.status, 400);
  const visitor = await fetch(`http://127.0.0.1:${nativePort}/api/integration/checkin-status`, { headers: { 'X-Lab-Token': 'anything' } });
  assert.equal(visitor.status, 401, 'LAB_TOKEN 访客只读通道不开放签到状态');
});
