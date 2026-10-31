/**
 * 确定性兜底探针（自包含）—— 供 tests/llm-quota.test.ts 在独立子进程里调用
 * ============================================================================
 *  场景：模型链整体配额耗尽（假上游恒 403 AllocationQuota.FreeTierOnly），
 *  用户在聊天模式问"310当前有人吗"。预期：**run_completed**（不是 run_failed）
 *  —— runAgent 降级到确定性规则引擎，用真实授权数据照答并如实标注未用大模型。
 *  假上游由本进程自己起（execFileSync 会冻结父进程事件循环，见 A6 教训）。
 */
export {}; // 让本文件成为模块：顶层 await 只在模块里合法

import http from 'node:http';

let hits = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  void req;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end('{"error":{"message":"Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the use free tier only mode in the management console.","type":"AllocationQuota.FreeTierOnly","code":"AllocationQuota.FreeTierOnly"}}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

// 两条链都指向假 403 上游：聊天（DashScope）与任务（Agnes）任一模式都必须能兜底
process.env['DASHSCOPE_API_KEY'] = 'test-key-not-real';
process.env['DASHSCOPE_BASE_URL'] = `http://127.0.0.1:${port}/v1`;
process.env['DASHSCOPE_MODELS'] = 'quota-test-model';
process.env['AGNES_API_KEY'] = 'test-key-not-real';
process.env['AGNES_BASE_URL'] = `http://127.0.0.1:${port}/v1`;

const { runAgent } = await import('../../server/agent/run.ts');

const events: Array<Record<string, unknown>> = [];
for await (const ev of runAgent({ question: '310当前有人吗', mode: 'chat' })) {
  events.push(ev as unknown as Record<string, unknown>);
}
const last = events[events.length - 1] as { type?: string; payload?: { engine?: string; answer?: string; code?: string } } | undefined;
console.log(JSON.stringify({
  type: last?.type ?? 'none',
  engine: last?.payload?.engine ?? null,
  code: last?.payload?.code ?? null,
  answer: String(last?.payload?.answer ?? '').slice(0, 300),
  hits
}));
server.close();
setTimeout(() => process.exit(0), 100);
