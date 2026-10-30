/**
 * 运行快照端点（只读投影）—— 权限、会话隔离、缺字段如实为 null
 * ============================================================================
 *  独立临时库；快照只读，不产生任何副作用。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-snapshot-'));
process.env['LABOPS_DB_PATH'] = path.join(tmp, 'agent.sqlite');
process.env['LABOPS_AUTH_MODE'] = 'demo';
process.env['AGNES_API_KEY'] = '';
process.env['LABOPS_BUSINESS_URL'] = '';

const { withHttpIdentity } = await import('../server/security/http.ts');
const { handleRequest } = await import('../server/index.ts');
const db = await import('../server/persistence/db.ts');

const server = http.createServer((req, res) => {
  withHttpIdentity(req, res, () => handleRequest(req, res)).catch((e) => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

async function demoClient() {
  const boot = await fetch(base + '/api/conversations');
  const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
  return async (url: string, method = 'GET') => {
    const res = await fetch(base + url, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-LabOps-Sandbox-Role': 'admin' }
    });
    return { status: res.status, data: (await res.json()) as any };
  };
}

/** 落一轮并返回 runId/消息 id；answer 为空表示"仍在流式" */
function seedRun(conversationId: string, opts: { answer?: string; status?: string; toolCalls?: unknown[] } = {}) {
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  const created = db.createMessageWithRun(conversationId, '测试问题', `req-${runId}`, runId);
  assert.ok(!('duplicate' in created));
  const { assistant } = created;
  if (opts.status !== 'running') {
    const toolCalls = (opts.toolCalls ?? [{ toolCallId: 'tc1', tool: 'query_schedule', args: { labId: 'E310' }, ok: true, ms: 12, summary: 'E310 今天 3 节课' }]) as never;
    db.finalizeAssistantMessage(assistant.id, runId, (opts.status ?? 'completed') as never, opts.answer ?? '结论', {
      conversationId,
      responseMode: 'task',
      queriedAt: new Date().toISOString(),
      toolCalls,
      engine: 'demo',
      sourceType: 'snapshot',
      ms: 1200
    });
  }
  return { runId, assistantMessageId: assistant.id };
}

test('T5-01 快照返回已落库事实：终态、正文、工具调用、起止时间', async () => {
  const call = await demoClient();
  const conv = (await call('/api/conversations', 'POST')).data as { id: string };
  const { runId } = seedRun(conv.id, { answer: 'E310 今天有 3 节课' });
  const r = await call(`/api/conversations/${conv.id}/run-snapshot?runId=${runId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.runId, runId);
  assert.equal(r.data.conversationId, conv.id);
  assert.equal(r.data.terminal, 'completed');
  assert.equal(r.data.phase, 'completed');
  assert.equal(r.data.saved, true);
  assert.equal(r.data.answerText, 'E310 今天有 3 节课');
  assert.equal(r.data.toolCalls.length, 1);
  assert.equal(r.data.toolCalls[0].tool, 'query_schedule');
  assert.equal(r.data.lastSeq, null, 'events seq 不落库，恒为 null，不编造');
  assert.ok(r.data.startedAt, 'startedAt 来自 runs 行');
});

test('T5-02 缺 runId → 400；runId 不属于该会话 → 404（不泄露别处运行是否存在）', async () => {
  const call = await demoClient();
  const a = (await call('/api/conversations', 'POST')).data as { id: string };
  const b = (await call('/api/conversations', 'POST')).data as { id: string };
  const { runId } = seedRun(a.id);
  assert.equal((await call(`/api/conversations/${a.id}/run-snapshot`)).status, 400);
  const crossed = await call(`/api/conversations/${b.id}/run-snapshot?runId=${runId}`);
  assert.equal(crossed.status, 404, '跨会话取快照必须拒绝');
  assert.equal(crossed.data.error, 'run_not_found');
  assert.equal((await call(`/api/conversations/nonexistent/run-snapshot?runId=${runId}`)).status, 404);
});

test('T5-03 仍在运行：terminal 为 null、saved 为 false，且不伪装成完成', async () => {
  const call = await demoClient();
  const conv = (await call('/api/conversations', 'POST')).data as { id: string };
  const { runId } = seedRun(conv.id, { status: 'running' });
  const r = await call(`/api/conversations/${conv.id}/run-snapshot?runId=${runId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.terminal, null);
  assert.equal(r.data.phase, null, '不知道在跑工具还是在想，就不猜相位');
  assert.equal(r.data.saved, false);
  assert.equal(r.data.endedAt, null);
  assert.equal(r.data.answerText, '', '没有正文就如实为空');
  assert.deepEqual(r.data.proposals, []);
});

test('T5-04 失败轮：terminal=failed，正文与工具调用仍如实返回', async () => {
  const call = await demoClient();
  const conv = (await call('/api/conversations', 'POST')).data as { id: string };
  const { runId } = seedRun(conv.id, { status: 'failed', answer: '部分回答' });
  const r = await call(`/api/conversations/${conv.id}/run-snapshot?runId=${runId}`);
  assert.equal(r.data.terminal, 'failed');
  assert.equal(r.data.answerText, '部分回答', '失败前已生成的内容必须保留可见');
});

test('T5-05 只读：快照请求不产生任何新消息或新运行', async () => {
  const call = await demoClient();
  const conv = (await call('/api/conversations', 'POST')).data as { id: string };
  const { runId } = seedRun(conv.id);
  const before = db.getMessages(conv.id).length;
  await call(`/api/conversations/${conv.id}/run-snapshot?runId=${runId}`);
  await call(`/api/conversations/${conv.id}/run-snapshot?runId=${runId}`);
  assert.equal(db.getMessages(conv.id).length, before, 'GET 快照不得写入任何消息');
});
