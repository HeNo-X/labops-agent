/**
 * 批次4 批B（LabOps 侧）——钥匙借还走 workflow/plans 提案契约的透传与口径
 * 运行：node --test tests/key-transaction.test.ts
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-key-tx-'));
process.env.LABOPS_DB_PATH = path.join(tmp, 'agent.sqlite');

const { executeTool } = await import('../server/tools/registry.ts');
const db = await import('../server/persistence/db.ts');
const { requestIdentity, nativeDelegation } = await import('../server/security/context.ts');
const { serverNow } = await import('../server/time/term.ts');
import type { SandboxActor } from '../shared/operations-contract.ts';

db.getDb().exec(`CREATE TABLE IF NOT EXISTS business_connections(ownerId TEXT PRIMARY KEY, token TEXT NOT NULL, profile TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS business_generations(ownerId TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'disconnected');`);

const ACTOR: SandboxActor = { id: 'sandbox-admin', role: 'admin', label: '管理员' };
const DELEGATION = { token: 'kt-token', profile: { username: 'admin', identity: 'admin' as const, className: '', name: '管理员' } };
const NOW = serverNow();
const DATASET = { labs: [], openLabs: [], timetable: [], users: [], loadedAt: NOW.iso, warnings: [] } as never;
function withAuth<T>(fn: () => Promise<T>): Promise<T> {
  return requestIdentity.run(ACTOR, () => nativeDelegation.run(DELEGATION, fn));
}

let seen: { url: string; body: Record<string, unknown> }[] = [];
const originalFetch = globalThis.fetch;
function mockFetch(respond: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  seen = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    seen.push({ url: String(input), body });
    const r = respond(body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
after(() => {
  globalThis.fetch = originalFetch;
  db.getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('prepare_business_workflow key.lend：载荷透传到 workflow/preview，卡片视图=tasks、摘要说明台账未变', async () => {
  mockFetch(() => ({
    status: 200,
    json: {
      plan: { id: 'plan-kt-1', kind: 'key.lend', version: 1, state: 'awaiting_confirmation', expiresAt: new Date(Date.now() + 1800000).toISOString(), sourceRevision: 'rev-9', taskId: 'task-kt-1', payload: { keyId: 'key_E310', action: 'lend', holder: 'volunteer01', holderName: '李四', expectedHolder: '', note: '下午巡检' } },
      task: { id: 'task-kt-1', kind: 'key.lend', status: 'awaiting_confirmation', ownerRole: 'admin' }
    }
  }));
  try {
    const r = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'key.lend', keyId: 'key_E310', holderUsername: 'volunteer01', note: '下午巡检' }, { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'conv-kt', mode: 'task' } as never));
    assert.equal(r.ok, true, r.ok ? '' : (r as { message: string }).message);
    assert.equal(seen[0]!.url.includes('/api/integration/workflow/preview'), true);
    assert.equal(seen[0]!.body['kind'], 'key.lend');
    assert.equal(seen[0]!.body['keyId'], 'key_E310');
    const result = (r as { result: Record<string, unknown> }).result;
    assert.equal(result['view'], 'tasks', '钥匙借还挂中性任务视图；health 面板会把方案误绑成"受控修正方案"卡（实机发现）');
    assert.match(String(result['summary']), /台账尚未变化/);
    assert.equal((result['plan'] as { kind: string }).kind, 'key.lend');
  } finally { globalThis.fetch = originalFetch; }
});

test('key.return 主系统拒绝（志愿者还他人钥匙 403）如实转述，不假装方案就绪', async () => {
  mockFetch(() => ({ status: 403, json: { error: 'forbidden', message: '志愿者只能归还本人借出的钥匙；异常归还需管理员在后台办理' } }));
  try {
    const r = await withAuth(() => executeTool('prepare_business_workflow', { kind: 'key.return', keyId: 'key_E312' }, { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'conv-kt2', mode: 'task' } as never));
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /本人借出/);
  } finally { globalThis.fetch = originalFetch; }
});

test('spec 枚举含 key.lend/key.return 且 keyId 参数有说明（模型侧词表与主系统一致）', async () => {
  const { toolsForMode } = await import('../server/tools/registry.ts');
  const spec = toolsForMode('task').find((t) => t.name === 'prepare_business_workflow')!;
  const kinds = (spec.parameters as { properties: { kind: { enum: string[] } } }).properties.kind.enum;
  assert.ok(kinds.includes('key.lend') && kinds.includes('key.return'));
  const props = (spec.parameters as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props['keyId']!.description ?? '', /query_key_records/);
});
