/**
 * 回档 × 原系统：真实本地双服务 HTTP 验收（0.6.0）
 * ============================================================================
 *  这是回档最容易被吹牛的一半，所以用真的主系统来验：
 *   · **未提交**的方案在回档时被真正 reject（这是真回退，不是"标记一下"）；
 *   · **已提交**的写入原系统没有通用撤销接口 —— 必须如实列进 blocked 清单，
 *     而且业务数据一点都不能被动到。会话照常回档，两件事互不冒充。
 *
 *  运行：node --test tests/native-rollback.test.ts
 */

process.env.LABOPS_AUTH_MODE = 'demo';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Fixture CLI is ordinary JavaScript, also runnable without a transpiler.
import { createReviewFixture } from '../scripts/create-review-fixture.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-native-rollback-'));
const fixture = createReviewFixture(path.join(temp, 'native')) as { date: string; accounts: Array<{ account: string; password: string; identity: string }> };
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
const native = spawn(process.execPath, [fileURLToPath(new URL('../../Pages/serve.js', import.meta.url))], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(nativePort), DATA_DIR: path.join(temp, 'native'), REGISTER_OPEN: '0', ENABLE_SEED_ACCOUNTS: '0', ENABLE_BASE_SEED: '0' },
  stdio: ['ignore', 'ignore', 'pipe']
});
let startupError = '';
native.stderr.on('data', (chunk) => {
  startupError += chunk.toString();
});
for (let i = 0; i < 80; i++) {
  if (native.exitCode !== null) throw new Error('原系统启动失败：' + startupError);
  try {
    if ((await fetch(`http://127.0.0.1:${nativePort}/api/health`)).ok) break;
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 50));
}

/** 打开 DEBUG 用的原系统真实地址，便于排查；生产代码不读它 */
process.env['LABOPS_TEST_NATIVE_URL'] = process.env.LABOPS_BUSINESS_URL;

const { withHttpIdentity } = await import('../server/security/http.ts');
const { handleRequest } = await import('../server/index.ts');
const db = await import('../server/persistence/db.ts');

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

type Req = (url: string, body?: unknown) => Promise<{ status: number; data: any }>;

/** 与 bridge-http.test.ts 同一套客户端：demo 会话 cookie + 主系统账号连接 */
async function client(identity: string): Promise<Req> {
  const boot = await fetch(base + '/api/business/status');
  const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
  const account = fixture.accounts.find((a) => a.identity === identity)!;
  const req: Req = async (url, body) => {
    const res = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(url.startsWith('/api/business/proxy/') ? { scopeKey, ...(body as Record<string, unknown>) } : body) })
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  let scopeKey = '';
  const login = await req('/api/business/connect', account);
  assert.equal(login.status, 200, JSON.stringify(login.data));
  scopeKey = String(login.data.scopeKey);
  return req;
}

/** 落一轮：把原系统方案的引用写进 assistant 消息 meta，与真实运行产物同形 */
function seedRoundWithPlan(conversationId: string, planId: string, planState: string): { userMessageId: string } {
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  const created = db.createMessageWithRun(conversationId, `按方案办理 ${planId}`, `req-${runId}`, runId);
  assert.ok(!('duplicate' in created));
  db.finalizeAssistantMessage(created.assistant.id, runId, 'completed', '原系统方案已准备，等待人工确认。', {
    conversationId,
    responseMode: 'task',
    queriedAt: new Date().toISOString(),
    context: { labName: null, date: fixture.date, task: 'schedule' },
    toolCalls: [
      {
        toolCallId: `call-${planId}`,
        tool: 'prepare_business_plan',
        args: {},
        ok: true,
        resultKind: 'business_plan',
        result: { summary: '原系统方案已准备', planId, plan: { id: planId, state: planState, version: 1 }, view: 'schedule', candidates: [], workbenchUrl: '/operations.html', source: '原系统' }
      }
    ]
  });
  return { userMessageId: created.userMessage.id };
}

async function newConversation(req: Req): Promise<string> {
  const res = await req('/api/conversations', { mode: 'task' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return String(res.data.id);
}

after(async () => {
  native.kill('SIGTERM');
  agent.closeAllConnections();
  await new Promise<void>((r) => agent.close(() => r()));
  try {
    db.getDb().close();
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 120));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('原系统未提交方案：回档真的把它 reject 掉（不是标记）', async () => {
  const admin = await client('admin');
  // 用 issue.create 造方案：不依赖课表候选，测试之间不会互相改变前提
  const preview = await admin('/api/business/proxy/workflow/preview', { kind: 'issue.create', roomId: 'fixture-e310', description: '回档验收：未提交方案' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const planId = String(preview.data.plan.id);
  assert.equal(preview.data.plan.state, 'awaiting_confirmation');

  const conv = await newConversation(admin);
  const { userMessageId } = seedRoundWithPlan(conv, planId, 'awaiting_confirmation');

  const res = await admin(`/api/conversations/${conv}/rollback`, { userMessageId, revertEffects: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.effects.rejectedPlans, [planId], JSON.stringify(res.data.effects));
  assert.equal(db.getMessages(conv).length, 0, '会话必须真的回到本轮之前');

  const after1 = await admin('/api/business/proxy/plans/' + planId);
  assert.equal(after1.status, 200);
  assert.equal(after1.data.plan.state, 'rejected', '原系统方案必须真的被拒绝，回档后不能还能提交');
  assert.equal(after1.data.receipt, null);
});

test('原系统已提交写入：如实列入 blocked 清单，业务数据一点不动', async () => {
  const admin = await client('admin');
  const preview = await admin('/api/business/proxy/schedule/preview', { date: fixture.date, timetableId: 'fixture-lesson', toLabId: 'fixture-e312', toPeriodKey: 'pm1', reason: '回档验收：已提交方案' });
  const planId = String(preview.data.plan.id);
  const commit = await admin('/api/business/proxy/plans/commit', { planId, version: preview.data.plan.version });
  assert.equal(commit.status, 200, JSON.stringify(commit.data));
  const operationId = String(commit.data.receipt.operationId);

  const before = await admin('/api/business/proxy/context');
  const adjustmentsBefore = before.data.adjustments.length;

  const conv = await newConversation(admin);
  const { userMessageId } = seedRoundWithPlan(conv, planId, 'committed');
  const res = await admin(`/api/conversations/${conv}/rollback`, { userMessageId, revertEffects: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.effects.blocked.length, 1, JSON.stringify(res.data.effects));
  assert.equal(res.data.effects.blocked[0].planId, planId);
  assert.match(String(res.data.effects.blocked[0].reason), /没有通用撤销接口/);
  assert.deepEqual(res.data.effects.reverted, [], '原系统写入不能被谎称为"已回退"');
  assert.equal(db.getMessages(conv).length, 0, '会话回档照做');

  const afterCtx = await admin('/api/business/proxy/context');
  assert.equal(afterCtx.data.adjustments.length, adjustmentsBefore, '原系统业务数据不得因为回档被改动');
  const receipt = await admin('/api/business/proxy/operations/' + operationId);
  assert.equal(receipt.status, 200, '回执必须仍然可查 —— 发生过的事不会因为回档消失');
});

test('未勾选回退写入时，待确认方案仍然被作废（否则会留下本轮的状态泄漏）', async () => {
  const admin = await client('admin');
  const preview = await admin('/api/business/proxy/workflow/preview', { kind: 'issue.create', roomId: 'fixture-e310', description: '回档验收：不勾选回退' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const planId = String(preview.data.plan.id);

  const conv = await newConversation(admin);
  const { userMessageId } = seedRoundWithPlan(conv, planId, 'awaiting_confirmation');
  const res = await admin(`/api/conversations/${conv}/rollback`, { userMessageId });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after1 = await admin('/api/business/proxy/plans/' + planId);
  assert.equal(after1.data.plan.state, 'rejected', '回档必须让本轮的方案失效，与"是否回退已执行写入"无关');
});

test('未连接原系统时回档照做，并明确说明无法核对原系统方案', async () => {
  const boot = await fetch(base + '/api/business/status');
  const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
  const disconnected: Req = async (url, body) => {
    const res = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  const conv = await newConversation(disconnected);
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  const created = db.createMessageWithRun(conv, '办理一个原系统方案', `req-${runId}`, runId);
  assert.ok(!('duplicate' in created));
  db.finalizeAssistantMessage(created.assistant.id, runId, 'completed', '已准备。', {
    conversationId: conv,
    toolCalls: [
      { toolCallId: 'call-x', tool: 'prepare_business_plan', args: {}, ok: true, resultKind: 'business_plan', result: { summary: 's', planId: 'plan-00000000-0000-0000-0000-000000000000', plan: { id: 'plan-00000000-0000-0000-0000-000000000000', state: 'awaiting_confirmation', version: 1 }, candidates: [], workbenchUrl: '/', source: '原系统' } }
    ]
  });
  const res = await disconnected(`/api/conversations/${conv}/rollback`, { userMessageId: created.userMessage.id, revertEffects: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(db.getMessages(conv).length, 0);
  assert.ok(res.data.effects.notes.some((n: string) => n.includes('未连接原系统')), JSON.stringify(res.data.effects.notes));
});
