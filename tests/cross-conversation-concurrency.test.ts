/**
 * 跨会话并发第二片 —— 端到端回归（真起 HTTP/SSE，不用桩）
 * ============================================================================
 *  D01 服务端确实可以让两个不同会话同时各跑一个 run，事件流互不串扰
 *  D02 同会话仍严格串行（409 run_conflict）；第二片没有放宽既有互斥
 *  D03 全局并发上限占满时排队：发可读提示、释放名额后自动开始、终态照常落库
 *  D04 别的会话重连（owner 级 generation+1）不再改变身份指纹 —— 不误杀在途 run
 *  D05 两个会话同时准备同一把钥匙，后提交的被主系统乐观令牌拦下（不引入新锁）
 *
 * 负向验证：把 server/api/conversations.ts 的闸门接线去掉，D03 应转红；
 * 把 server/agent/run.ts 的 identity-key 改回 businessScope().scopeKey，D04 应转红。
 */
process.env.LABOPS_AUTH_MODE = 'demo';
process.env.LABOPS_SKIP_ENV_FILE = '1';
process.env.AGNES_API_KEY = '';
for (const key of ['DASHSCOPE_API_KEY', 'BIGMODEL_API_KEY', 'SPARK_API_KEY', 'QWEN_API_KEY']) {
  delete process.env[key];
}
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-concurrency-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'test.sqlite');
process.env.DATA_DIR = path.join(temp, 'pages-data');

const db = await import('../server/persistence/db.ts');
const { handleRequest } = await import('../server/index.ts');
const { withHttpIdentity } = await import('../server/security/http.ts');
const { businessIdentityKey } = await import('../server/business/identity-key.ts');
const { businessScope } = await import('../server/business/bridge.ts');
const { acquireRunSlot, runGateStats, resetRunGateForTests } = await import('../server/agent/run-gate.ts');
const require = createRequire(import.meta.url);
const { dispatch } = require('../../Pages/server/operations.js');

interface SseEvent {
  type?: string;
  runId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as SseEvent);
    } catch {
      /* 非 JSON 块忽略 */
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  withHttpIdentity(req, res, () => handleRequest(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const call = (url: string, cookie = '', method = 'GET', body?: unknown) =>
  fetch(base + url, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

let seq = 0;
async function createConversation(cookie: string, title: string): Promise<string> {
  const res = await call('/api/conversations', cookie, 'POST', { title });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { id: string };
  assert.ok(data.id);
  return data.id;
}

async function postMessage(cookie: string, conversationId: string, message: string) {
  const res = await call(`/api/conversations/${conversationId}/messages`, cookie, 'POST', {
    message,
    clientRequestId: `conc-req-${++seq}-${Date.now()}`
  });
  const text = await res.text();
  return { status: res.status, events: res.status === 200 ? parseSse(text) : [] };
}

const cap = await call('/api/capabilities');
const cookie = (cap.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
assert.ok(cookie, 'demo 模式应下发会话 Cookie');
await cap.text();

after(async () => {
  resetRunGateForTests();
  delete process.env['AGENT_MAX_CONCURRENT_RUNS'];
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db.getDb().close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('D01 两个不同会话可同时各跑一个 run，事件流按 runId 隔离', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '2';
  const c1 = await createConversation(cookie, '并发-A');
  const c2 = await createConversation(cookie, '并发-B');
  const [r1, r2] = await Promise.all([
    postMessage(cookie, c1, '你好'),
    postMessage(cookie, c2, '今天有课吗')
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const a1 = r1.events.find((e) => e.type === 'run_accepted');
  const a2 = r2.events.find((e) => e.type === 'run_accepted');
  assert.ok(a1?.runId && a2?.runId, '两轮都应被接受');
  assert.notEqual(a1.runId, a2.runId, '服务端应为两轮生成不同 runId');
  assert.ok(r1.events.every((e) => !e.runId || e.runId === a1.runId), 'A 流里不得出现 B 的事件');
  assert.ok(r2.events.every((e) => !e.runId || e.runId === a2.runId), 'B 流里不得出现 A 的事件');
  for (const r of [r1, r2]) {
    assert.ok(r.events.some((e) => e.type === 'end' && e.payload?.['saved'] === true), '终态必须落库');
  }
  const rows = db
    .getDb()
    .prepare('SELECT id,status FROM runs WHERE conversationId IN (?,?)')
    .all(c1, c2) as Array<{ id: string; status: string }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status !== 'running'), '两轮都应到达终态');
});

test('D02 同一会话仍严格互斥：第二个请求 409 run_conflict', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '1';
  const blocker = await acquireRunSlot({ runId: 'd02-blocker', conversationId: 'external' });
  const c = await createConversation(cookie, '同会话互斥');
  const first = postMessage(cookie, c, '第一问');
  await new Promise((r) => setTimeout(r, 60)); // 等它进入排队并落 running
  assert.equal(runGateStats().waiting, 1);
  const second = await postMessage(cookie, c, '第二问');
  assert.equal(second.status, 409);
  blocker.release();
  const settled = await first;
  assert.equal(settled.status, 200);
  assert.equal(runGateStats().active, 0, '终态后名额必须归还');
});

test('D03 上限占满先排队并给出可读提示，释放后自动开始', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '1';
  const blocker = await acquireRunSlot({ runId: 'd03-blocker', conversationId: 'external' });
  const c = await createConversation(cookie, '排队');
  const pending = postMessage(cookie, c, '排队这一问');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runGateStats().waiting, 1);
  blocker.release();
  const done = await pending;
  assert.equal(done.status, 200);
  const queued = done.events.find((e) => e.type === 'run_queued');
  assert.ok(queued, '应发出排队提示事件');
  assert.match(String(queued.payload?.['message'] ?? ''), /排队/);
  assert.ok(!String(queued.payload?.['message'] ?? '').includes('runId'), '提示里不出现开发者信息');
  assert.ok(done.events.some((e) => e.type === 'end' && e.payload?.['saved'] === true));
  assert.equal(runGateStats().active, 0);
});

test('D04 别的会话重连（generation+1）不改身份指纹，账号变化才改', () => {
  const d = db.getDb();
  d.exec(
    `CREATE TABLE IF NOT EXISTS business_connections(ownerId TEXT PRIMARY KEY, token TEXT NOT NULL, profile TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS business_generations(ownerId TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'disconnected');`
  );
  const profile = (username: string) => JSON.stringify({ username, identity: 'admin', className: '智能本2501' });
  d.prepare('INSERT OR REPLACE INTO business_connections VALUES (?,?,?)').run('owner-conc', 'plain-token', profile('teacher'));
  d.prepare('INSERT OR REPLACE INTO business_generations VALUES (?,1,?)').run('owner-conc', 'connected');

  const before = businessIdentityKey('owner-conc');
  const scopeBefore = businessScope('owner-conc').scopeKey;
  d.prepare('UPDATE business_generations SET generation=generation+1 WHERE ownerId=?').run('owner-conc');
  assert.equal(businessIdentityKey('owner-conc'), before, '重连不能让在途 run 判定 scope_changed');
  assert.notEqual(businessScope('owner-conc').scopeKey, scopeBefore, '业务代理的完整 scopeKey 仍随 generation 变化');

  d.prepare('UPDATE business_connections SET profile=? WHERE ownerId=?').run(profile('another'), 'owner-conc');
  assert.notEqual(businessIdentityKey('owner-conc'), before, '真换账号仍必须中止在途 run');
});

test('D06 旧 /api/agent/chat 通道也共享全局名额，上限不被绕过', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '1';
  const blocker = await acquireRunSlot({ runId: 'd06-blocker', conversationId: 'external' });
  const pending = fetch(base + '/api/agent/chat', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '你好', clientRequestId: `d06-${Date.now()}` })
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runGateStats().waiting, 1, '旧通道应进入同一条队列');
  blocker.release();
  const res = await pending;
  assert.equal(res.status, 200);
  const events = parseSse(await res.text());
  assert.ok(events.some((e) => e.type === 'run_queued'), '旧通道也要给排队提示');
  assert.ok(events.some((e) => e.type === 'end'));
  assert.equal(runGateStats().active, 0);
});

test('D05 两个会话同时准备同一把钥匙，后提交的被乐观令牌拦下', () => {
  const now = new Date('2026-11-14T20:00:00+08:00');
  const admin = { username: 'fixture-admin', identity: 'admin' };
  const vol = { username: 'fixture-vol', identity: 'volunteer' };
  const state = {
    sysConfig: { term: 'fixture', termStart: '2026-09-07', termEnd: '2027-01-31', holidays: [], specialDays: [] },
    labs: [{ id: 'a', name: 'E310', capacity: 60, status: 'active', equipment: ['projector'] }],
    openLabs: [], timetable: [], courses: [], classes: [], classRoster: [], users: [admin, vol],
    scheduleAdjust: [], dutyShifts: [], notifications: [],
    keys: [{ id: 'k-conc', labId: 'a', name: 'E310钥匙', labName: 'E310', holder: '', location: '钥匙柜' }],
    opsPlans: [], opsLedger: [], opsTasks: []
  };
  let current: any = state;
  const send = (path: string, body: Record<string, unknown>) =>
    dispatch({
      method: 'POST', path, body, actor: admin, state: current, now,
      commit: (next: any) => { current = next; }
    });
  const input = { kind: 'key.lend', keyId: 'k-conc', holderUsername: 'fixture-vol' };
  const planA = send('/workflow/preview', { ...input, cardId: '会话A' }).plan as { id: string; version: number; payload: Record<string, unknown> };
  const planB = send('/workflow/preview', { ...input, cardId: '会话B' }).plan as { id: string; version: number; payload: Record<string, unknown> };
  assert.notEqual(planA.id, planB.id);
  assert.equal(planA.payload['expectedHolder'], planB.payload['expectedHolder'], '两份方案基于同一份台账快照');

  const receipt = send('/plans/commit', { planId: planA.id, version: planA.version }).receipt;
  assert.ok(receipt);
  assert.equal((current['keys'] as Array<{ holder: string }>)[0]?.holder, 'fixture-vol');
  assert.throws(() => send('/plans/commit', { planId: planB.id, version: planB.version }), /变化/);
  assert.equal((current['keys'] as Array<{ holder: string }>)[0]?.holder, 'fixture-vol', '第二次提交不得覆盖');
  assert.equal((current['opsLedger'] as unknown[]).length, 1, '只应有一条真实回执');
});
