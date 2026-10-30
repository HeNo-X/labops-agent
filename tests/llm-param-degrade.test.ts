/**
 * 模型不支持的参数 → 摘掉重发，而不是把模型判死（2026-10-31）
 * ============================================================================
 *  真实触发：把聊天链换成新一批模型后，排第一的 kimi-k3 **每次都 400**：
 *    InternalError.Algo.InvalidParameter:
 *    Parameter 'temperature'=0.3 is not supported for kimi-k3 model.
 *  旧行为：classify → agnes_bad_request（不可重试）→ router 记一次熔断失败 → 换下一个模型。
 *  后果不是"出错"，而是**每次聊天都白跑一趟**（约 250 ms）+ 日志持续报警 + 熔断反复冷却。
 *
 *  新行为：从 400 正文里认出参数名，摘掉该参数重发一次；不换模型、不计重试次数。
 *  边界写死在 DEGRADABLE_PARAMS 里：只有采样类参数可摘，
 *  tools / tool_choice / messages 这类删了会**功能缺失**的一律不碰。
 *
 *  运行：node --test tests/llm-param-degrade.test.ts
 */

process.env.AGNES_API_KEY = 'stub-key';
process.env.AGNES_MAX_RETRIES = '0'; // 禁用普通重试，确保"能成功"只可能来自参数降级
process.env.AGNES_TIMEOUT_MS = '5000';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { streamChat, unsupportedParam } = await import('../server/llm/agnes.ts');

const KIMI_400 = JSON.stringify({
  error: {
    message: "<400> InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported for kimi-k3 model.",
    type: 'invalid_request_error',
    code: 'invalid_parameter_error'
  }
});

const SSE_OK =
  'data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n' +
  'data: [DONE]\n\n';

const seen: Array<Record<string, unknown>> = [];
let server: http.Server;
let baseUrl = '';

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push(body);
      // 守门：只要请求里带 temperature 就按上游原文拒绝，模拟 kimi-k3
      if (body['model'] === 'kimi-k3' && 'temperature' in body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(KIMI_400);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(SSE_OK);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => {
  server.close();
});

async function run(model: string): Promise<{ text: string; bodies: Array<Record<string, unknown>> }> {
  seen.length = 0;
  let text = '';
  for await (const ev of streamChat({
    messages: [{ role: 'user', content: '在吗' }],
    provider: { name: 'dashscope', apiKey: 'stub', baseUrl, model }
  })) {
    if (ev.type === 'text') text += ev.text;
  }
  return { text, bodies: [...seen] };
}

test('模型不支持 temperature：摘掉参数重发并成功，而不是报 400 换模型', async () => {
  const { text, bodies } = await run('kimi-k3');
  assert.equal(bodies.length, 2, `应该只多发一次，实际发了 ${bodies.length} 次`);
  assert.ok('temperature' in bodies[0]!, '第一次必须带着 temperature（不能预先阉割）');
  assert.ok(!('temperature' in bodies[1]!), '第二次必须已摘掉 temperature');
  assert.ok('max_tokens' in bodies[1]!, '其它参数不能被顺手删掉');
  assert.equal(text, '好');
});

test('模型支持 temperature：原样发一次，不产生额外请求', async () => {
  const { text, bodies } = await run('qwen3.8-flash');
  assert.equal(bodies.length, 1);
  assert.ok('temperature' in bodies[0]!);
  assert.equal(text, '好');
});

test('只认可采样的参数：tools / tool_choice 这类删了会缺功能的，一律不摘', () => {
  assert.equal(unsupportedParam("Parameter 'temperature'=0.3 is not supported for kimi-k3 model."), 'temperature');
  assert.equal(unsupportedParam("Unsupported parameter: 'top_p'"), 'top_p');
  assert.equal(unsupportedParam("Unknown parameter 'seed'"), 'seed');
  assert.equal(unsupportedParam("Parameter 'tool_choice'=auto is not supported"), null);
  assert.equal(unsupportedParam("Parameter 'tools'=... is not supported"), null);
  assert.equal(unsupportedParam('{"error":{"message":"模型不存在"}}'), null);
});

test('降级有上限：连续换着花样拒绝也不会无限重发', async () => {
  const denyAll = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push(body);
      const next = ['temperature', 'top_p', 'seed'].find((k) => k in body);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Parameter '${next ?? 'model'}' = x is not supported` } }));
    });
  });
  await new Promise<void>((r) => denyAll.listen(0, '127.0.0.1', r));
  const port = (denyAll.address() as AddressInfo).port;
  seen.length = 0;
  await assert.rejects(
    (async () => {
      for await (const _ev of streamChat({
        messages: [{ role: 'user', content: '在吗' }],
        provider: { name: 'dashscope', apiKey: 'stub', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'x' }
      })) {
        void _ev;
      }
    })(),
    /not supported|不符合接口要求/
  );
  denyAll.close();
  assert.ok(seen.length <= 4, `最多尝试 1+3 次，实际 ${seen.length} 次`);
});
