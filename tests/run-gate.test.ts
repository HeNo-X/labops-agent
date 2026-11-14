/**
 * 跨会话并发第二片 —— 全局 run 闸门的行为契约（纯模块级，不起服务、不碰 DB）
 * 负向验证：把 server/agent/run-gate.ts 还原到接入前（无闸门）本组应全部转红。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireRunSlot,
  runGateConfig,
  runGateStats,
  resetRunGateForTests,
  RunQueueTimeoutError,
  RunQueueAbortedError
} from '../server/agent/run-gate.ts';

const keys = ['AGENT_CONCURRENCY_GATE', 'AGENT_MAX_CONCURRENT_RUNS', 'AGENT_QUEUE_WAIT_MS'];
afterEach(() => {
  resetRunGateForTests();
  for (const key of keys) delete process.env[key];
});

test('C01 默认口径：开着、上限 2、排队 30s', () => {
  const cfg = runGateConfig();
  assert.deepEqual(cfg, { enabled: true, maxConcurrent: 2, queueWaitMs: 30000 });
});

test('C02 上限内立即放行，超限 FIFO 排队，release 后按先来后到补位', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '2';
  const a = await acquireRunSlot({ runId: 'a', conversationId: 'conv-a' });
  const b = await acquireRunSlot({ runId: 'b', conversationId: 'conv-b' });
  assert.equal(a.queued, false);
  assert.equal(b.queued, false);
  assert.equal(runGateStats().active, 2);

  const notices: number[] = [];
  const c = acquireRunSlot({
    runId: 'c',
    conversationId: 'conv-c',
    onQueue: (position) => notices.push(position)
  });
  const d = acquireRunSlot({ runId: 'd', conversationId: 'conv-d' });
  assert.equal(runGateStats().waiting, 2);

  a.release();
  const gotC = await c;
  assert.equal(gotC.queued, true);
  assert.deepEqual(notices, [2], '排队位置应为正在跑的数量，不是队列下标');
  assert.equal(runGateStats().waiting, 1);

  b.release();
  const gotD = await d;
  assert.equal(gotD.queued, true);
  assert.equal(runGateStats().active, 2);
  gotC.release();
  gotD.release();
  assert.equal(runGateStats().active, 0);
});

test('C03 AGENT_CONCURRENCY_GATE=0 一键回退：完全不限流、不排队', async () => {
  process.env['AGENT_CONCURRENCY_GATE'] = '0';
  const slots = await Promise.all(
    Array.from({ length: 6 }, (_, i) => acquireRunSlot({ runId: 'r' + i, conversationId: 'conv-' + i }))
  );
  assert.ok(slots.every((s) => !s.queued));
  assert.equal(runGateStats().active, 0, '回退态不登记活跃名额');
  for (const s of slots) s.release();
});

test('C04 release 幂等，重复释放不会多放名额', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '1';
  const a = await acquireRunSlot({ runId: 'a', conversationId: 'conv-a' });
  const pending = acquireRunSlot({ runId: 'b', conversationId: 'conv-b' });
  a.release();
  a.release();
  const b = await pending;
  assert.equal(runGateStats().active, 1);
  b.release();
  assert.equal(runGateStats().active, 0);
});

test('C05 排队超时抛可识别错误，且不永久占名额', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '1';
  process.env['AGENT_QUEUE_WAIT_MS'] = '25';
  const a = await acquireRunSlot({ runId: 'a', conversationId: 'conv-a' });
  await assert.rejects(
    acquireRunSlot({ runId: 'b', conversationId: 'conv-b' }),
    (err: unknown) => err instanceof RunQueueTimeoutError && (err as RunQueueTimeoutError).code === 'queue_timeout'
  );
  assert.equal(runGateStats().waiting, 0);
  assert.equal(runGateStats().active, 1, '名额仍被 a 占着，后来者仍要等');
  a.release();
});

test('C06 排队期间客户端断开会自动离队', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '1';
  const a = await acquireRunSlot({ runId: 'a', conversationId: 'conv-a' });
  const ac = new AbortController();
  const pending = acquireRunSlot({ runId: 'b', conversationId: 'conv-b', signal: ac.signal });
  assert.equal(runGateStats().waiting, 1);
  ac.abort();
  await assert.rejects(pending, RunQueueAbortedError);
  assert.equal(runGateStats().waiting, 0);
  a.release();
});

test('C07 关闭闸门时已排队的任务立即全部放行', async () => {
  process.env['AGENT_MAX_CONCURRENT_RUNS'] = '1';
  const a = await acquireRunSlot({ runId: 'a', conversationId: 'conv-a' });
  const b = acquireRunSlot({ runId: 'b', conversationId: 'conv-b' });
  assert.equal(runGateStats().waiting, 1);
  process.env['AGENT_CONCURRENCY_GATE'] = '0';
  // 运行中热改开关：新请求会顺手把已在队列里的放走（不用等 release）
  const c = await acquireRunSlot({ runId: 'c', conversationId: 'conv-c' });
  assert.equal(c.queued, false);
  const gotB = await b;
  assert.equal(gotB.queued, true, '入队时确实排过队，随后被放行');
  a.release();
  gotB.release();
  c.release();
});
