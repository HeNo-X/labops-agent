/**
 * 配额短路探针（自包含）—— 供 tests/llm-quota.test.ts 在独立子进程里调用
 * ============================================================================
 *  为什么自包含：父进程若用 execFileSync 会**阻塞自己的事件循环**，子进程的
 *  fetch 回连父进程里的假上游时永远得不到响应（双向死锁）——所以假上游必须
 *  由子进程自己起。config.ts 首次 getConfig() 缓存整份配置，env 必须在
 *  import router 之前设好。
 *
 *  用法：node tests/fixtures/quota-probe.ts <quota|auth>
 *  输出：一行 JSON { code, hits }（hits = 假上游被真实请求的次数）
 */
export {}; // 让本文件成为模块：顶层 await 只在模块里合法

import http from 'node:http';

const scenario = process.argv[2] === 'auth' ? 'auth' : 'quota';
const body = scenario === 'quota'
  ? '{"error":"AllocationQuota.FreeTierOnly","message":"add funds or disable the use free tier only mode"}'
  : '{"error":"InvalidApiKey","message":"无效的 API Key"}';

let hits = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  void req;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

process.env['DASHSCOPE_API_KEY'] = 'test-key-not-real';
process.env['DASHSCOPE_BASE_URL'] = `http://127.0.0.1:${port}/v1`;
process.env['DASHSCOPE_MODELS'] = 'quota-test-model,second-test-model';
delete process.env['AGNES_API_KEY'];

const { streamChatWithFallback } = await import('../../server/llm/router.ts');

let code: string | null = null;
let lastErr: unknown = null;
try {
  for await (const ev of streamChatWithFallback(
    { messages: [{ role: 'user', content: '探针：只测上游分类，不需要真回答' }], tools: [] },
    'chat'
  )) {
    void ev;
  }
} catch (err) {
  code = (err as { code?: string }).code ?? 'unknown';
  lastErr = err;
}
console.log(JSON.stringify({ code, hits, message: (lastErr as { message?: string }).message ?? null }));
server.close();
// 调过一次 streamChat 后，circuit/超时计时器会让事件循环挂着不退出——探针打完即退。
// 延迟 100ms 再退：Windows 上 process.exit 撞上 server 句柄关闭中的窗口会触发
// libuv 断言（src\win\async.c）以非零码崩掉，让父进程误判探针失败。
setTimeout(() => process.exit(0), 100);
