/**
 * 模型分流可见性 —— 回归防护（2026-10-06）
 * ============================================================================
 *  用户问：「当前在聊天模式下回复问题的是哪个模型？在工作模式下执行任务的又是谁？
 *          是否已按我的预期根据不同模式选择不同模型进行工作？」
 *
 *  实测发现两处"看不见"：
 *   ① 前端只在 engine==='agnes' 时硬编码 "Agnes 3.0 Flash"；
 *      聊天模式走 DashScope 时 engine==='dashscope' → 标签**为空**，用户完全看不到是谁在回答。
 *   ② run_started / run_completed 只带 engine（提供方），不带**实际生效的模型 id**，
 *      所以 fallback 换过模型也没人知道，更无从核对分流。
 *
 *  修复：真实模型 id 一路带到 run_completed 并落库进消息 meta；
 *  /api/state 与 /api/agent/health 暴露分模式模型清单（只有模型 id，不含密钥）。
 *
 *  运行：node --test tests/model-routing.test.ts
 */

process.env.LABOPS_AUTH_MODE = 'demo';

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-model-routing-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'agent.sqlite');
// 置非空只是为了让引擎判定为"已配置大模型"（真正的 HTTP 由下面的钩子换成替身）
process.env.AGNES_API_KEY = 'stub-not-a-real-key';
process.env.LABOPS_RUNS_PER_MINUTE = '1000';
process.env.LABOPS_RUNS_PER_DAY = '10000';

const STUB_URL = new URL('./fixtures/model-stub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/server/agent/run.ts') && specifier.endsWith('/llm/router.ts')) {
      return next(STUB_URL, context);
    }
    return next(specifier, context);
  }
});

const { runAgent, runtimeCapabilities } = await import('../server/agent/run.ts');
const { resetScript, STUB_MODELS } = await import('./fixtures/model-stub.ts');

const actor = { id: 'routing-owner', role: 'admin' as const, label: 'stub' };

async function run(question: string, sessionId: string, mode: 'chat' | 'task'): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  for await (const e of runAgent({ question, sessionId, mode, actor })) {
    events.push(e as unknown as { type: string; payload: Record<string, unknown> });
  }
  return events;
}

test('聊天模式：事件里带出 DashScope 链上实际生效的模型', async () => {
  // 用寒暄类提问：本轮不需要工具，"模型只说话"这条路径才会正常收尾（否则按无依据失败）
  resetScript([{ kind: 'text', text: '不客气！' }]);
  const events = await run('谢谢', 'routing-chat', 'chat');
  const started = events.find((e) => e.type === 'run_started');
  const done = events.find((e) => e.type === 'run_completed');
  assert.ok(started && done, events.map((e) => e.type).join(','));
  assert.equal(started.payload['model'], STUB_MODELS.chat);
  assert.equal(done.payload['model'], STUB_MODELS.chat, '完成事件必须带真实模型，界面据此显示"谁在回答"');
});

test('工作模式：事件里带出 Agnes 实际生效的模型', async () => {
  resetScript([{ kind: 'text', text: '不客气！' }]);
  const events = await run('谢谢', 'routing-task', 'task');
  const done = events.find((e) => e.type === 'run_completed');
  assert.ok(done, events.map((e) => e.type).join(','));
  assert.equal(done.payload['model'], STUB_MODELS.task);
  assert.notEqual(STUB_MODELS.chat, STUB_MODELS.task, '两个模式必须是不同的模型，否则断言没有意义');
});

test('分模式模型清单可被运维核对（只有模型 id，不含密钥）', () => {
  const caps = runtimeCapabilities() as { modelsByMode: { chat: string[]; task: string[] }; engineByMode: Record<string, string> };
  assert.deepEqual(caps.modelsByMode, { chat: [STUB_MODELS.chat], task: [STUB_MODELS.task] });
  assert.ok(!JSON.stringify(caps).includes('stub-not-a-real-key'), '健康信息里绝不能出现密钥');
});

test('受众口径错误到达用户时是可执行的：带 bad_audience + 工具名 + "发给谁"的建议', async () => {
  // 剧本：模型照沙盒词表写受众，且角色说法无法映射（模拟"值班同学"这类自然语言）
  resetScript([
    { kind: 'tool', name: 'prepare_business_workflow', args: { kind: 'notification.publish', title: '值班提醒', content: '值班同学到5楼来', audience: { kind: 'role_scope', role: '值班同学' } } },
    { kind: 'text', text: '（收尾发言，应被丢弃）' }
  ]);
  const events = await run('帮我发一条通知：值班同学到5楼来', 'routing-audience', 'task');
  const failed = events.find((e) => e.type === 'run_failed');
  assert.ok(failed, events.map((e) => e.type).join(','));
  const message = String(failed.payload['message']);
  const hint = String(failed.payload['hint']);
  assert.match(message, /bad_audience/, message);
  assert.match(message, /prepare_business_workflow/, message);
  assert.match(hint, /发给谁/, `建议必须告诉用户下一步怎么做：${hint}`);
  assert.doesNotMatch(hint, /明确日期|房间号/, '不得给出与失败原因无关的建议');
});
