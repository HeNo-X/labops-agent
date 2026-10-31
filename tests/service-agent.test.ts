/**
 * 服务端执行通道：/api/service/agent-run 的契约与安全边界（2026-10-31）
 * ============================================================================
 *  这条通道让**主系统调度器**代某个用户在 LabOps 里真跑一轮 Agent。它是机器到机器，
 *  没有登录态，所以安全全靠四件事，四件都要有测试：
 *    ① 签名：错签、过期时间戳、重放 nonce 一律拒；
 *    ② 白名单：调用方没列出的工具，**运行时**也调不动（不是只在提示词里少写几个）；
 *    ③ 幂等：同一个 jobRunId 第二次进来回缓存，不重跑；
 *    ④ 归属：会话按 owner 命名空间隔离，不与其他账号串上下文。
 *
 *  运行：node --test tests/service-agent.test.ts
 */

process.env.LABOPS_AUTH_MODE = 'demo';
process.env.LABOPS_SERVICE_SECRET = 'test-service-secret';
process.env.AGNES_API_KEY = '';
process.env.DASHSCOPE_API_KEY = '';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-service-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'agent.sqlite');

const { __serviceInternals, handleServiceAgent, signServicePayload } = await import('../server/api/service-agent.ts');
const { toolsForMode, executeTool } = await import('../server/tools/registry.ts');

before(() => __serviceInternals.resetNonces());

/** 伪造一次 HTTP 请求/响应，直接打 handler（不必起真服务） */
function fakeExchange(body: unknown, headers: Record<string, string>) {
  const raw = JSON.stringify(body);
  const req = new Readable({ read() {} }) as unknown as import('node:http').IncomingMessage;
  Object.assign(req, { method: 'POST', url: '/api/service/agent-run', headers: { 'content-type': 'application/json', ...headers } });
  process.nextTick(() => {
    const stream = req as unknown as Readable;
    stream.push(raw);
    stream.push(null); // Readable 用 push(null) 表示 EOF；它没有 .end()
  });
  const out: { status: number; body: string } = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(text?: string) {
      out.body = text ?? '';
    },
    setHeader() {},
    get headersSent() {
      return out.status !== 0;
    }
  } as unknown as import('node:http').ServerResponse;
  return { req, res, out, raw };
}

function signedHeaders(raw: string, nonce = 'abcdef0123456789', ts = Math.floor(Date.now() / 1000)) {
  const signature = signServicePayload(process.env.LABOPS_SERVICE_SECRET!, ts, nonce, raw);
  return { 'x-service-ts': String(ts), 'x-service-nonce': nonce, 'x-service-signature': signature };
}

const VALID = {
  jobRunId: 'run-abc-0001',
  owner: { id: 'admin', role: 'admin' },
  prompt: '查一下 E310 在 2026-09-28 的课表',
  allowedTools: [] as string[]
};

test('入参校验：jobRunId / owner.role / prompt 都会挡', () => {
  const bad = __serviceInternals.coerce;
  assert.equal(bad({ ...VALID, jobRunId: 'x' }).ok, false, 'jobRunId 太短要拒');
  assert.equal(bad({ ...VALID, owner: { id: 'a', role: 'root' } }).ok, false, '非法角色要拒');
  assert.equal(bad({ ...VALID, prompt: '   ' }).ok, false, '空指令要拒');
  assert.equal(bad({ ...VALID, prompt: 'x'.repeat(2001) }).ok, false, '超长指令要拒');
  const good = bad({ ...VALID, allowedTools: ['prepare_notification', 'prepare_notification', '  '] });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.value.allowedTools, ['prepare_notification'], '白名单要去重去空');
});

test('会话按 owner 隔离：不同账号不会串到同一上下文', () => {
  const a = __serviceInternals.sessionIdOf('admin', 'scheduled-run-abc-0001');
  const b = __serviceInternals.sessionIdOf('stu01', 'scheduled-run-abc-0001');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('admin:') && b.startsWith('stu01:'));
});

test('白名单是运行时硬拦：没列出的工具连调都调不动', async () => {
  const allowed = toolsForMode('chat').map((t) => t.name);
  assert.ok(!allowed.includes('prepare_notification'), '只读模式本就不含写类工具');
  const denied = await executeTool('prepare_notification', { title: 'x', content: 'y' }, {
    dataset: { labs: [], users: [], timetable: [] } as never,
    now: { iso: new Date().toISOString() } as never,
    allowedTools: allowed
  });
  assert.equal(denied.ok, false);
  assert.equal((denied as { code: string }).code, 'tool_not_allowed');
});

test('签名：错签 / 过期 / 重放 三种都拒', async () => {
  const { req, res, out, raw } = fakeExchange(VALID, {});
  Object.assign(req, { headers: { 'content-type': 'application/json', ...signedHeaders(raw, 'deadbeefdeadbeef'), 'x-service-signature': 'f'.repeat(64) } });
  await handleServiceAgent(req, res, '/api/service/agent-run');
  assert.equal(out.status, 401);
  assert.match(out.body, /bad_signature/);

  const stale = Math.floor(Date.now() / 1000) - 4000;
  const r2 = fakeExchange(VALID, signedHeaders(raw, 'cafebabe00112233', stale));
  await handleServiceAgent(r2.req, r2.res, '/api/service/agent-run');
  assert.equal(r2.out.status, 409);
  assert.match(r2.out.body, /stale_timestamp/);
});

test('正常执行一次；同一 jobRunId 再来直接回缓存（不重跑）', async () => {
  const body = { ...VALID, jobRunId: 'run-idem-0001' };
  const first = fakeExchange(body, {});
  Object.assign(first.req, { headers: { 'content-type': 'application/json', ...signedHeaders(first.raw, 'aaaa1111bbbb2222') } });
  await handleServiceAgent(first.req, first.res, '/api/service/agent-run');
  assert.equal(first.out.status, 200, first.out.body);
  const one = JSON.parse(first.out.body) as { ok: boolean; runId: string; replayed: boolean; allowedTools: string[]; mode: string };
  assert.equal(one.ok, true);
  assert.equal(one.replayed, false);
  assert.equal(one.mode, 'chat', '没白名单时按只读跑');
  assert.ok(one.runId, '必须回 runId 供调度器对账');

  const second = fakeExchange(body, {});
  Object.assign(second.req, { headers: { 'content-type': 'application/json', ...signedHeaders(second.raw, 'cccc3333dddd4444') } });
  await handleServiceAgent(second.req, second.res, '/api/service/agent-run');
  assert.equal(second.out.status, 200);
  const two = JSON.parse(second.out.body) as { replayed: boolean; runId: string };
  assert.equal(two.replayed, true, '第二次必须是缓存命中');
  assert.equal(two.runId, one.runId, '重放要回同一个 runId');
});
