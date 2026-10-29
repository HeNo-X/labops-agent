#!/usr/bin/env node
/**
 * LabOps Agent —— MCP server（stdio / JSON-RPC 2.0）
 * ============================================================================
 *  把内部工具注册表按 Model Context Protocol 暴露出去，让任何 MCP 客户端
 *  （Inspector、Claude Desktop 等）能列出并调用同一套工具 —— 工具既是内部
 *  Agent 的注册表，也是标准 MCP 资源，不必为外部集成再写一遍。
 *
 *  ⚠ 安全边界（这是本文件存在的重点，不是附带说明）：
 *   1. **只暴露 effect==='read' 的工具**。prepare_* / create_* 一律不出现，
 *      否则 MCP 客户端就成了绕过"人工确认"这条主纪律的旁路。
 *   2. 角色由**服务端环境变量**决定，默认最小权限 student；客户端在
 *      tools/call 的 arguments 里传 role 一律无效。权限判定仍走工具内部
 *      的 effectiveRole / 角色过滤，与 HTTP 链路同一套。
 *   3. 不写任何业务状态：只读工具本身无副作用，这里也不建会话、不落库。
 *
 *  运行：LABOPS_MCP_ROLE=admin node server/mcp-server.ts
 *  自检：node server/mcp-server.ts --self-test
 */
import { REGISTRY, executeTool } from './tools/registry.ts';
import { serverNow, isValidDateString } from './time/term.ts';
import { loadAuthorizedDataset } from './business/bridge.ts';

const PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_INFO = { name: 'labops-agent', version: '1.0.4.0' };

/** 只读工具白名单：这是"外部客户端不得借道提交业务"的唯一闸门 */
function exposedTools() {
  return REGISTRY.filter((t) => t.effect === 'read');
}

function toolDescriptors() {
  return exposedTools().map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    inputSchema: t.spec.parameters,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }));
}

function mcpRole(): string {
  const raw = (process.env.LABOPS_MCP_ROLE || 'student').trim().toLowerCase();
  return ['admin', 'volunteer', 'student'].includes(raw) ? raw : 'student';
}

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = exposedTools().find((t) => t.spec.name === name);
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `工具不存在或不属于只读白名单：${name}` }] };
  }
  const role = mcpRole();
  try {
    // ctx 必须与 HTTP 链路同构：原先缺 dataset，query_schedule / query_lab_status /
    // query_free_rooms 一调即抛（实测 Cannot read properties of undefined (reading 'labs')）。
    const dataset = await loadAuthorizedDataset();
    const d = args['date'];
    const now = isValidDateString(d) ? serverNow(new Date(d + 'T12:00:00+08:00')) : serverNow();
    const ctx = {
      dataset,
      now,
      actor: { id: `mcp-${role}`, role, label: 'MCP 客户端' } as never,
      conversationId: null,
      mode: 'task' as const
    };
    // 走 executeTool 而不是 tool.execute：保留模式守卫，以及"已连原系统时沙盒工具
    // 不得混入"的范围检查 —— MCP 不是绕过这些的第二入口。
    const result = await executeTool(name, args ?? {}, ctx);
    const text = result.ok
      ? JSON.stringify({ summary: result.summary, resultKind: (result as { resultKind?: string }).resultKind, payload: (result as { result?: unknown }).result })
      : JSON.stringify({ summary: result.summary, code: result.code, message: result.message, suggestions: result.suggestions });
    return { content: [{ type: 'text', text }], isError: !result.ok };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `工具执行失败：${(e as Error).message}` }] };
  }
}

async function handle(msg: { id?: string | number | null; method?: string; params?: Record<string, unknown> }) {
  const { id, method, params } = msg;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params?.['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // 通知不应答
    case 'tools/list':
      return reply({ tools: toolDescriptors() });
    case 'tools/call': {
      const name = params?.['name'];
      const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') return fail(-32602, '缺少 tools/call 的 name');
      return reply(await callTool(name, args));
    }
    case 'ping':
      return reply({});
    default:
      return fail(-32601, `未知方法：${String(method)}`);
  }
}

/** 自检：不依赖外部 MCP 客户端，验证协议帧与"只暴露只读工具"这条边界 */
async function selfTest(): Promise<number> {
  const names = toolDescriptors().map((t) => t.name);
  const drafts = REGISTRY.filter((t) => t.effect !== 'read').map((t) => t.spec.name);
  const checks: Array<[string, boolean, string]> = [
    ['存在只读工具', names.length > 0, `${names.length} 个`],
    ['未暴露任何草稿工具', !names.some((n) => drafts.includes(n)), `草稿 ${drafts.length} 个全部缺席`],
    ['草稿清单非空（否则上一断言无意义）', drafts.length > 0, drafts.slice(0, 3).join(', ')],
    ['拒绝调用草稿工具', (await callTool('prepare_issue_ticket', {})).isError === true, '旁路被挡'],
    ['tools/list 带 inputSchema', toolDescriptors().every((t) => !!t.inputSchema), '全部有 schema'],
    ['角色默认最小权限', mcpRole() === 'student' || process.env.LABOPS_MCP_ROLE !== undefined, `当前 ${mcpRole()}`]
  ];
  let bad = 0;
  for (const [label, ok, detail] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${label} —— ${detail}`);
  }
  console.log(`\n只读白名单：${names.join(', ')}`);
  return bad ? 1 : 0;
}

if (process.argv.includes('--self-test')) {
  process.exit(await selfTest());
}

// stdio 循环：按行读取 JSON-RPC（换行分隔，MCP stdio 传输的常见实现）
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    type Inbound = { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    let msg: Inbound;
    try {
      msg = JSON.parse(line) as Inbound;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败' } }) + '\n');
      continue;
    }
    const out = await handle(msg);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
