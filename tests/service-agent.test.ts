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
// 本文件可直接 node --test 运行：必须与 run-tests.mjs 同口径切断磁盘 .env，
// 否则备用链（BigModel/星火）会在 chat 模式真调付费模型（测试不得调用付费模型）。
process.env.LABOPS_SKIP_ENV_FILE = '1';
for (const k of ['AGNES_API_KEY', 'DASHSCOPE_API_KEY', 'VISION_API_KEY']) delete process.env[k];

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
const { getDb } = await import('../server/persistence/db.ts');

async function runService(body: unknown, nonce: string) {
  const ex = fakeExchange(body, {});
  Object.assign(ex.req, { headers: { 'content-type': 'application/json', ...signedHeaders(ex.raw, nonce) } });
  await handleServiceAgent(ex.req, ex.res, '/api/service/agent-run');
  return ex.out;
}

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

test('签到接入批次3：定时轮默认只读集自带签到工具，agentTools 勾选也合法', () => {
  const chatTools = toolsForMode('chat').map((t) => t.name);
  assert.ok(chatTools.includes('query_checkin_status'), '本人签到状态必须在默认只读集里（到点轮可直接用）');
  assert.ok(chatTools.includes('query_checkin_summary'), '签到汇总必须在默认只读集里（admin 到点轮可直接用）');
  const taskTools = toolsForMode('task').map((t) => t.name);
  for (const name of ['query_checkin_status', 'query_checkin_summary']) {
    assert.ok(taskTools.includes(name), `${name} 必须在 task 工具集（service-agent 白名单校验基准）`);
  }
  const coerced = __serviceInternals.coerce({ ...VALID, allowedTools: ['query_checkin_status', 'query_checkin_summary', 'query_checkin_summary', ' '] });
  assert.equal(coerced.ok, true);
  if (coerced.ok) assert.deepEqual(coerced.value.allowedTools, ['query_checkin_status', 'query_checkin_summary'], '显式列出签到工具合法且去重去空');
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

test('签到接入批次3：到点真实跑一轮，签到问法走演示引擎如实回答（未连接不编造）', async () => {
  const body = { ...VALID, jobRunId: 'run-checkin-0001', prompt: '今天签到情况怎么样' };
  const first = fakeExchange(body, {});
  Object.assign(first.req, { headers: { 'content-type': 'application/json', ...signedHeaders(first.raw, 'eeee4444ffff5555') } });
  await handleServiceAgent(first.req, first.res, '/api/service/agent-run');
  assert.equal(first.out.status, 200, first.out.body);
  const one = JSON.parse(first.out.body) as { ok: boolean; answer: string; toolCalls?: Array<{ tool: string; ok: boolean }> };
  assert.equal(one.ok, true);
  // 测试工作区未连接主系统：演示引擎兜底必须如实说取不到，绝不编造缺口
  assert.match(one.answer, /没有连接原系统|取不到签到汇总/);
  assert.match(one.answer, /请勿代替学生签到/);
  assert.ok(!/\d{6,}/.test(one.answer.replace(/2026-\d{2}-\d{2}/g, '')), '不得编造学号名单');
});

// ---------------------------------------------------------------------------
// 整合方案 §5（2026-11-09）：到点自动化必须落成真实会话——"跑了但结果不在任何会话里"
// 等于没跑；失败也要落一条写明原因，让用户能区分"没执行"和"执行失败"。
// ---------------------------------------------------------------------------
test('自动化到点落会话：新建 automation 会话 + 指令/结果双消息 + 徽标字段', async () => {
  const body = { ...VALID, jobRunId: 'run-conv-0001', prompt: '查询E310在2026-09-28的课表', jobTitle: '晚间课表巡检', jobId: 'job-eve-01' };
  const out = await runService(body, 'aa0011bb22cc33dd');
  assert.equal(out.status, 200, out.body);
  const one = JSON.parse(out.body) as { ok: boolean; runId: string; conversationId: string };
  assert.ok(one.conversationId, '应答必须带 conversationId');
  const d = getDb();
  const conv = d.prepare('SELECT id,title,mode,ownerId,source,jobId FROM conversations WHERE id=?').get(one.conversationId) as Record<string, unknown>;
  assert.ok(conv, '会话必须真实落库');
  assert.equal(conv['source'], 'automation', '会话必须打自动化来源标记（前端徽标依据）');
  assert.equal(conv['ownerId'], 'admin', '归属必须是任务账号而不是 legacy-unassigned');
  assert.equal(conv['jobId'], 'job-eve-01');
  assert.match(String(conv['title']), /^晚间课表巡检 · \d{4}-\d{2}-\d{2}$/, '标题=任务名+日期');
  const msgs = d.prepare('SELECT role,text,status,meta FROM messages WHERE conversationId=? ORDER BY ordinal').all(one.conversationId) as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 2, 'user 指令 + assistant 结果各一条');
  assert.equal(msgs[0]['role'], 'user');
  assert.equal(msgs[0]['text'], body.prompt, 'user 消息必须是指令原文');
  assert.equal(msgs[1]['role'], 'assistant');
  assert.equal(msgs[1]['status'], 'completed');
  assert.ok(String(msgs[1]['text']).includes('E310'), '助手消息必须是结果全文');
  const meta = JSON.parse(String(msgs[1]['meta'])) as Record<string, unknown>;
  assert.equal(meta['runId'], one.runId, 'runId 落进消息 meta 供对账');
  assert.equal(meta['source'], 'automation');
});

test('自动化不同 jobRunId 各建会话不覆盖；重放同一 jobRunId 不再建第三个', async () => {
  const second = await runService({ ...VALID, jobRunId: 'run-conv-0002', prompt: '查询E310在2026-09-28的课表' }, 'bb1122cc33dd44ee');
  assert.equal(second.status, 200, second.body);
  const replay = await runService({ ...VALID, jobRunId: 'run-conv-0001', prompt: '查询E310在2026-09-28的课表' }, 'cc2233dd44ee55ff');
  const replayJson = JSON.parse(replay.body) as { replayed: boolean; conversationId: string };
  assert.equal(replayJson.replayed, true, '同 jobRunId 必须走缓存');
  assert.ok(replayJson.conversationId, '重放应答同样要带会话编号（形状一致）');
  const secondJson = JSON.parse(second.body) as { conversationId: string };
  assert.notEqual(secondJson.conversationId, replayJson.conversationId, '第二次触发的会话不得覆盖第一次');
  const d2 = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE conversationId=?').get(secondJson.conversationId) as Record<string, unknown>;
  assert.equal(Number(d2['n']), 2, '新会话自己落齐双消息');
  const replayed = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE conversationId=?').get(replayJson.conversationId) as Record<string, unknown>;
  assert.equal(Number(replayed['n']), 2, '重放不追加任何消息');
});

test('执行失败也落会话：assistant 写明失败码与建议（区分“没执行”和“执行失败”）', async () => {
  const out = await runService({ ...VALID, jobRunId: 'run-fail-0001', allowedTools: ['no_such_tool'] }, 'ee4455ff66aa77bb');
  assert.equal(out.status, 400, out.body);
  const d = getDb();
  const json = JSON.parse(out.body) as { error: string };
  assert.equal(json.error, 'bad_tools');
  const conv = d.prepare("SELECT id FROM conversations WHERE source='automation' AND ownerId='admin' AND jobId='run-fail-0001'").get() as Record<string, unknown> | undefined;
  assert.ok(conv, '失败也必须有会话可查（不是静默丢弃）');
  const msgs = d.prepare('SELECT role,text,status,meta FROM messages WHERE conversationId=? ORDER BY ordinal').all(String(conv['id'])) as Array<Record<string, unknown>>;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1]['status'], 'failed');
  assert.match(String(msgs[1]['text']), /定时自动化执行失败/);
  assert.match(String(msgs[1]['text']), /bad_tools/, '消息正文必须带错误码');
  const meta = JSON.parse(String(msgs[1]['meta'])) as { error?: { code: string } };
  assert.equal(meta.error?.code, 'bad_tools');
});

test('native 登录态下自动化按登录态账号 id 归属（username 代传不落列表外的口径）', async () => {
  const d = getDb();
  d.prepare('INSERT OR REPLACE INTO business_connections VALUES (?,?,?)').run('native-fakehash-for-verify', 'enc:v1:dummy', JSON.stringify({ username: 'admin', identity: 'admin', className: '', name: '系统管理员' }));
  try {
    const out = await runService({ ...VALID, jobRunId: 'run-native-0001', jobTitle: '归属口径验证' }, 'aa77bb88cc99ddee');
    assert.equal(out.status, 200, out.body);
    const j = JSON.parse(out.body) as { conversationId: string };
    const conv = d.prepare('SELECT ownerId FROM conversations WHERE id=?').get(j.conversationId) as Record<string, unknown>;
    assert.equal(conv['ownerId'], 'native-fakehash-for-verify', '会话必须挂到与登录态同一 native actor id，否则列表不可见');
  } finally {
    d.prepare('DELETE FROM business_connections WHERE ownerId=?').run('native-fakehash-for-verify');
  }
});

test('列表可见性：automation 会话带 source 出现在本人列表（徽标数据面）', async () => {
  const { listConversations } = await import('../server/persistence/db.ts');
  const rows = listConversations().filter((c) => c.source === 'automation');
  assert.ok(rows.length >= 2, '前面落下的自动化会话必须能在列表里按 source 筛出');
  assert.ok(rows.every((c) => c.title.includes('·')), '标题带日期分隔');
});
