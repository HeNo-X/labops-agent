/**
 * 熔断记账时机验收 —— 用户取消不得算模型失败
 * ============================================================================
 *  旧实现把"未吐出内容前的一切异常"都记成失败，其中**包含用户主动取消**。
 *  后果不是数字难看：signal 已 abort，链上其余模型会秒抛秒记账，
 *  取消 3 次就能把一个健康模型冷却 20 秒 —— 与 circuit.ts 自己写的
 *  "不该让模型替后续请求背锅"直接矛盾。
 *
 *  运行：node --test tests/circuit-cancel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-cancel-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'a.sqlite');
process.env.LABOPS_AUTH_MODE = 'demo';
process.env.AGNES_API_KEY = '';
process.env.DASHSCOPE_API_KEY = 'test-key-for-chain';
process.env.DASHSCOPE_MODELS = 'm-first,m-second';
process.env.LLM_CIRCUIT_THRESHOLD = '1'; // 一次失败即熔断，便于观察计数

/** 替身 agnes：只暴露 streamChat，行为由 CANCEL_STUB_MODE 决定 */
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/llm/router.ts') && specifier.endsWith('/agnes.ts')) {
      return next(new URL('./fixtures/cancel-agnes.ts', import.meta.url).href, context);
    }
    return next(specifier, context);
  }
});

const { streamChatWithFallback } = await import('../server/llm/router.ts');
const { circuitStatus, resetCircuitForTests } = await import('../server/llm/circuit.ts');
const { cancelCalls } = await import('./fixtures/cancel-agnes.ts');

test('用户取消：不记熔断失败，也不继续试链上其余模型', async () => {
  resetCircuitForTests();
  cancelCalls.length = 0;
  const ac = new AbortController();
  ac.abort(); // 模拟"这一轮已被用户取消"
  let threw: unknown = null;
  try {
    for await (const _ of streamChatWithFallback({ messages: [], signal: ac.signal }, 'chat')) void _;
  } catch (e) {
    threw = e;
  }
  assert.equal((threw as { code?: string })?.code, 'run_cancelled', '取消应原样上抛');
  assert.equal(cancelCalls.length, 1, `取消后不应继续尝试链上其余模型，实际调用 ${cancelCalls.length} 次`);
  const cooled = circuitStatus([
    { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'm-first' },
    { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'm-second' }
  ]);
  assert.ok(cooled.every((c) => c.consecutiveFailures === 0), '取消不得计入熔断失败计数');
});

test('对照：真实的上游失败仍然要记熔断（否则闸门形同虚设）', async () => {
  resetCircuitForTests();
  cancelCalls.length = 0;
  process.env.CANCEL_STUB_MODE = 'upstream-500';
  const fresh = await import('../server/llm/router.ts');
  let threw: unknown = null;
  try {
    for await (const _ of fresh.streamChatWithFallback({ messages: [] }, 'chat')) void _;
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, '真实失败必须上抛');
  assert.equal(cancelCalls.length, 2, '两个模型都失败时应各试一次');
  process.env.CANCEL_STUB_MODE = 'cancel';
});
