/**
 * 批W1（LabOps 侧）——名册班级归属变更 roster.update 的工具词表、透传与真主系统契约
 * 运行：node --test tests/roster-update.test.ts
 *
 * 两层：
 *   A 词表/透传：mock 上游，钉住 view=roster、摘要口径、缺目标就地报错、上游拒绝如实转述；
 *   B 真契约：mock 的 fetch 直接转发到 Pages/server/operations.js 的 dispatch（带假 credentials 通道），
 *     用 query_user_directory 拿掩码账号与令牌 → prepare → 本人确认 commit，验三处真写与学号不外泄。
 * 全部为隔离虚构样例，不读写 Pages/data，不触真实学生信息。
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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dispatch } = require('../../Pages/server/operations.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-roster-'));
process.env.LABOPS_DB_PATH = path.join(tmp, 'agent.sqlite');

const { executeTool, toolsForMode } = await import('../server/tools/registry.ts');
const db = await import('../server/persistence/db.ts');
const { requestIdentity, nativeDelegation } = await import('../server/security/context.ts');
const { serverNow } = await import('../server/time/term.ts');
import type { SandboxActor } from '../shared/operations-contract.ts';
import type { NativeDelegation } from '../server/security/context.ts';

db.getDb().exec(`CREATE TABLE IF NOT EXISTS business_connections(ownerId TEXT PRIMARY KEY, token TEXT NOT NULL, profile TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS business_generations(ownerId TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'disconnected');`);

const ACTOR: SandboxActor = { id: 'sandbox-admin', role: 'admin', label: '管理员' };
const adminProfile = { username: 'fixture-admin', identity: 'admin' as const, className: '', name: '管理员' };
const volProfile = { username: 'fixture-vol', identity: 'volunteer' as const, className: '', name: '志愿者' };
const NOW = serverNow();
const DATASET = { labs: [], openLabs: [], timetable: [], users: [], loadedAt: NOW.iso, warnings: [] } as never;
const CTX = { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'conv-roster', mode: 'task' } as never;
function withAuth<T>(fn: () => Promise<T>, profile: NativeDelegation['profile'] = adminProfile): Promise<T> {
  return requestIdentity.run(ACTOR, () => nativeDelegation.run({ token: 'roster-token', profile }, fn));
}
function accountsOf(r: unknown): Array<Record<string, unknown>> {
  return (r as { result: { accounts: Array<Record<string, unknown>> } }).result.accounts;
}
function planOf(r: unknown): { id: string; version: number; payload: Record<string, unknown> } {
  return (r as { result: { plan: { id: string; version: number; payload: Record<string, unknown> } } }).result.plan;
}

const SNO = '202601010101';
const SNO2 = '202601010102';
const MASKED = '2026****01';
const ADMIN = { username: 'fixture-admin', identity: 'admin' };
const VOL = { username: 'fixture-vol', identity: 'volunteer' };

let seen: Array<{ url: string; method: string; route: string; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
function mockFetch(respond: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  seen = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    seen.push({ url, method: String(init?.method ?? 'GET'), route: url.replace(/^.*\/api\/integration/, '').split('?')[0]!, body });
    const r = respond(body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
function planResponse(payload: Record<string, unknown>) {
  return {
    status: 200,
    json: {
      plan: { id: 'plan-roster-1', kind: 'roster.update', version: 1, state: 'awaiting_confirmation', expiresAt: new Date(Date.now() + 1800000).toISOString(), sourceRevision: 'rev-1', taskId: 'task-roster-1', payload },
      task: { id: 'task-roster-1', kind: 'roster.update', status: 'awaiting_confirmation', ownerRole: 'admin' }
    }
  };
}

// —— B 层：真 dispatch + 假 credentials 通道 ——
function liveHarness(actor: { username: string; identity: string }) {
  const h: { state: Record<string, any>; creds: Record<string, any> } = {
    creds: {
      'fixture-admin': { identity: 'admin', status: 'active', name: '管理员' },
      'fixture-vol': { identity: 'volunteer', status: 'active', name: '志愿者' },
      [SNO]: { identity: 'student', status: 'active', name: '样例甲', className: '样例一班' },
      [SNO2]: { identity: 'student', status: 'active', name: '样例甲', className: '样例二班' }
    },
    state: {
      sysConfig: { term: 'fixture', termStart: '2026-09-07', termEnd: '2027-01-31', holidays: [], specialDays: [] },
      classes: [{ id: 'c1', name: '样例一班', size: 1 }, { id: 'c2', name: '样例二班', size: 1 }, { id: 'c3', name: '样例三班', size: 0 }],
      classRoster: [{ className: '样例一班', sno: SNO, name: '样例甲' }],
      users: [
        { username: 'fixture-admin', name: '管理员', identity: 'admin', className: '' },
        { username: 'fixture-vol', name: '志愿者', identity: 'volunteer', className: '' },
        { username: SNO, name: '样例甲', identity: 'student', className: '样例一班' },
        { username: SNO2, name: '样例甲', identity: 'student', className: '样例二班' }
      ],
      labs: [], openLabs: [], timetable: [], scheduleAdjust: [], roomClosures: [], keys: [], notifications: [],
      checkinRecords: [], opsPlans: [], opsLedger: [], opsTasks: []
    }
  };
  const principals = () => Object.entries(h.creds).map(([username, c]) => ({
    username, identity: c.identity, status: c.status, mustChangePassword: c.mustChangePassword, name: c.name || '',
    className: c.className || ((h.state.classRoster || []).find((r: any) => r.sno === username) || {}).className || ''
  }));
  const roster = { read: () => structuredClone(h.creds), write: (c: Record<string, any>) => { h.creds = c; } };
  const call = (method: string, route: string, body?: unknown) => dispatch({
    method, path: route, body: body ?? {}, actor, state: h.state, now: new Date(NOW.iso),
    commit: (next: Record<string, any>) => { h.state = next; }, principals: principals(), roster
  });
  function mock() {
    seen = [];
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const route = url.replace(/^.*\/api\/integration/, '').split('?')[0]!;
      const method = String(init?.method ?? 'GET');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      seen.push({ url, method, route, body });
      try {
        return new Response(JSON.stringify(call(method, route, body)), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        const err = e as { code?: string; status?: number; message?: string };
        return new Response(JSON.stringify({ error: err.code || 'commit_failed', message: err.message }), { status: err.status || 500, headers: { 'content-type': 'application/json' } });
      }
    }) as typeof fetch;
  }
  return { h, call, mock };
}

after(() => {
  globalThis.fetch = originalFetch;
  db.getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ===================== A 层：词表与透传 =====================

test('A1 spec 枚举含 roster.update，四个定位/令牌参数都有说明，且明写不得还原学号', async () => {
  const spec = toolsForMode('task').find((t) => t.name === 'prepare_business_workflow')!;
  const props = (spec.parameters as { properties: Record<string, { description?: string; enum?: string[] }> }).properties;
  assert.ok(props['kind']!.enum!.includes('roster.update'));
  for (const k of ['targetName', 'targetAccount', 'className', 'expectedRosterVersion']) assert.ok(props[k]?.description, k + ' 缺说明');
  assert.match(props['targetAccount']!.description!, /掩码/);
  assert.match(spec.description, /不得推测或还原真实学号/);
  assert.match(spec.description, /仅管理员/);
});

test('A2 载荷透传到 workflow/preview，卡片视图=roster，摘要说明名册尚未变化', async () => {
  const payload = { targetName: '样例甲', accountMasked: MASKED, beforeClassName: '样例一班', afterClassName: '样例三班', rosterRowPresent: true, expectedRosterVersion: 'tok-1', reason: '学籍调整' };
  mockFetch(() => planResponse(payload));
  try {
    const r = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', targetAccount: MASKED, className: '样例三班', expectedRosterVersion: 'tok-1', reason: '学籍调整' }, CTX));
    assert.equal(r.ok, true, r.ok ? '' : (r as { message: string }).message);
    assert.equal(seen[0]!.route, '/workflow/preview');
    assert.equal(seen[0]!.body['kind'], 'roster.update');
    assert.equal(seen[0]!.body['targetAccount'], MASKED);
    assert.equal(seen[0]!.body['expectedRosterVersion'], 'tok-1');
    const result = (r as { result: Record<string, unknown> }).result;
    assert.equal(result['view'], 'roster', '名册卡不能落到 notifications/health，否则确认区与预览块都不渲染');
    assert.match(String(result['summary']), /尚未变化/);
    assert.equal((result['plan'] as { kind: string }).kind, 'roster.update');
  } finally { globalThis.fetch = originalFetch; }
});

test('A3 没给目标学生就地报错，不发请求（不让模型去猜学号）', async () => {
  mockFetch(() => planResponse({}));
  try {
    const r = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', className: '样例三班', expectedRosterVersion: 'tok-1', reason: 'x' }, CTX));
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, 'bad_input');
    assert.equal(seen.length, 0, '缺目标不应打上游');
    assert.match((r as { message: string }).message, /targetAccount/);
  } finally { globalThis.fetch = originalFetch; }
});

test('A4 上游拒绝（志愿者 403 / 令牌过期 409）如实转述，不假装方案就绪', async () => {
  for (const [status, json, re] of [
    [403, { error: 'forbidden', message: '仅管理员可操作' }, /管理员/],
    [409, { error: 'roster_changed', message: '该账号的班级或状态已变化，请重新查询账号目录后再准备' }, /已变化/]
  ] as Array<[number, Record<string, unknown>, RegExp]>) {
    mockFetch(() => ({ status, json }));
    try {
      const r = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', targetAccount: MASKED, className: '样例三班', expectedRosterVersion: 'tok-1', reason: 'x' }, CTX));
      assert.equal(r.ok, false);
      assert.match((r as { message: string }).message, re);
    } finally { globalThis.fetch = originalFetch; }
  }
});

test('A5 query_user_directory 把 className 与 rosterVersion 原样带给模型（改班级要用）', async () => {
  mockFetch(() => ({
    status: 200,
    json: { accounts: [{ account: MASKED, name: '样例甲', identity: 'student', status: 'active', className: '样例一班', rosterVersion: 'a'.repeat(64) }], roster: [{ className: '样例一班', count: 1 }], meta: { masked: true } }
  }));
  try {
    const r = await withAuth(() => executeTool('query_user_directory', {}, CTX));
    assert.equal(r.ok, true);
    const accounts = accountsOf(r);
    assert.equal(accounts[0]!['className'], '样例一班');
    assert.equal(accounts[0]!['rosterVersion'], 'a'.repeat(64));
    assert.equal(seen[0]!.route, '/user-directory');
  } finally { globalThis.fetch = originalFetch; }
});

// ===================== B 层：真主系统契约 =====================

test('B1 目录取令牌 → 准备 → 本人确认：credentials/名册行/users 三处真写，回执带前后值', async () => {
  const live = liveHarness(ADMIN);
  live.mock();
  try {
    const dir = await withAuth(() => executeTool('query_user_directory', { identity: 'student' }, CTX));
    assert.equal(dir.ok, true, dir.ok ? '' : (dir as { message: string }).message);
    const accounts = accountsOf(dir);
    const me = accounts.find((a) => a['account'] === MASKED)!;
    assert.equal(me['className'], '样例一班');
    const token = String(me['rosterVersion']);
    assert.match(token, /^[0-9a-f]{64}$/);

    const prep = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', targetAccount: MASKED, className: '样例三班', expectedRosterVersion: token, reason: '学籍调整（隔离样例）' }, CTX));
    assert.equal(prep.ok, true, prep.ok ? '' : (prep as { message: string }).message);
    const plan = planOf(prep);
    assert.equal(plan.payload['beforeClassName'], '样例一班');
    assert.equal(plan.payload['afterClassName'], '样例三班');
    assert.equal(plan.payload['rosterRowPresent'], true);
    assert.ok(!JSON.stringify(prep).includes(SNO), '学号原值不得进入模型可见结果');
    assert.equal(live.h.creds[SNO].className, '样例一班', '未确认前不得改凭据');

    // 本人点击确认（前端走 proxy/plans/commit，这里直接打同一入口）
    const receipt = live.call('POST', '/plans/commit', { planId: plan.id, version: plan.version }).receipt;
    assert.equal(receipt.kind, 'roster.update');
    assert.equal(live.h.creds[SNO].className, '样例三班', 'credentials 是权威，必须真写');
    assert.equal(live.h.state.classRoster.find((r: any) => r.sno === SNO).className, '样例三班');
    assert.equal(live.h.state.users.find((u: any) => u.username === SNO).className, '样例三班');
    assert.equal(receipt.changes[0].before, '样例一班');
    assert.equal(receipt.changes[0].after, '样例三班');
    assert.equal(receipt.changes[0].rosterRowUpdated, true);
    assert.equal(receipt.actorId, 'fixture-admin');
    assert.ok(!JSON.stringify(receipt).includes(SNO), '回执也不得带学号原值');
    assert.equal(live.h.state.opsLedger.length, 1);
    // 幂等：同方案再确认一次不产第二条
    const again = live.call('POST', '/plans/commit', { planId: plan.id, version: plan.version });
    assert.equal(again.replayed, true);
    assert.equal(live.h.state.opsLedger.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('B2 重名只给姓名 → 主系统 target_ambiguous，工具如实转述并列掩码候选', async () => {
  const live = liveHarness(ADMIN);
  live.mock();
  try {
    const dir = await withAuth(() => executeTool('query_user_directory', {}, CTX));
    const accounts = accountsOf(dir);
    const token = String(accounts.find((a) => a['account'] === MASKED)!['rosterVersion']);
    const r = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', targetName: '样例甲', className: '样例三班', expectedRosterVersion: token, reason: 'x' }, CTX));
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, 'target_ambiguous');
    assert.match((r as { message: string }).message, /2026\*\*\*\*01/);
    assert.ok(!(r as { message: string }).message.includes(SNO));
    assert.equal(live.h.state.opsPlans.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('B3 志愿者身份准备名册变更 → 真主系统 403，凭据零改动', async () => {
  const live = liveHarness(VOL);
  live.mock();
  try {
    const dir = await withAuth(() => executeTool('query_user_directory', {}, CTX), volProfile);
    assert.equal(dir.ok, true, '志愿者仍可只读目录');
    const accounts = accountsOf(dir);
    const token = String(accounts.find((a) => a['account'] === MASKED)!['rosterVersion']);
    const r = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', targetAccount: MASKED, className: '样例三班', expectedRosterVersion: token, reason: 'x' }, CTX), volProfile);
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, 'forbidden');
    assert.equal(live.h.creds[SNO].className, '样例一班');
  } finally { globalThis.fetch = originalFetch; }
});

test('B4 令牌过期（预览后他处改了班级）→ 确认被拒，方案不落地', async () => {
  const live = liveHarness(ADMIN);
  live.mock();
  try {
    const dir = await withAuth(() => executeTool('query_user_directory', {}, CTX));
    const accounts = accountsOf(dir);
    const token = String(accounts.find((a) => a['account'] === MASKED)!['rosterVersion']);
    const prep = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', targetAccount: MASKED, className: '样例三班', expectedRosterVersion: token, reason: 'x' }, CTX));
    assert.equal(prep.ok, true);
    const plan = planOf(prep);
    live.h.creds[SNO].className = '样例二班';   // 另一处（后台页面）先改了
    assert.throws(() => live.call('POST', '/plans/commit', { planId: plan.id, version: plan.version }), (e: { code?: string }) => e.code === 'roster_changed');
    assert.equal(live.h.creds[SNO].className, '样例二班');
    assert.equal(live.h.state.opsLedger.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('B5 名册对正表无该学号行：不新建行，回执注记，班级人数统计不变', async () => {
  const live = liveHarness(ADMIN);
  live.mock();
  try {
    const dir = await withAuth(() => executeTool('query_user_directory', {}, CTX));
    const accounts = accountsOf(dir);
    const other = accounts.find((a) => a['account'] === '2026****02')!;
    const rowsBefore = live.h.state.classRoster.length;
    const prep = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'roster.update', targetAccount: '2026****02', className: '样例三班', expectedRosterVersion: String(other['rosterVersion']), reason: '学籍调整（隔离样例）' }, CTX));
    assert.equal(prep.ok, true, prep.ok ? '' : (prep as { message: string }).message);
    const plan = planOf(prep);
    assert.equal(plan.payload['rosterRowPresent'], false);
    const receipt = live.call('POST', '/plans/commit', { planId: plan.id, version: plan.version }).receipt;
    assert.equal(live.h.state.classRoster.length, rowsBefore, '不得凭空新建名册行');
    assert.equal(receipt.changes[0].rosterRowUpdated, false);
    assert.equal(live.h.creds[SNO2].className, '样例三班');
  } finally { globalThis.fetch = originalFetch; }
});