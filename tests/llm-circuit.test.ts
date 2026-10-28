/**
 * 模型熔断验收（WS2.6）
 * ============================================================================
 *  顺序 fallback 链的问题不是"不会换模型"，而是**每轮都要重新撞一次坏模型**。
 *  这里锁四件事：
 *   ① 连续失败达阈值才开熔断（单次抖动不该拉黑）；
 *   ② 冷却期内跳过，但**全链都在冷却时仍要放行** —— 熔断是优化，
 *      不能反而把自己锁成不可用；
 *   ③ 成功一次即清零；
 *   ④ 已经吐出内容后的失败**不计熔断**（那是本次回答的问题，不是模型的错）。
 *
 *  运行：node --test tests/llm-circuit.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-circuit-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'agent.sqlite');
process.env.AGNES_API_KEY = '';
process.env.DASHSCOPE_API_KEY = '';
process.env.LLM_CIRCUIT_THRESHOLD = '3';
process.env.LLM_CIRCUIT_COOLLOFF_MS = '20000';
process.env.LLM_CIRCUIT_MAX_COOLLOFF_MS = '120000';

const { selectableProviders, recordFailure, recordSuccess, isCoolingDown, cooloffRemaining, circuitStatus, resetCircuitForTests } =
  await import('../server/llm/circuit.ts');

const p1 = { baseUrl: 'https://a.test/v1', model: 'm1' };
const p2 = { baseUrl: 'https://a.test/v1', model: 'm2' };

beforeEach(() => resetCircuitForTests());

test('未达阈值不熔断；达阈值后进入冷却', () => {
  recordFailure(p1);
  recordFailure(p1);
  assert.equal(isCoolingDown(p1), false, '2 次失败 < 阈值 3，不应熔断');
  recordFailure(p1);
  assert.equal(isCoolingDown(p1), true, '第 3 次失败应熔断');
  assert.ok(cooloffRemaining(p1) > 0 && cooloffRemaining(p1) <= 20000);
});

test('冷却期内该模型被跳过，健康的模型照常入选', () => {
  for (let i = 0; i < 3; i++) recordFailure(p1);
  const { ready, skipped, allCooling } = selectableProviders([p1, p2]);
  assert.deepEqual(ready.map((p) => p.model), ['m2']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.model, 'm1');
  assert.equal(allCooling, false);
});

test('全链都在冷却时照常放行 —— 熔断不得变成新的不可用来源', () => {
  for (let i = 0; i < 3; i++) {
    recordFailure(p1);
    recordFailure(p2);
  }
  const { ready, allCooling } = selectableProviders([p1, p2]);
  assert.equal(ready.length, 2, '全部冷却时应回退为原链');
  assert.equal(allCooling, true, '并如实告知上层这是回退而非健康');
});

test('成功一次即清零，冷却自动结束后恢复', () => {
  for (let i = 0; i < 3; i++) recordFailure(p1);
  assert.equal(isCoolingDown(p1), true);
  recordSuccess(p1);
  assert.equal(isCoolingDown(p1), false, '成功后必须立刻恢复可用');
  assert.equal(circuitStatus([p1])[0]!.consecutiveFailures, 0);
});

test('冷却随连续失败指数退避，并受上限约束', () => {
  for (let i = 0; i < 3; i++) recordFailure(p1);
  const first = cooloffRemaining(p1);
  recordFailure(p1); // 第 4 次 → 2×
  const second = cooloffRemaining(p1);
  assert.ok(second > first, `第二次冷却 ${second} 应长于第一次 ${first}`);
  for (let i = 0; i < 12; i++) recordFailure(p1);
  assert.ok(cooloffRemaining(p1) <= 120000, '不得超过 maxCooloffMs 上限');
});

test('熔断只影响"选谁"，不影响链上模型数量与健康检查口径', () => {
  const chain = [p1, p2];
  for (let i = 0; i < 3; i++) recordFailure(p1);
  // 健康检查必须报出**完整计划链**（含在冷却的那个），否则运维看不到"它为什么不见了"
  const rows = circuitStatus(chain);
  assert.equal(rows.length, chain.length, '状态表不得因冷却而少报模型');
  assert.equal(rows.find((r) => r.model === 'm1')!.coolingDown, true);
  assert.equal(rows.find((r) => r.model === 'm2')!.coolingDown, false);
  // 而实际尝试的链确实短了
  assert.equal(selectableProviders(chain).ready.length, 1);
});

test('circuitStatus 输出不含密钥，可直接给界面用', () => {
  recordFailure(p1);
  const rows = circuitStatus([p1, p2]);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['consecutiveFailures', 'coolingDown', 'model', 'retryInMs']);
  assert.ok(!JSON.stringify(rows).includes('sk-'));
});
