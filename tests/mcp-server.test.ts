/**
 * MCP server 验收（WS1.4）
 * ============================================================================
 *  重点不是"能不能列工具"，而是**暴露出去之后权限边界还在不在**：
 *   · 草稿/写入类工具必须完全不出现在 tools/list，且直接调用也被拒；
 *   · 角色由服务端环境变量决定，客户端在 arguments 里传 role 必须无效；
 *   · 默认最小权限 —— 学生身份检索不到管理员专属制度，这是"没漏"的证据，
 *     而不是"坏了"的证据。
 *
 *  运行：node --test tests/mcp-server.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDb = path.join(root, '.mcp-test.sqlite');

after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(testDb + suffix, { force: true });
    } catch {
      /* Windows 下子进程可能仍持有句柄，泄漏一个测试库不影响结论 */
    }
  }
});

interface Rpc {
  id: number;
  result?: { tools?: Array<{ name: string; inputSchema?: unknown; annotations?: Record<string, boolean> }>; serverInfo?: { name: string }; isError?: boolean; content?: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

/** 起一个 MCP 子进程，按行喂 JSON-RPC，收齐 id 对应的应答 */
function talk(messages: unknown[], env: Record<string, string> = {}): Promise<Map<number, Rpc>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/mcp-server.ts'], {
      cwd: root,
      env: { ...process.env, LABOPS_DB_PATH: testDb, LABOPS_AUTH_MODE: 'demo', AGNES_API_KEY: '', DASHSCOPE_API_KEY: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP 超时未应答。stderr=${err.slice(0, 300)}`));
    }, 25000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (err += c));
    child.stdout.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      const map = new Map<number, Rpc>();
      for (const line of out.trim().split('\n').filter(Boolean)) {
        const m = JSON.parse(line) as Rpc;
        if (m.id !== undefined) map.set(m.id, m);
      }
      resolve(map);
    });
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    child.stdin.end();
  });
}

const handshake = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' }
];

test('initialize 与 tools/list 正常应答，通知不产生回包', async () => {
  const r = await talk(handshake);
  assert.equal(r.size, 2, '通知消息不应答');
  assert.equal(r.get(1)!.result!.serverInfo?.name, 'labops-agent');
  const tools = r.get(2)!.result!.tools!;
  assert.ok(tools.length >= 8, `只读工具数 ${tools.length}`);
  assert.ok(tools.every((t) => t.inputSchema), '每个工具都要带 inputSchema');
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), '全部标注只读');
});

test('草稿与写入类工具既不列出、也不可调用', async () => {
  const r = await talk([...handshake, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'prepare_issue_ticket', arguments: {} } }]);
  const names = r.get(2)!.result!.tools!.map((t) => t.name);
  assert.ok(names.every((n) => !n.startsWith('prepare_') && !n.startsWith('create_')), `列出了写工具：${names.join(',')}`);
  const call = r.get(3)!.result!;
  assert.equal(call.isError, true, '调用草稿工具必须失败');
  assert.match(call.content![0]!.text, /只读白名单/);
});

test('默认最小权限：学生身份检索不到管理员专属制度', async () => {
  const r = await talk([...handshake, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_knowledge', arguments: { query: '调课' } } }]);
  const body = JSON.parse(r.get(3)!.result!.content![0]!.text) as { payload: { hits: Array<{ id: string }> } };
  assert.ok(!body.payload.hits.some((h) => h.id === 'schedule-adjustment'), 'admin-only 制度不得出现在学生结果里');
});

test('角色由服务端环境变量决定，客户端传 role 无效', async () => {
  const asAdmin = await talk(
    [...handshake, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_knowledge', arguments: { query: '调课', role: 'student' } } }],
    { LABOPS_MCP_ROLE: 'admin' }
  );
  const body = JSON.parse(asAdmin.get(3)!.result!.content![0]!.text) as { payload: { hits: Array<{ id: string }> } };
  assert.ok(body.payload.hits.some((h) => h.id === 'schedule-adjustment'), '服务端设为 admin 时应能检索到');
});

test('回归：每个暴露的只读工具都要真能跑（ctx 缺 dataset 时曾一调即抛）', async () => {
  const list = await talk(handshake);
  const names = list.get(2)!.result!.tools!.map((t) => t.name);
  const args: Record<string, unknown> = {};
  for (const name of names) args[name] = {};
  // 需要必填参数的工具给最小合法入参
  args.query_schedule = { date: '2026-10-29', labName: 'E310' };
  args.query_lab_status = { labName: 'E310' };
  args.query_free_rooms = { date: '2026-10-29' };
  args.query_knowledge = { query: '调课' };
  args.query_business_context = { view: 'issues' };
  args.analyze_evidence_image = { attachmentIds: ['attachment-00000000-0000-4000-8000-000000000000'] };
  const msgs: unknown[] = [...handshake];
  names.forEach((n, i) => msgs.push({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: n, arguments: args[n] ?? {} } }));
  const r = await talk(msgs);
  for (const [i, n] of names.entries()) {
    const res = r.get(100 + i)!.result!;
    const text = res.content?.[0]?.text ?? '';
    // 允许业务性的"取不到/未连接/未配置"（那是如实回答），但不允许内部异常
    assert.ok(!/tool_internal_error|Cannot read properties|is not a function|undefined/.test(text),
      `${n} 内部异常：${text.slice(0, 160)}`);
  }
});

test('未知方法返回 JSON-RPC 错误而不是崩溃', async () => {
  const r = await talk([{ jsonrpc: '2.0', id: 9, method: 'resources/list' }]);
  assert.equal(r.get(9)!.error?.code, -32601);
});
