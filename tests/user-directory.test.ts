/**
 * 批次3（整合执行方案 2026-11-09）——名册账号只读工具 + RAG 全量注入
 * 运行：node --test tests/user-directory.test.ts
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-b3-'));
process.env.LABOPS_DB_PATH = path.join(tmp, 'agent.sqlite');

const { executeTool } = await import('../server/tools/registry.ts');
const { renderDemoAnswer } = await import('../server/agent/demo-engine.ts');
const { runKnowledge, documents } = await import('../server/tools/knowledge.ts');
const { eligibleDocs } = await import('../server/tools/knowledge-search.ts');
const { requestIdentity, nativeDelegation } = await import('../server/security/context.ts');
const { serverNow } = await import('../server/time/term.ts');
const db = await import('../server/persistence/db.ts');
import type { SandboxActor } from '../shared/operations-contract.ts';

// bridge 的表是懒建的（生产由 HTTP 层启动触发）；测试直调工具，先补建与 bridge.tables() 同构的两表
db.getDb().exec(`CREATE TABLE IF NOT EXISTS business_connections(ownerId TEXT PRIMARY KEY, token TEXT NOT NULL, profile TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS business_generations(ownerId TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'disconnected');`);

const ACTOR: SandboxActor = { id: 'sandbox-admin', role: 'admin', label: '管理员' };
const DELEGATION = { token: 'b3-token', profile: { username: 'admin', identity: 'admin' as const, className: '', name: '管理员' } };
const NOW = serverNow();
const DATASET = { labs: [], openLabs: [], timetable: [], users: [], loadedAt: NOW.iso, warnings: [] } as never;

function withAuth<T>(fn: () => Promise<T>): Promise<T> {
  return requestIdentity.run(ACTOR, () => nativeDelegation.run(DELEGATION, fn));
}
function identityOnly<T>(fn: () => Promise<T>): Promise<T> {
  return requestIdentity.run(ACTOR, fn);
}

const DIRECTORY_JSON = {
  timezone: 'Asia/Shanghai', contractVersion: 3, total: 3,
  accounts: [
    { account: '2023****12', name: '张三', identity: 'student', status: 'active' },
    { account: 'vol***01', name: '李四', identity: 'volunteer', status: 'active' },
    { account: 'admin', name: '王五', identity: 'admin', status: 'password_change_required' }
  ],
  roster: [{ className: '计本2501', count: 42 }],
  meta: { masked: true, note: '账号为掩码值；名册仅按班级汇总人数；电话与学院信息不回传' }
};

let captured: { url: string; auth: string }[] = [];
const originalFetch = globalThis.fetch;
function mockFetch(handler: () => { status: number; json: unknown }) {
  captured = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    captured.push({ url: String(input), auth: String((init?.headers?.['authorization']) ?? (init?.headers?.['Authorization']) ?? '') });
    const r = handler();
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = originalFetch; }

after(() => {
  globalThis.fetch = originalFetch;
  db.getDb().close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ============================ query_user_directory ============================

test('名册工具：掩码账号原样透传，请求走 /user-directory 且带本人凭证', async () => {
  mockFetch(() => ({ status: 200, json: DIRECTORY_JSON }));
  try {
    const r = await withAuth(() => executeTool('query_user_directory', {}, { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'c-b3' } as never));
    assert.equal(r.ok, true, r.ok ? '' : (r as { message: string }).message);
    assert.equal(captured.length, 1);
    assert.match(captured[0]!.url, /\/api\/integration\/user-directory$/);
    assert.match(captured[0]!.auth, /Bearer b3-token/);
    const result = (r as { result: Record<string, unknown> }).result;
    assert.equal(result['directory'], true);
    const accounts = result['accounts'] as Array<Record<string, unknown>>;
    assert.equal(accounts.length, 3);
    assert.equal(accounts[0]!['account'], '2023****12', '掩码值原样，不还原不加工');
    assert.match((r as { summary: string }).summary, /3 个账号/);
    assert.match((r as { summary: string }).summary, /掩码/);
  } finally { restoreFetch(); }
});

test('名册工具：identity/status 过滤在服务端结果上做，不回传全量', async () => {
  mockFetch(() => ({ status: 200, json: DIRECTORY_JSON }));
  try {
    const r = await withAuth(() => executeTool('query_user_directory', { identity: 'volunteer' }, { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'c-b3' } as never));
    const accounts = ((r as { result: Record<string, unknown> }).result['accounts'] as Array<Record<string, unknown>>);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!['identity'], 'volunteer');
    assert.match((r as { summary: string }).summary, /身份 volunteer/);
  } finally { restoreFetch(); }
});

test('名册工具：学生 403 如实转述权限边界；未连接不编造', async () => {
  mockFetch(() => ({ status: 403, json: { error: 'forbidden', message: '名册与账号目录仅管理员或志愿者可查' } }));
  try {
    const r = await withAuth(() => executeTool('query_user_directory', {}, { dataset: DATASET, now: NOW, actor: { id: 'sandbox-student', role: 'student', label: '学生' }, conversationId: 'c-b3' } as never));
    assert.equal(r.ok, false);
  } finally { restoreFetch(); }
  const off = await identityOnly(() => executeTool('query_user_directory', {}, { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'c-b3' } as never));
  assert.equal(off.ok, false);
  assert.equal((off as { code: string }).code, 'business_unavailable');
  assert.match((off as { summary: string }).summary, /不作猜测/);
});

test('名册渲染：账号目录标题+身份/状态中文化+名册人数+掩码脚注', () => {
  const answer = renderDemoAnswer({ kind: 'records', payload: { directory: true, total: 3, accounts: DIRECTORY_JSON.accounts, roster: DIRECTORY_JSON.roster, meta: DIRECTORY_JSON.meta }, summary: 'x' } as never, { dateWasDefaulted: false, periodFiltered: false });
  assert.match(answer, /账号目录：共 3 个账号/);
  assert.match(answer, /身份：学生｜状态：正常/);
  assert.match(answer, /需修改密码/);
  assert.match(answer, /计本2501：42 人/);
  assert.match(answer, /电话与学院信息不回传/);
  assert.match(answer, /不还原/);
});

// ============================ RAG 全量注入 ============================

test('全量注入：默认返回当前角色可见的全部有效文档（带段落号），不再限前4', async () => {
  delete process.env.KNOWLEDGE_FULL_INJECT;
  const adminEligible = eligibleDocs(documents(), 'admin', NOW.date);
  const r = await runKnowledge({ query: '调课怎么办理' }, { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'c-b3', mode: 'task' } as never);
  assert.equal(r.ok, true);
  const hits = ((r as { result: { hits: unknown[] } }).result.hits as Array<Record<string, unknown>>);
  assert.equal(hits.length, adminEligible.length, '全量注入=角色可见的全部文档');
  assert.ok(hits.length > 4, `应超过旧检索上限 4，实际 ${hits.length}`);
  const first = hits[0]!;
  const paragraphs = first['paragraphs'] as Array<{ locator: string; text: string }>;
  assert.ok(paragraphs.length >= ((documents().find((d) => d.id === first['id'])?.paragraphs.length) ?? 0), '段落给全');
  assert.match(paragraphs[0]!.locator, /^§\d+$/, 'locator 为原文段落号');
  assert.match((r as { summary: string }).summary, /全量注入/);
});

test('全量注入：角色过滤仍权威——学生拿不到 admin-only 文档', async () => {
  const studentActor: SandboxActor = { id: 'sandbox-student', role: 'student', label: '学生' };
  const r = await runKnowledge({ query: '调课' }, { dataset: DATASET, now: NOW, actor: studentActor, conversationId: 'c-b3', mode: 'chat' } as never);
  const hits = ((r as { result: { hits: Array<{ id: string }> } }).result.hits as Array<{ id: string }>);
  const studentEligible = new Set(eligibleDocs(documents(), 'student', NOW.date).map((d) => d.id));
  for (const h of hits) assert.ok(studentEligible.has(h.id), `学生不得看到 ${h.id}`);
  assert.ok(!hits.some((h) => h.id === 'schedule-adjustment' && !studentEligible.has('schedule-adjustment')));
});

test('回退开关：KNOWLEDGE_FULL_INJECT=0 走三路检索（上限 4，summary 用检索口径）', async () => {
  process.env.KNOWLEDGE_FULL_INJECT = '0';
  try {
    const r = await runKnowledge({ query: '投影仪接入' }, { dataset: DATASET, now: NOW, actor: ACTOR, conversationId: 'c-b3', mode: 'task' } as never);
    const hits = ((r as { result: { hits: unknown[] } }).result.hits as unknown[]);
    assert.ok(hits.length <= 4, '检索路径保持 maxDocs=4 上限');
    if (hits.length) assert.match((r as { summary: string }).summary, /检索到/);
  } finally { delete process.env.KNOWLEDGE_FULL_INJECT; }
});

test('系统提示含引用纪律：全量注入下每条结论要带 [N] 文档·版本·§段落 脚注', async () => {
  const src = fs.readFileSync(path.resolve('server/agent/prompts.ts'), 'utf8');
  assert.ok(src.includes('全量注入模式'), '稳定前缀声明注入模式');
  assert.ok(/出处 \[N\] 文档标题·版本·§段落号/.test(src), '引用格式写入系统提示');
  assert.ok(src.includes('labops-1.0.7-multitool-v7'), 'PROMPT_VERSION 递增');
});
