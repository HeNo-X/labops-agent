/**
 * 轮次操作测试 —— 删除本轮 / 回档到本轮发起前 / 业务写入补偿（0.6.0）
 * ============================================================================
 *  独立临时库（R25-lite 约定）：LABOPS_DB_PATH 必须在任何 db 导入之前设置。
 *  覆盖的是**语义**，不依赖模型：轮次消息由 createMessageWithRun + finalizeAssistantMessage
 *  直接落库（与真实运行完全同一条写入路径），沙盒回执由 insertOpsOperation 直接落库
 *  （与 gateway + executor 产出同形）。
 *
 *  运行：node --test tests/round-actions.test.ts
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-round-'));
process.env['LABOPS_DB_PATH'] = path.join(tmp, 'agent.sqlite');
process.env['LABOPS_AUTH_MODE'] = 'demo';
process.env['AGNES_API_KEY'] = '';
process.env['LABOPS_BUSINESS_URL'] = '';

const { withHttpIdentity } = await import('../server/security/http.ts');
const { handleRequest } = await import('../server/index.ts');
const db = await import('../server/persistence/db.ts');
const typeOps = await import('../shared/operations-contract.ts');

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

const actor = { id: 'demo-round-actor', role: 'admin' as const, label: '演示管理员' };

/** 演示会话：先要一次 /api/health 之外的受保护请求拿到 cookie，再带着它调新接口 */
async function demoClient(): Promise<(url: string, body?: unknown, method?: string) => Promise<{ status: number; data: any }>> {
  const boot = await fetch(base + '/api/conversations');
  const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
  return async (url, body, method) => {
    const res = await fetch(base + url, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-LabOps-Sandbox-Role': 'admin' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, data: (await res.json()) as any };
  };
}

/** 落一轮：user + assistant（含 meta.context 与可选工具结果），返回消息 id */
function seedRound(
  conversationId: string,
  question: string,
  answer: string,
  context: { labName: string | null; date: string | null; task: string | null },
  toolCalls: Array<Record<string, unknown>> = []
): { userMessageId: string; assistantMessageId: string; runId: string } {
  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  const created = db.createMessageWithRun(conversationId, question, `req-${runId}`, runId);
  assert.ok(!('duplicate' in created), '种子轮次不应被判为重复请求');
  const { userMessage, assistant } = created;
  db.finalizeAssistantMessage(assistant.id, runId, 'completed', answer, {
    conversationId,
    responseMode: 'task',
    queriedAt: new Date().toISOString(),
    toolCalls,
    context
  });
  return { userMessageId: userMessage.id, assistantMessageId: assistant.id, runId };
}

/** 造一条"沙盒已执行"的回执：提案 + 执行记录 + 真实 biz 对象，形状与 gateway 一致 */
function seedExecutedIssue(conversationId: string, description: string): { proposalId: string; taskId: string; operationId: string; issueId: string } {
  const task = db.createOpsTask({ kind: 'issue', goal: description, actor, conversationId });
  const proposal = db.createOpsProposal({
    taskId: task.taskId,
    actionType: 'issue.create',
    payload: { roomId: 'E310', category: 'device', description, attachmentRefs: [] },
    payloadHash: 'hash',
    environment: 'sandbox',
    title: '报修',
    summary: description,
    effects: [],
    missingDependencies: [],
    requiredCapabilities: [],
    evidence: [],
    payloadKind: 'issue',
    payloadView: { description },
    canExecute: true,
    cannotExecuteReason: null
  });
  const issue = db.insertBizIssue({ roomId: 'E310', category: 'device', description, actor, attachmentRefs: [] });
  const operationId = `op-${issue.id}`;
  const receipt: import('../shared/operations-contract.ts').OperationReceipt = {
    ok: true,
    operationId,
    requestHash: 'request-hash',
    businessStatus: 'committed',
    executionEnvironment: 'sandbox',
    objects: [{ kind: 'issue', id: issue.id, revision: 1 }],
    committedAt: new Date().toISOString(),
    deliveryStatus: 'not_applicable',
    deliveryNote: null,
    auditId: 'audit-seed',
    actor,
    proposalId: proposal.proposalId,
    proposalVersion: proposal.version
  };
  db.insertOpsOperation({ clientRequestId: `creq-${operationId}`, proposalId: proposal.proposalId, actionType: 'issue.create', requestHash: 'request-hash', receipt });
  return { proposalId: proposal.proposalId, taskId: task.taskId, operationId, issueId: issue.id };
}

function toolCallWithProposal(proposal: { proposalId: string; taskId: string }): Record<string, unknown> {
  return {
    toolCallId: `call-${proposal.proposalId}`,
    tool: 'prepare_issue_ticket',
    args: { roomId: 'E310' },
    ok: true,
    resultKind: 'operation_proposal',
    result: { proposalId: proposal.proposalId, taskId: proposal.taskId, actionType: 'issue.create', state: 'executed' }
  };
}

async function newConversation(request: Awaited<ReturnType<typeof demoClient>>, mode: 'chat' | 'task'): Promise<string> {
  const res = await request('/api/conversations', { mode });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return String(res.data.id);
}

function conversationContext(id: string): { labName: string | null; date: string | null; task: string | null } {
  const ctx = db.loadContext(id);
  assert.ok(ctx, '会话上下文应可读');
  return ctx;
}

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  try {
    db.getDb().close();
  } catch {
    /* 已关闭 */
  }
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test('R3 删除本轮：只删该轮的 user+assistant，前后轮次与顺序不变', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  const r1 = seedRound(conv, '第一问', '第一答', { labName: 'E310', date: '2026-09-28', task: 'schedule' });
  const r2 = seedRound(conv, '第二问', '第二答', { labName: null, date: '2026-09-29', task: null });
  const r3 = seedRound(conv, '第三问', '第三答', { labName: 'E312', date: null, task: 'notification' });

  const res = await request(`/api/conversations/${conv}/rounds/${r2.userMessageId}`, undefined, 'DELETE');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.mode, 'delete_round');
  assert.deepEqual(res.data.removedMessageIds.sort(), [r2.userMessageId, r2.assistantMessageId].sort());
  assert.deepEqual(res.data.removedRunIds, [r2.runId]);

  const left = db.getMessages(conv).map((m) => m.id);
  assert.deepEqual(left, [r1.userMessageId, r1.assistantMessageId, r3.userMessageId, r3.assistantMessageId]);
  // ordinal 不重排：历史顺序由 ordinal 决定，留空洞不影响排序
  const ordinals = db.getMessages(conv).map((m) => m.ordinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
  // 上下文按"最后一个非空值"重建（与 finalizeAssistantMessage 的 COALESCE 语义一致）：
  // 第三轮给了 labName/task，date 回落到第一轮
  assert.deepEqual(conversationContext(conv), { labName: 'E312', date: '2026-09-28', task: 'notification' });
});

test('R4 回档：截断到本轮之前，上下文回到上一轮快照；无存活轮次时清空', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  const r1 = seedRound(conv, '第一问', '第一答', { labName: 'E310', date: '2026-09-28', task: 'schedule' });
  const r2 = seedRound(conv, '第二问', '第二答', { labName: 'E312', date: '2026-09-30', task: null });
  seedRound(conv, '第三问', '第三答', { labName: 'E310', date: null, task: null });

  const res = await request(`/api/conversations/${conv}/rollback`, { userMessageId: r2.userMessageId });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.mode, 'rollback');
  assert.equal(res.data.removedMessageIds.length, 4, '本轮及其后共 4 条消息');
  assert.deepEqual(db.getMessages(conv).map((m) => m.id), [r1.userMessageId, r1.assistantMessageId]);
  assert.deepEqual(res.data.context, { labName: 'E310', date: '2026-09-28', task: 'schedule' });
  assert.deepEqual(conversationContext(conv), res.data.context);
  assert.equal(db.getRun(r2.runId), null, '被截断轮次的 run 必须一并删除，否则会话被永久锁死');

  // 回档到第一轮 → 会话消息清空，上下文全部清空
  const second = await request(`/api/conversations/${conv}/rollback`, { userMessageId: r1.userMessageId });
  assert.equal(second.status, 200);
  assert.equal(db.getMessages(conv).length, 0);
  assert.deepEqual(conversationContext(conv), { labName: null, date: null, task: null });
});

test('R5 回档连带回退沙盒写入：对象撤回 + 独立台账 + 审计留痕 + 提案作废 + 任务取消', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  seedRound(conv, '报修 E310 投影', '已准备报修单', { labName: 'E310', date: '2026-09-28', task: 'issue' });
  const exec = seedExecutedIssue(conv, `投影无信号-${Date.now()}`);
  const r2 = seedRound(conv, '确认办理', '已提交', { labName: 'E310', date: '2026-09-28', task: 'issue' }, [toolCallWithProposal(exec)]);

  const res = await request(`/api/conversations/${conv}/rollback`, { userMessageId: r2.userMessageId, revertEffects: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.effects.reverted.length, 1, JSON.stringify(res.data.effects));
  assert.equal(res.data.effects.reverted[0].objectKind, 'issue');
  assert.equal(res.data.effects.reverted[0].objectId, exec.issueId);
  assert.equal(res.data.effects.supersededProposals.includes(exec.proposalId) || db.getOpsProposal(exec.proposalId)?.proposal.state === 'executed', true);

  const issue = (db.getDb().prepare('SELECT status FROM biz_issues WHERE id = ?').get(exec.issueId) as { status: string }).status;
  assert.equal(issue, 'reverted', '沙盒工单必须真的被撤回，而不是只写个"已回档"');
  const revert = db.listOpsReverts(conv);
  assert.equal(revert.length, 1);
  assert.equal(revert[0]!['operationId'], exec.operationId);
  assert.equal(revert[0]!['status'], 'reverted');
  const audit = db.getDb().prepare(`SELECT COUNT(*) AS n FROM ops_audit WHERE action = 'issue.revert' AND operationId = ?`).get(exec.operationId) as { n: number };
  assert.equal(Number(audit.n), 1, '回退也必须进审计');
});

test('R5 未勾选回退写入：会话照样回档，但如实列出"本轮执行过、未回退"的写入', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  const exec = seedExecutedIssue(conv, `未勾选-${Date.now()}`);
  const r1 = seedRound(conv, '确认办理', '已提交', { labName: null, date: null, task: 'issue' }, [toolCallWithProposal(exec)]);

  const res = await request(`/api/conversations/${conv}/rollback`, { userMessageId: r1.userMessageId });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.effects.reverted.length, 0);
  assert.equal(res.data.effects.notReverted.length, 1);
  assert.match(String(res.data.effects.notReverted[0].reason), /未回退/);
  const issue = (db.getDb().prepare('SELECT status FROM biz_issues WHERE id = ?').get(exec.issueId) as { status: string }).status;
  assert.equal(issue, 'open', '没勾选就不许偷偷改业务数据');
});

test('R5 重复回档同一操作不重复补偿（幂等），并如实说明', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  const exec = seedExecutedIssue(conv, `幂等-${Date.now()}`);
  const r1 = seedRound(conv, '确认办理', '已提交', { labName: null, date: null, task: 'issue' }, [toolCallWithProposal(exec)]);
  assert.equal((await request(`/api/conversations/${conv}/rollback`, { userMessageId: r1.userMessageId, revertEffects: true })).status, 200);

  // 同一提案在另一轮再次出现（历史里重复引用）→ 第二次回档必须识别"已回档"
  const r2 = seedRound(conv, '再来一次', '已提交', { labName: null, date: null, task: 'issue' }, [toolCallWithProposal(exec)]);
  const again = await request(`/api/conversations/${conv}/rollback`, { userMessageId: r2.userMessageId, revertEffects: true });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.effects.reverted.length, 0);
  assert.ok(again.data.effects.notes.some((n: string) => n.includes('此前已回档')), JSON.stringify(again.data.effects.notes));
  assert.equal(db.listOpsReverts(conv).length, 1, '台账不该出现重复行');
});

test('并发与边界：执行中的会话拒绝轮次操作；不存在的轮次 404；assistant 消息不能当轮次入口', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  const r1 = seedRound(conv, '第一问', '第一答', { labName: null, date: null, task: null });

  // 造一个"正在执行"的 run：轮次操作必须先被 409 挡住
  db.createMessageWithRun(conv, '第二问', `req-running-${Date.now()}`, 'run-running');
  const busyDelete = await request(`/api/conversations/${conv}/rounds/${r1.userMessageId}`, undefined, 'DELETE');
  assert.equal(busyDelete.status, 409);
  assert.equal(busyDelete.data.error, 'conversation_busy');
  const busyRollback = await request(`/api/conversations/${conv}/rollback`, { userMessageId: r1.userMessageId });
  assert.equal(busyRollback.status, 409);
  assert.equal(db.getMessages(conv).length, 4, '被拒绝时数据库必须毫无变化（第一轮 2 条 + 悬挂轮 2 条）');

  // 收尾：把悬挂 run 落终态，再验证 404 分支
  db.finalizeAssistantMessage(
    (db.getDb().prepare(`SELECT assistantMessageId AS id FROM runs WHERE id = 'run-running'`).get() as { id: string }).id,
    'run-running',
    'cancelled',
    '已取消',
    { conversationId: conv }
  );
  assert.equal((await request(`/api/conversations/${conv}/rounds/msg-not-exist`, undefined, 'DELETE')).status, 404);
  assert.equal((await request(`/api/conversations/${conv}/rounds/${r1.assistantMessageId}`, undefined, 'DELETE')).status, 404, 'assistant 消息不是轮次入口');
  assert.equal((await request(`/api/conversations/${conv}/rollback`, {})).status, 400, '缺少 userMessageId 必须 400');
  assert.equal((await request(`/api/conversations/conv-not-mine/rollback`, { userMessageId: r1.userMessageId })).status, 404);
});

test('聊天模式会话同样支持删除本轮与回档（服务端不做模式特判，界面才区分）', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'chat');
  const r1 = seedRound(conv, '随便聊聊', '聊完了', { labName: null, date: null, task: null });
  const r2 = seedRound(conv, '再聊一句', '好的', { labName: null, date: null, task: null });
  assert.equal((await request(`/api/conversations/${conv}/rollback`, { userMessageId: r2.userMessageId })).status, 200);
  assert.deepEqual(db.getMessages(conv).map((m) => m.id), [r1.userMessageId, r1.assistantMessageId]);
  assert.equal((await request(`/api/conversations/${conv}/rounds/${r1.userMessageId}`, undefined, 'DELETE')).status, 200);
  assert.equal(db.getMessages(conv).length, 0);
});

test('删除本轮会作废该轮待确认方案（防误确认），但不回退已执行写入', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  const exec = seedExecutedIssue(conv, `删除不回退-${Date.now()}`);
  const r1 = seedRound(conv, '确认办理', '已提交', { labName: null, date: null, task: 'issue' }, [toolCallWithProposal(exec)]);

  const res = await request(`/api/conversations/${conv}/rounds/${r1.userMessageId}`, undefined, 'DELETE');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.effects.reverted.length, 0);
  assert.ok(String(res.data.effects.notes[0]).includes('删除本轮'), '必须明确告诉用户删除≠回档');
  const issue = (db.getDb().prepare('SELECT status FROM biz_issues WHERE id = ?').get(exec.issueId) as { status: string }).status;
  assert.equal(issue, 'open');
});

test('共享聊天（主系统悬浮窗）不得操作任务会话轮次', async () => {
  const request = await demoClient();
  const conv = await newConversation(request, 'task');
  const r1 = seedRound(conv, '第一问', '第一答', { labName: null, date: null, task: null });
  // 共享聊天身份只存在于 native 委托上下文里，demo 的 HTTP 通道拿不到 ——
  // 因此直接调路由函数，在一个真实的 nativeDelegation 上下文内验证守卫。
  const { handleConversations } = await import('../server/api/conversations.ts');
  const { nativeDelegation } = await import('../server/security/context.ts');
  let status = 0;
  let body = '';
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: string) {
      if (chunk) body += String(chunk);
      this.writableEnded = true;
      return this;
    }
  } satisfies Record<string, unknown>;
  const asRes = res as unknown as import('node:http').ServerResponse;
  const pathname = `/api/conversations/${conv}/rounds/${r1.userMessageId}`;
  const req = { method: 'DELETE', url: pathname, headers: {} } as unknown as import('node:http').IncomingMessage;
  await nativeDelegation.run({ token: 't', profile: { username: 'u', identity: 'admin' }, sharedChat: true } as never, () =>
    handleConversations(req, asRes, pathname)
  );
  assert.equal(status, 403, body);
  assert.equal(db.getMessages(conv).length, 2, '被拒绝时不得删除任何消息');
  // 同一守卫也要挡住回档
  status = 0;
  body = '';
  const rollbackPath = `/api/conversations/${conv}/rollback`;
  const req2 = { method: 'POST', url: rollbackPath, headers: {} } as unknown as import('node:http').IncomingMessage;
  await nativeDelegation.run({ token: 't', profile: { username: 'u', identity: 'admin' }, sharedChat: true } as never, () =>
    handleConversations(req2, asRes, rollbackPath)
  );
  assert.equal(status, 403, body);
  assert.equal(db.getMessages(conv).length, 2);
});

test('提案状态新增 superseded 是既有契约的增量，不影响原有三态', () => {
  const states: Array<import('../shared/operations-contract.ts').ProposalState> = ['awaiting_confirmation', 'executed', 'rejected', 'expired', 'superseded'];
  assert.equal(new Set(states).size, 5);
  assert.equal(typeOps.TASK_STATUS_LABELS.cancelled, '已取消');
});

test('A8 模式可切换：非空会话 PATCH 立即生效；同模式幂等；改名照常；非法值仍被拒', async () => {
  const request = await demoClient();

  // 空会话可改（既有行为不变）
  const fresh = await newConversation(request, 'task');
  assert.equal((await request(`/api/conversations/${fresh}`, { mode: 'chat' }, 'PATCH')).status, 200);
  assert.equal((await request(`/api/conversations/${fresh}`)).data.mode, 'chat');

  // A8（2026-10-31 用户要求）：有对话的会话也能切换——模式随发送时刻生效，
  // 历史消息保持其发生时的语义；chat→task、task→chat 双向都允许。
  const chat = await newConversation(request, 'chat');
  seedRound(chat, '随便聊聊', '聊完了', { labName: null, date: null, task: null });
  const toWork = await request(`/api/conversations/${chat}`, { mode: 'task' }, 'PATCH');
  assert.equal(toWork.status, 200, JSON.stringify(toWork.data));
  assert.equal((await request(`/api/conversations/${chat}`)).data.mode, 'task', '切换必须真实生效');

  const work = await newConversation(request, 'task');
  seedRound(work, '第一问', '第一答', { labName: null, date: null, task: null });
  const toChat = await request(`/api/conversations/${work}`, { mode: 'chat' }, 'PATCH');
  assert.equal(toChat.status, 200, JSON.stringify(toChat.data));
  assert.equal((await request(`/api/conversations/${work}`)).data.mode, 'chat');

  // 同模式重复提交是幂等的
  assert.equal((await request(`/api/conversations/${work}`, { mode: 'chat' }, 'PATCH')).status, 200);
  // 改名与模式切换无关，必须照常可用
  const renamed = await request(`/api/conversations/${work}`, { title: '换个名字' }, 'PATCH');
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.title, '换个名字');

  // 非法模式值按既有 parseMode 白名单语义被忽略（不报错、不改动）
  const bad = await request(`/api/conversations/${work}`, { mode: 'admin' }, 'PATCH');
  assert.equal(bad.status, 200, JSON.stringify(bad.data));
  assert.equal(bad.data.mode, 'chat', '非法值不得改动当前模式');
});
