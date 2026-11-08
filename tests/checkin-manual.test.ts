/**
 * 学生签到接入：批次 4（写·管理员代录）双服务验收
 * ============================================================================
 *  链路：管理员在 LabOps 任务模式问"给 X 补录…" → 确定性路由 prepare_business_workflow
 *  → /api/business/proxy/plans/commit（scopeKey+本人确认）→ 主系统 commitBusinessState
 *  → syncBusinessRecords 落 SQLite（checkin_records + record_audit 代录痕迹）→
 *  重启回读口径 / 汇总端点可见（缺口闭合）。
 *  学生侧：同句式不得触发代录（路由与端点双 403）。
 *
 *  运行：node --test tests/checkin-manual.test.ts
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-checkin-manual-'));
const nativeDir = path.join(temp, 'native');
createReviewFixture(nativeDir);
// 名册补两名未签到学号（只动名册；签到记录唯一权威是 SQLite）
{
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(nativeDir, f), 'utf8'));
  const write = (f: string, v: unknown) => fs.writeFileSync(path.join(nativeDir, f), JSON.stringify(v, null, 2), { mode: 0o600 });
  const wrapped = read('state.json');
  wrapped.state.classRoster.push({ sno: '2023002', className: '评审示例班' }, { sno: '2023003', className: '评审示例班' });
  // 代录目标必须在主系统存在（principals 校验）；夹具只造名册记录不行，补真实学生账号与凭据条目
  wrapped.state.users.push({ username: '2023002', identity: 'student', className: '评审示例班', name: '评审学生二' });
  const crypto = require('node:crypto');
  const password = crypto.randomBytes(12).toString('base64url'), salt = crypto.randomBytes(16).toString('hex');
  const creds = read('credentials.json');
  creds['2023002'] = { username: '2023002', identity: 'student', name: '评审学生二', className: '评审示例班', status: 'active', salt, hash: crypto.scryptSync(password, salt, 64).toString('hex'), mustChangePassword: false };
  write('state.json', wrapped);
  write('credentials.json', creds);
}
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
process.env.DATA_DIR = nativeDir;
const nativeDb = require('../../Pages/lib/db.js') as { insertCheckin: (r: Record<string, unknown>) => string };
nativeDb.insertCheckin({ id: 'ck-manual-1', labId: 'fixture-e310', type: 'checkin', time: `${shDate} 14:05:00`, valid: true, username: 'review-student', className: '评审示例班', timetableId: 'fixture-lesson' });

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
    assert.ok(done, '本轮必须有终态事件：' + JSON.stringify(events.map((e) => ({ type: e.type, code: e.payload?.code, message: e.payload?.message }))));
    return { answer: String(done.payload.answer ?? ''), toolResults: events.filter((e) => e.type === 'tool_result'), events, conversationId: conv.data.id };
  };
  return { call, ask };
}

test('B1 补录/代签请求经 Agent 一律婉拒（2026-11-08 红线：不调工具、不出方案）', async () => {
  const c = await client(true, 'admin');
  const { answer, toolResults } = await c.ask('给 2023002 补录今天下午第一大节在 E310 的签到，原因：设备故障无法扫码（隔离样例）', 'task');
  assert.equal(toolResults.length, 0, '婉拒路径不得调用任何工具：' + JSON.stringify(toolResults.map((t) => t.payload?.tool)));
  assert.match(answer, /做不了|不能代签|不能代为补录/);
  assert.match(answer, /主系统/);
});

test('B2 学生问同一句同样婉拒（红线对全员一致，不区分身份）', async () => {
  const c = await client(true, 'student');
  const { answer, toolResults } = await c.ask('给 2023002 补录今天下午第一大节在 E310 的签到，原因：设备故障', 'task');
  assert.equal(toolResults.length, 0, '婉拒路径不得调用任何工具');
  assert.match(answer, /做不了|不能代签|不能代为补录/);
});

test('B3 直接端点角色矩阵：仅管理员可代录，学生/志愿者 403、访客令牌 401', async () => {
  const adminAccount = fixture.accounts.find((a) => a.identity === 'admin')!;
  const body = { kind: 'checkin.manual', targetUsername: 'review-student', date: shDate, periodKey: 'pm1', labId: 'fixture-e310', reason: '隔离样例代录' };
  const login = await (await fetch(`http://127.0.0.1:${nativePort}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: adminAccount.account, password: adminAccount.password })
  })).json();
  const adminPre = await fetch(`http://127.0.0.1:${nativePort}/api/integration/workflow/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify(body) });
  assert.equal(adminPre.status, 200, JSON.stringify(adminPre));
  const preps = (await adminPre.json()).plan as { state: string; id: string };
  assert.equal(preps.state, 'awaiting_confirmation');
  const adminCommit = await fetch(`http://127.0.0.1:${nativePort}/api/integration/plans/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify({ planId: preps.id, version: 1 }) });
  assert.equal(adminCommit.status, 200, JSON.stringify(adminCommit));
  const adminReceipt = (await adminCommit.json()).receipt as { operationId: string; objects: Array<{ kind: string }> };
  assert.ok(adminReceipt.operationId.startsWith('business-plan-'), '提交回执按方案编号重放');
  assert.equal(adminReceipt.objects[0].kind, 'checkin_record');
  for (const identity of ['volunteer', 'student']) {
    const account = fixture.accounts.find((a) => a.identity === identity)!;
    const token = ((await (await fetch(`http://127.0.0.1:${nativePort}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: account.account, password: account.password })
    })).json()).token) as string;
    const res = await fetch(`http://127.0.0.1:${nativePort}/api/integration/workflow/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal(res.status, 403, `${identity} 必须被拒绝`);
  }
  const visitor = await fetch(`http://127.0.0.1:${nativePort}/api/integration/workflow/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': 'anything' }, body: JSON.stringify(body) });
  assert.equal(visitor.status, 401);
});
