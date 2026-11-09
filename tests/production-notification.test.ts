/**
 * 批次2（整合方案 §8.5）——通知发布真实写回主系统 + 回执如实区分 + 生产通知不假回退
 * 运行：node --test tests/production-notification.test.ts
 */
process.env.LABOPS_SKIP_ENV_FILE = '1';
process.env.LABOPS_AUTH_MODE = 'demo';
process.env.LABOPS_BUSINESS_URL = 'http://127.0.0.1:59999';
for (const k of Object.keys(process.env)) if (/API_KEY|API_SECRET/.test(k)) delete process.env[k];

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-prod-ntf-'));
process.env.LABOPS_DB_PATH = path.join(tmp, 'agent.sqlite');

const { executeTool } = await import('../server/tools/registry.ts');
const db = await import('../server/persistence/db.ts');
const { resolveActor } = await import('../server/operations/identity.ts');
const { pushNotificationToMainSystem } = await import('../server/operations/production.ts');
const { handleTasksApi } = await import('../server/api/tasks.ts');
const { requestIdentity, nativeDelegation } = await import('../server/security/context.ts');
const { collectRoundRefs, revertRoundEffects } = await import('../server/operations/revert.ts');
import type { Dataset } from '../server/data/store.ts';
import type { ServerNow } from '../server/time/term.ts';

const ADMIN = resolveActor('admin');
const DELEGATION = { token: 'test-token', profile: { username: 'admin', identity: 'admin' as const, className: '', name: '管理员' } };
function withAuth<T>(fn: () => Promise<T>): Promise<T> {
  return requestIdentity.run(ADMIN, () => nativeDelegation.run(DELEGATION, fn));
}
function identityOnly<T>(fn: () => Promise<T>): Promise<T> {
  return requestIdentity.run(ADMIN, fn);
}

interface Captured { url: string; body: Record<string, unknown>; auth: string }
let calls: Captured[] = [];
const originalFetch = globalThis.fetch;
function mockFetch(respond: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: String(input), body, auth: String(init?.headers?.['authorization'] ?? init?.headers?.['Authorization'] ?? '') });
    const r = respond(body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const NOW = { iso: '2026-11-09T12:00:00+08:00', date: '2026-11-09', time: '12:00:00', weekday: 1, weekdayLabel: '周一' } as ServerNow;
const DATASET = {
  sourceType: 'snapshot', sourceLabel: '测试快照', meta: { sourceSha256Prefix: 'x', snapshotAt: NOW.iso },
  term: { term: 'T1', termStart: '2026-09-07', holidays: [] },
  labs: [{ id: 'lab_1', sortOrder: 1, name: 'E310', location: '文渊E区', capacity: 40, status: 'active', description: '' }],
  openLabs: [],
  timetable: [{ id: 'tt_1', weekday: 1, term: 'T1', labName: 'E310', periodKey: 'am1', className: '软件1班', classNames: ['软件1班'], courseName: 'C', teacher: 'T', startTime: '08:00', endTime: '10:00', weeks: { from: 1, to: 18 } }],
  loadedAt: NOW.iso, warnings: []
} as unknown as Dataset;

async function prepareNotice(): Promise<{ proposalId: string; version: number; taskId: string }> {
  const r = await executeTool('prepare_notification', {
    title: '今晚设备巡检', content: '请志愿者 18:00 到 E310 集合。', level: 'info',
    audience: { kind: 'role_scope', role: 'student' }
  }, { dataset: DATASET, now: NOW, actor: ADMIN, conversationId: 'conv-prod' } as never);
  assert.equal(r.ok, true, r.ok ? '' : (r as { message: string }).message);
  return (r as { result: { proposalId: string; version: number; taskId: string } }).result;
}

function fakeDecision(taskId: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const req = new Readable({ read() {} }) as unknown as import('node:http').IncomingMessage;
  Object.assign(req, { method: 'POST', url: `/api/tasks/${taskId}/decisions`, headers: { 'content-type': 'application/json' } });
  process.nextTick(() => { (req as unknown as Readable).push(raw); (req as unknown as Readable).push(null); });
  const out: { status: number; body: string } = { status: 0, body: '' };
  const res = {
    writeHead(status: number) { out.status = status; return this; },
    end(text?: string) { out.body = text ?? ''; },
    setHeader() {}
  } as unknown as import('node:http').ServerResponse;
  return { req, res, out };
}

after(() => {
  globalThis.fetch = originalFetch;
  db.getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
//  推送单元
// ---------------------------------------------------------------------------
test('已连接+受众可映射：推 /notifications，requestId=operationId，回执 production/sent', async () => {
  calls = [];
  mockFetch(() => ({ status: 200, json: { notification: { id: 'notice-77' } } }));
  try {
    const push = await withAuth(() => pushNotificationToMainSystem(
      { title: 'T', content: 'C', audience: { kind: 'role_scope', role: 'student' } }, 'op-unit-1'));
    assert.equal(push.environment, 'production');
    assert.equal(push.deliveryStatus, 'sent');
    assert.match(push.note, /notice-77/);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/integration\/notifications$/);
    assert.equal(calls[0]!.body['requestId'], 'op-unit-1');
    assert.deepEqual(calls[0]!.body['audience'], { kind: 'role', role: 'student' }, '沙盒词表必须翻译成主系统词表');
    assert.match(calls[0]!.auth, /Bearer test-token/, '以登录者本人凭证发布');
  } finally { globalThis.fetch = originalFetch; }
});

test('未连接主系统：不出网，回执如实标仅沙盒记录', async () => {
  calls = [];
  mockFetch(() => ({ status: 200, json: {} }));
  try {
    const push = await identityOnly(() => pushNotificationToMainSystem({ title: 'T', content: 'C', audience: { kind: 'all' } }, 'op-unit-2'));
    assert.equal(push.environment, 'sandbox');
    assert.match(push.note, /未连接主系统/);
    assert.equal(calls.length, 0, '未连接绝不能假装推送');
  } finally { globalThis.fetch = originalFetch; }
});

test('受众映射不了（多班级）：不推送，note 给重发起指引', async () => {
  calls = [];
  mockFetch(() => ({ status: 200, json: {} }));
  try {
    const push = await withAuth(() => pushNotificationToMainSystem(
      { title: 'T', content: 'C', audience: { kind: 'class_ids', classIds: ['软件1班', '软件2班'] } }, 'op-unit-3'));
    assert.equal(push.environment, 'sandbox');
    assert.match(push.note, /受众无法映射/);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('主系统写入失败：保持 sandbox 并写明原因，绝不冒充已发送', async () => {
  calls = [];
  mockFetch(() => ({ status: 500, json: { error: 'boom', message: '存储不可用' } }));
  try {
    const push = await withAuth(() => pushNotificationToMainSystem({ title: 'T', content: 'C', audience: { kind: 'all' } }, 'op-unit-4'));
    assert.equal(push.environment, 'sandbox');
    assert.match(push.note, /主系统写入失败/);
    assert.equal(push.deliveryStatus, 'pending');
  } finally { globalThis.fetch = originalFetch; }
});

// ---------------------------------------------------------------------------
//  决策端点编排（confirm 后推送 + 回执落库改写 + 重放不重推）
//  真实场景建模：提案在未连接时准备（沙盒工具在已连接时被门控禁用，见门控用例），
//  连接主系统后本人确认 → 此时才走生产写回。
// ---------------------------------------------------------------------------
test('已连接时沙盒 prepare_notification 被门控拒绝——原生写链是 workflow/plans，不双入口', async () => {
  calls = [];
  const r = await withAuth(() => executeTool('prepare_notification', {
    title: 'x', content: 'y', level: 'info', audience: { kind: 'all' }
  }, { dataset: DATASET, now: NOW, actor: ADMIN, conversationId: 'conv-prod-gate' } as never));
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'scope_forbidden');
});
test('端点确认：回执改写为 production 并持久化；同 clientRequestId 重放不再推送', async () => {
  calls = [];
  mockFetch(() => ({ status: 200, json: { notification: { id: 'notice-88' } } }));
  try {
    const p = await identityOnly(() => prepareNotice());
    const body = { proposalId: p.proposalId, proposalVersion: p.version, decision: 'confirm', clientRequestId: 'req-prod-1' };
    const first = fakeDecision(p.taskId, body);
    const handled = await withAuth(() => handleTasksApi(first.req, first.res, `/api/tasks/${p.taskId}/decisions`));
    assert.equal(handled, true);
    assert.equal(first.out.status, 200, first.out.body);
    const outcome = JSON.parse(first.out.body) as { ok: boolean; receipt: { executionEnvironment: string; deliveryStatus: string; deliveryNote: string; operationId: string } };
    assert.equal(outcome.receipt.executionEnvironment, 'production', '回执必须如实标主系统');
    assert.equal(outcome.receipt.deliveryStatus, 'sent');
    assert.match(outcome.receipt.deliveryNote, /notice-88/);
    const stored = db.getOpsOperation(outcome.receipt.operationId)!;
    assert.equal(stored.executionEnvironment, 'production', '库内回执同步改写');
    assert.equal(calls.length, 1);

    const second = fakeDecision(p.taskId, body);
    await withAuth(() => handleTasksApi(second.req, second.res, `/api/tasks/${p.taskId}/decisions`));
    assert.equal(second.out.status, 200);
    assert.equal(calls.length, 1, '幂等重放绝不二次推送');
  } finally { globalThis.fetch = originalFetch; }
});

test('端点未连接：确认成功但回执保持 sandbox+未连接注记', async () => {
  calls = [];
  mockFetch(() => ({ status: 200, json: { notification: { id: 'x' } } }));
  try {
    const p = await identityOnly(() => prepareNotice());
    const ex = fakeDecision(p.taskId, { proposalId: p.proposalId, proposalVersion: p.version, decision: 'confirm', clientRequestId: 'req-prod-2' });
    await identityOnly(() => handleTasksApi(ex.req, ex.res, `/api/tasks/${p.taskId}/decisions`));
    const outcome = JSON.parse(ex.out.body) as { ok: boolean; receipt: { executionEnvironment: string; deliveryNote: string } };
    assert.equal(outcome.ok, true);
    assert.equal(outcome.receipt.executionEnvironment, 'sandbox');
    assert.match(outcome.receipt.deliveryNote, /未连接主系统/);
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('生产通知不做假回退：revert 报"到主系统处理"，沙盒台账保留', async () => {
  calls = [];
  mockFetch(() => ({ status: 200, json: { notification: { id: 'notice-99' } } }));
  try {
    const p = await identityOnly(() => prepareNotice());
    const ex = fakeDecision(p.taskId, { proposalId: p.proposalId, proposalVersion: p.version, decision: 'confirm', clientRequestId: 'req-prod-3' });
    await withAuth(() => handleTasksApi(ex.req, ex.res, `/api/tasks/${p.taskId}/decisions`));
    const outcome = JSON.parse(ex.out.body) as { receipt: { operationId: string } };
    const messages = [{
      id: 'msg-prod-1', conversationId: 'conv-prod', role: 'assistant' as const, text: '', status: 'completed' as const,
      meta: { toolCalls: [{ resultKind: 'operation_proposal', result: { proposalId: p.proposalId } }] },
      clientRequestId: null, ordinal: 0, createdAt: new Date().toISOString()
    }];
    const refs = collectRoundRefs(messages as never);
    const report = await revertRoundEffects({ conversationId: 'conv-prod', userMessageId: 'msg-prod-1', actorId: ADMIN.id, refs, includeExecuted: true });
    assert.equal(report.reverted.length, 0, '生产通知不得被标成已自动回退');
    assert.ok(report.notReverted.some((r) => r.operationId === outcome.receipt.operationId && /主系统处理/.test(r.reason)), '必须报人工处理路径');
    const kept = db.getDb().prepare("SELECT 1 FROM biz_notifications LIMIT 1").get();
    assert.ok(kept, '沙盒台账保留以供审计');
  } finally { globalThis.fetch = originalFetch; }
});
