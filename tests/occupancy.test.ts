/**
 * 在室人数：真实双服务 HTTP 验收（2026-10-06）
 * ============================================================================
 *  背景：用户看到的是「在室人数：未知 —— 系统没有签到/门禁数据来源」，但主系统
 *  自 0.5.0 起已有 `/api/integration/occupancy`（当日有效签到−有效签退，与主系统页面同源），
 *  工具 `query_lab_status` 也早已调用它 —— 是**渲染层与兜底规则**把真实值抹掉了：
 *    · demo-engine 的越界正则 `/几个人|多少人|在室|签到…/` 抢在工具之前一律拒绝；
 *    · renderLabStatusAnswer / summarizeLabStatus / TaskResult 卡片硬编码"未知"。
 *  本用例锁死三件事：
 *    ① 已连通时给出真实数字（含工具摘要，不只是正文）；
 *    ② 未连通时仍然如实说"取不到"，绝不编数；
 *    ③ 逐人签到明细依旧如实说不可得（它确实没有开放接口）。
 *
 *  运行：node --test tests/occupancy.test.ts
 */

process.env.LABOPS_AUTH_MODE = 'demo';
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-occupancy-'));
const nativeDir = path.join(temp, 'native');
createReviewFixture(nativeDir);

/** 上海时区的"今天"——主系统 /occupancy 就是这个口径 */
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
// ⚠️ r36-4.2 起，state.json 里的 checkinRecords 被置空，**SQLite 才是记录类的唯一权威**；
//    所以签到数据必须走主系统自己的数据层写入，改 JSON 是假的。
process.env.DATA_DIR = nativeDir;
const nativeDb = createRequire(import.meta.url)('../../Pages/lib/db.js') as {
  insertCheckin: (r: Record<string, unknown>) => string;
};
// 给 E310 造两条签到、一条签退 → 在室 = 2 − 1 = 1；E312 无记录 → 0
nativeDb.insertCheckin({ id: 'ck-1', labId: 'fixture-e310', type: 'checkin', time: `${shDate}T09:00:00+08:00`, valid: true, username: 'fixture-student', className: '评审示例班' });
nativeDb.insertCheckin({ id: 'ck-2', labId: 'fixture-e310', type: 'checkin', time: `${shDate}T09:05:00+08:00`, valid: true, username: 'fixture-student', className: '评审示例班' });
nativeDb.insertCheckin({ id: 'ck-3', labId: 'fixture-e310', type: 'checkout', time: `${shDate}T09:30:00+08:00`, valid: true, username: 'fixture-student', className: '评审示例班' });

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
nativeSrv.stderr.on('data', (c) => {
  startupError += c.toString();
});
for (let i = 0; i < 80; i++) {
  if (nativeSrv.exitCode !== null) throw new Error('原系统启动失败：' + startupError);
  try {
    if ((await fetch(`http://127.0.0.1:${nativePort}/api/health`)).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 50));
}

const { withHttpIdentity } = await import('../server/security/http.ts');
const { handleRequest } = await import('../server/index.ts');
const db = await import('../server/persistence/db.ts');
const fixture = JSON.parse(fs.readFileSync(path.join(nativeDir, 'review-access.json'), 'utf8')) as { accounts: Array<{ account: string; password: string; identity: string }> };

const agent = http.createServer((req, res) => {
  withHttpIdentity(req, res, () => handleRequest(req, res)).catch((e) => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
});
await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(agent.address() as { port: number }).port}`;

interface Client {
  cookie: string;
  call: (url: string, body?: unknown) => Promise<{ status: number; data: any }>;
  ask: (question: string) => Promise<{ answer: string; toolSummaries: string[]; events: any[] }>;
}

/** 每个 demo cookie 都是独立工作区 —— 正好用来对照"连通 / 未连通"两侧 */
async function client(connect: boolean, identity = 'admin'): Promise<Client> {
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
  const ask = async (question: string) => {
    const conv = await call('/api/conversations', { mode: 'chat' });
    const res = await fetch(base + `/api/conversations/${conv.data.id}/messages`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, clientRequestId: `req-${Math.random().toString(36).slice(2, 10)}` })
    });
    const events = (await res.text())
      .split('\n\n')
      .map((s) => s.split('\n').find((l) => l.startsWith('data: ')))
      .filter(Boolean)
      .map((l) => JSON.parse(String(l).slice(6))) as any[];
    const done = events.find((e) => e.type === 'run_completed');
    assert.ok(done, '本轮必须有终态事件：' + JSON.stringify(events.map((e) => e.type)));
    return {
      answer: String(done.payload.answer ?? ''),
      toolSummaries: events.filter((e) => e.type === 'tool_result').map((e) => String(e.payload?.summary ?? '')),
      events
    };
  };
  return { cookie, call, ask };
}

after(async () => {
  nativeSrv.kill('SIGTERM');
  agent.closeAllConnections();
  await new Promise<void>((r) => agent.close(() => r()));
  try {
    db.getDb().close();
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 120));
  // Windows 上本进程仍持有 nativeDir/lab.db 的连接（lib/db.js 未导出 close），
  // 临时目录可能删不掉 —— 清理是尽力而为，不能让一个 EPERM 把整个用例判失败。
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    /* 临时目录留给系统清理 */
  }
});

test('已连接原系统：在室人数给出真实数字（正文与工具摘要都必须带值）', async () => {
  const a = await client(true);
  const out = await a.ask('E310 现在有多少人？');
  assert.match(out.answer, /在室人数：1 人/, out.answer);
  assert.match(out.answer, /有效签到−有效签退/, out.answer);
  assert.ok(!/无法提供|没有签到/.test(out.answer), '有数据就不该说无法提供：' + out.answer);
  assert.ok(out.toolSummaries.some((s) => /在室人数 1 人/.test(s)), '工具摘要同样不能再说"无数据来源"：' + JSON.stringify(out.toolSummaries));
});

test('已连接原系统：房间确实没有签到时给 0，而不是"未知"', async () => {
  const a = await client(true);
  const out = await a.ask('E312 现在有多少人？');
  assert.match(out.answer, /在室人数：0 人/, out.answer);
  assert.match(out.answer, /记录数口径/, out.answer);
});

test('未连接原系统：仍然如实说取不到，绝不编数', async () => {
  const a = await client(false);
  const out = await a.ask('E310 现在有多少人？');
  assert.match(out.answer, /没有连接原系统账号/, out.answer);
  assert.ok(!/\d+\s*人/.test(out.answer.replace(/没有连接原系统账号/, '')), '未连通时不得出现任何人数：' + out.answer);
  assert.equal(out.toolSummaries.length, 0, '未连通时不应该调用业务工具');
});

test('逐人签到明细：确实没有接口，如实说不可得（但不牵连房间人数）', async () => {
  const a = await client(true);
  const out = await a.ask('E310 今天的签到记录都有谁？');
  assert.match(out.answer, /逐人签到\/签退\/补签明细没有对 LabOps 开放的接口/, out.answer);
  assert.match(out.answer, /房间在室人数可以查/, out.answer);
});

test('未连接时问签到明细：同样明说不可得，不与"在室人数"混淆', async () => {
  const a = await client(false);
  const out = await a.ask('帮我查 E310 的签到明细');
  assert.match(out.answer, /没有对 LabOps 开放的接口/, out.answer);
});
