/**
 * 输出预算截断 → 同提供方翻倍重试一次，而不是立刻换模型（2026-11-10）
 * ============================================================================
 *  实测触发：演示第①步「E310 在 2026-11-12 下午第一大节投影仪没有信号，帮我登记故障事件」
 *    · AGNES_MAX_TOKENS=800 → 6 步 83.8s / 2 步 54.1s，日志成对出现
 *        llm_provider_failed(xfyun spark) … 模型响应未正常完成（length）
 *        agnes_attempt_failed code=agnes_rate_limited status=429 willRetry=true
 *    · 同一问法设 2000 → 28.1s，无失败事件。
 *
 *  根因：工具轮要写完"思考 + 工具名 + 参数 JSON"，800 经常不够；
 *    而 finish_reason=length 在旧实现里直接判死这一轮 → 链换提供方 → 撞上 429 退避。
 *    **不是模型坏了，是预算不够**，换模型只是把同一件事再贵一遍。
 *
 *  新行为：截断时在**同一个提供方**把 max_tokens 翻倍重发一次（上限 4000，只升一次），
 *    仍截断才交回链逻辑换提供方。默认值同步 800 → 2000。
 *
 *  运行：node --test tests/max-tokens-escalation.test.ts
 */

process.env.AGNES_API_KEY = 'stub-key';
process.env.AGNES_MAX_RETRIES = '0'; // 关掉普通重试，"能成功"只可能来自预算升级
process.env.AGNES_TIMEOUT_MS = '5000';
process.env.AGNES_MAX_TOKENS = '500'; // 便于断言翻倍：500 → 1000

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { streamChat } = await import('../server/llm/agnes.ts');

function sse(finish: string): string {
  // 截断那一次**不交付任何正文**（真实场景是工具参数 JSON 被剪断）：
  // 客户端只在没吐过内容时才升级预算重发，这是既有不变量（吐过内容就不重发）。
  const first = finish === 'length'
    ? '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"prepare_incident_plan","arguments":"{\\"act"}}]},"finish_reason":null}]}'
    : '{"choices":[{"delta":{"content":"我"},"finish_reason":null}]}';
  return `data: ${first}\n\n` +
    `data: {"choices":[{"delta":{},"finish_reason":"${finish}"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n` +
    'data: [DONE]\n\n';
}

const seen: Array<Record<string, unknown>> = [];
let server: http.Server;
let baseUrl = '';
/** 由测试控制：低于该预算就截断 */
let needTokens = 1000;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push(body);
      const budget = Number(body['max_tokens'] ?? 0);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse(budget < needTokens ? 'length' : 'stop'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => { server.close(); });

async function run(): Promise<{ text: string; bodies: Array<Record<string, unknown>>; code: string }> {
  seen.length = 0;
  let text = '';
  let code = '';
  try {
    for await (const ev of streamChat({
      messages: [{ role: 'user', content: '登记故障事件' }],
      provider: { name: 'xfyun', apiKey: 'stub', baseUrl, model: 'spark-x2.6' }
    })) {
      if (ev.type === 'text') text += ev.text;
    }
  } catch (e) {
    code = String((e as { code?: string }).code ?? '');
  }
  return { text, bodies: [...seen], code };
}

test('截断不再直接判死：同提供方翻倍预算重发一次并成功', async () => {
  needTokens = 1000; // 500 会截断，1000 够用
  const { text, bodies, code } = await run();
  assert.equal(code, '', `不该抛错，实际 ${code}`);
  assert.equal(bodies.length, 2, `应只多发一次，实际 ${bodies.length} 次`);
  assert.equal(Number(bodies[0]!['max_tokens']), 500);
  assert.equal(Number(bodies[1]!['max_tokens']), 1000, '第二次必须翻倍');
  assert.equal(text, '我');
});

test('升级只用一次：预算仍不够就如实报截断，不无限加码也不偷偷换模型', async () => {
  needTokens = 99999; // 怎么加都截断
  const { bodies, code } = await run();
  assert.equal(bodies.length, 2, '只允许一次预算升级重发');
  assert.equal(Number(bodies.at(-1)!['max_tokens']), 1000);
  assert.equal(code, 'truncated_response', '最终仍应把截断如实交回链逻辑');
});

test('预算本来就够：一次请求搞定，不产生额外往返', async () => {
  needTokens = 1;
  const { text, bodies, code } = await run();
  assert.equal(bodies.length, 1);
  assert.equal(code, '');
  assert.equal(text, '我');
});

test('默认输出预算 800 → 2000（演示实测的耗时差就来自这里）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/config.ts', import.meta.url), 'utf8');
  assert.match(src, /int\('AGNES_MAX_TOKENS', 2000,/, 'config 默认值必须已抬到 2000');
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /AGNES_MAX_TOKENS=2000/, '示例配置要跟上默认值');
});

test('已经吐过正文就不重发：守住"不换、不重发"的既有不变量', async () => {
  seen.length = 0;
  const prev = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"半句话"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        'data: [DONE]\n\n');
    });
  });
  try {
    let text = '';
    let code = '';
    try {
      for await (const ev of streamChat({
        messages: [{ role: 'user', content: '登记故障事件' }],
        provider: { name: 'xfyun', apiKey: 'stub', baseUrl, model: 'spark-x2.6' }
      })) {
        if (ev.type === 'text') text += ev.text;
      }
    } catch (e) { code = String((e as { code?: string }).code ?? ''); }
    assert.equal(seen.length, 1, '吐过正文后不得再发第二次请求（否则半句会被重复显示）');
    assert.equal(text, '半句话');
    assert.equal(code, 'truncated_response');
  } finally {
    server.removeAllListeners('request');
    prev.forEach((h) => server.on('request', h));
  }
});
