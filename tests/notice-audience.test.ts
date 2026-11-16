/**
 * 通知受众口径 —— 回归防护
 * ============================================================================
 *  问题形态：「帮我发一条通知：值班同学到5楼来」会失败：
 *    Agnes 3.0 Flash · 5815 ms · 失败
 *    失败原因：evidence_missing 你要求的操作没有完成：接收对象无效
 *             （工具 prepare_business_workflow｜错误码 bad_audience）
 *
 *  两侧词表不一致（代码可证）：
 *   · 沙盒工具 prepare_notification 的受众是 {kind:'class_ids'|'role_scope'|'all'}；
 *   · 原系统 /workflow/preview 的 validateAudience 只认 {kind:'all'|'role'|'class'|'user'}；
 *   · prepare_business_workflow 的 audience 在工具清单里**没有任何 schema**（{type:'object'}），
 *     两个工具同处一份清单 ⇒ 模型照沙盒词表写 ⇒ 原系统直接拒。
 *
 *  现在的做法：给工具补上精确 enum schema，并在服务端做**语义等价的词表翻译**；
 *  有歧义（多班级、给管理员群发、收件人不明）一律明确报错并列出可选形式 —— 收件人不能猜。
 *
 *  运行：node --test tests/notice-audience.test.ts
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-notice-audience-'));
process.env['LABOPS_DB_PATH'] = path.join(temp, 'agent.sqlite');

const STUB_URL = new URL('./fixtures/bridge-stub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    // 只替换 tools/business.ts 对网关的引用，其它模块仍用真实实现
    if (context.parentURL?.includes('/server/tools/business.ts') && specifier.endsWith('/business/bridge.ts')) {
      return next(STUB_URL, context);
    }
    return next(specifier, context);
  }
});

const { normalizeNoticeAudience, prepareWorkflow } = await import('../server/tools/business.ts');
const bridge = await import('./fixtures/bridge-stub.ts');
type Ctx = Parameters<typeof prepareWorkflow>[1];

const ctx = (): Ctx => ({ dataset: { sourceType: 'demo' } as never, now: { iso: new Date().toISOString(), date: '2026-10-06', time: '10:00:00', weekday: 2, weekdayLabel: '周二' }, mode: 'task', conversationId: 'conv-stub', actor: { id: 'stub-admin', role: 'admin', label: '管理' } }) as unknown as Ctx;

test.beforeEach(() => bridge.resetCalls());

// ---------------------------------------------------------------------------
//  词表归一：语义等价才翻译
// ---------------------------------------------------------------------------

test('沙盒词表 role_scope → 原系统 role（这是用户那次失败的直接原因）', () => {
  const r = normalizeNoticeAudience({ kind: 'role_scope', role: 'volunteer' });
  assert.deepEqual(r, { ok: true, audience: { kind: 'role', role: 'volunteer' } });
  assert.deepEqual(normalizeNoticeAudience({ kind: 'role_scope', role: 'student' }), { ok: true, audience: { kind: 'role', role: 'student' } });
});

test('沙盒词表 class_ids → 原系统 class（单班级无歧义才翻译）', () => {
  assert.deepEqual(normalizeNoticeAudience({ kind: 'class_ids', classIds: ['测试示例班'] }), { ok: true, audience: { kind: 'class', className: '测试示例班' } });
  const many = normalizeNoticeAudience({ kind: 'class_ids', classIds: ['A班', 'B班'] });
  assert.equal(many.ok, false);
  assert.match(many.ok ? '' : many.message, /一次只能给一个班级/);
  const empty = normalizeNoticeAudience({ kind: 'class_ids', classIds: [] });
  assert.equal(empty.ok, false);
});

test('原系统词表原样通过：all / role / class / user', () => {
  assert.deepEqual(normalizeNoticeAudience({ kind: 'all' }), { ok: true, audience: { kind: 'all' } });
  assert.deepEqual(normalizeNoticeAudience({ kind: 'role', role: 'student' }), { ok: true, audience: { kind: 'role', role: 'student' } });
  assert.deepEqual(normalizeNoticeAudience({ kind: 'class', className: '软件1班' }), { ok: true, audience: { kind: 'class', className: '软件1班' } });
  assert.deepEqual(normalizeNoticeAudience({ kind: 'user', userId: 'review-admin' }), { ok: true, audience: { kind: 'user', userId: 'review-admin' } });
  // username 是常见别名，等价翻译
  assert.deepEqual(normalizeNoticeAudience({ kind: 'user', username: 'review-admin' }), { ok: true, audience: { kind: 'user', userId: 'review-admin' } });
});

test('有歧义或越界一律报错，并且把可选形式说清楚（绝不猜收件人）', () => {
  for (const [input, expect] of [
    [{ kind: 'role', role: 'admin' }, /管理员/],
    [{ kind: 'role', role: '值班同学' }, /student 或 volunteer/],
    [{ kind: 'class' }, /className/],
    [{ kind: 'user' }, /userId/],
    [{ kind: 'everyone' }, /class_ids 与 role_scope/], // 提示模型：那是沙盒写法
    [{}, /接收对象/],
    [null, /缺少接收对象/]
  ] as Array<[unknown, RegExp]>) {
    const r = normalizeNoticeAudience(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.ok ? '' : r.message, expect, JSON.stringify(input));
    assert.match(r.ok ? '' : r.message, /发给谁|可选|只能/, '错误信息必须给出可执行的下一步');
  }
});

// ---------------------------------------------------------------------------
//  工具层：归一必须发生在**请求之前**
// ---------------------------------------------------------------------------

test('prepareWorkflow：发往原系统的是归一后的受众，而不是模型给的那套词表', async () => {
  bridge.setNextResponse({ plan: { id: 'plan-1', taskId: 'task-1', kind: 'notification.publish', sourceRevision: 'r1', payload: {}, version: 1, actorId: 'stub-admin', state: 'awaiting_confirmation', createdAt: '', expiresAt: '' } });
  const out = await prepareWorkflow(
    { kind: 'notification.publish', title: '值班提醒', content: '值班同学到5楼来', audience: { kind: 'role_scope', role: 'volunteer' } },
    ctx()
  );
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(bridge.calls.length, 1);
  const body = bridge.calls[0]!.body as Record<string, unknown>;
  assert.equal(bridge.calls[0]!.path, '/workflow/preview');
  assert.deepEqual(body['audience'], { kind: 'role', role: 'volunteer' }, '必须是原系统口径');
  assert.equal(body['conversationId'], 'conv-stub');
  assert.equal(body['title'], '值班提醒');
});

test('prepareWorkflow：受众无法确定时不发请求，并回可执行的 bad_audience', async () => {
  const out = await prepareWorkflow({ kind: 'notification.publish', title: 'x', content: 'y', audience: { kind: 'role_scope', role: '值班同学' } }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bad_audience', '错误码要稳定，run.ts 据此给模型"不要猜收件人"的指令');
  assert.match(out.message, /student 或 volunteer/);
  assert.equal(bridge.calls.length, 0, '口径不对就不该打扰原系统');
});

test('非通知类动作完全不受影响（不做无关改写）', async () => {
  bridge.setNextResponse({ plan: { id: 'plan-2', taskId: 'task-2', kind: 'issue.create', sourceRevision: 'r1', payload: {}, version: 1, actorId: 'stub-admin', state: 'awaiting_confirmation', createdAt: '', expiresAt: '' } });
  await prepareWorkflow({ kind: 'issue.create', roomId: 'E310', description: '投影无信号' }, ctx());
  const body = bridge.calls[0]!.body as Record<string, unknown>;
  assert.equal(body['kind'], 'issue.create');
  assert.equal(body['audience'], undefined, '工单不该被塞进 audience');
  assert.equal(body['description'], '投影无信号');
});
