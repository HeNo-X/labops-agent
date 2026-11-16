/**
 * A4 失败轨迹保留 + 收敛前复述
 * ============================================================================
 *  失败轨迹是模型的学习信号（keep the wrong stuff in）。
 *  两条落地：① 失败 tool 消息豁免预算瘦身（指引不能被剪掉）；
 *  ② 带失败进入最后一轮 / 连续失败 ≥2 时，把失败摘要复述注入（纯函数锁边界）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReciteFailure, failureRecitationText } from '../server/agent/prompts.ts';
import { slimToolMessage } from '../server/agent/context-budget.ts';
import type { ChatMessage } from '../server/llm/agnes.ts';

const base = { steps: 3, maxSteps: 6, hasFailure: true, consecutiveToolFailures: 0, recited: false };

test('A4-01 触发：连续失败 ≥2 即复述（不必等最后一轮）', () => {
  assert.equal(shouldReciteFailure({ ...base, consecutiveToolFailures: 2 }), true);
  assert.equal(shouldReciteFailure({ ...base, consecutiveToolFailures: 1 }), false);
});

test('A4-02 触发：带失败进入最后一轮（steps 达到 maxSteps）', () => {
  assert.equal(shouldReciteFailure({ ...base, steps: 6, maxSteps: 6 }), true);
  assert.equal(shouldReciteFailure({ ...base, steps: 5, maxSteps: 6 }), false, '倒数第二轮之前不复述');
});

test('A4-03 不触发：无失败 / 已复述过 / 步数富余且失败不成串', () => {
  assert.equal(shouldReciteFailure({ ...base, hasFailure: false }), false);
  assert.equal(shouldReciteFailure({ ...base, recited: true, consecutiveToolFailures: 3 }), false, '整个 run 只复述一次');
  assert.equal(shouldReciteFailure({ ...base, steps: 1, maxSteps: 6 }), false);
});

test('A4-04 复述文案带工具名/错误码/消息与行为指令，不编造结果', () => {
  const text = failureRecitationText({ tool: 'query_schedule', code: 'lab_not_found', message: '房间号 E999 不存在' });
  assert.match(text, /query_schedule/);
  assert.match(text, /lab_not_found/);
  assert.match(text, /E999 不存在/);
  assert.match(text, /不要用相同参数或相同路径重试/);
  assert.match(text, /不要编造结果/);
});

test('A4-05 失败 tool 消息豁免瘦身（指引完整保留）', () => {
  const failure = {
    ok: false,
    code: 'lab_not_found',
    message: '房间号系统里没有',
    suggestions: Array.from({ length: 40 }, (_, i) => `E3${String(i).padStart(2, '0')}楼（候选房间号备选项第 ${i} 条，用于覆盖超过保留线的建议列表）`).join('、'),
    instruction: '请从 suggestions 里挑一个最接近的重新调用，若都不合适就直接告诉用户没有这个房间并列出可选项。'
  };
  const content = JSON.stringify(failure);
  assert.ok(content.length > 1200, '前置：失败消息确实超过保留线');
  const m: ChatMessage = { role: 'tool', tool_call_id: 'tc9', content };
  assert.equal(slimToolMessage(m), m, '失败消息必须原样返回（引用不变）');
});
