/**
 * 回归防护：工具失败时，run_failed 必须上报**真实原因**
 * ============================================================================
 *  问题形态：用户问「帮我发一条通知：请当前节次志愿者来5楼一趟」，界面只显示
 *
 *     失败原因：evidence_missing  本轮未取得可验证业务依据，未生成事实结论。
 *     请明确日期、房间或所需操作后重试。
 *
 *  对"已经说清操作"的请求给出"请明确日期、房间"是无效建议，会诱导用户反复重试；
 *  而真实原因其实就在 tool_result.error 里。
 *
 *  口径（代码可证）：lastToolSummary 只在**工具成功**时赋值，
 *  走到该分支时不可能有任何成功调用（成功必进 verifiedAnswers）
 *  ⇒ 它恒为 null ⇒ 若拿它兜底 run_failed.message，通用文案会 100% 命中。
 *
 *  本测试把模型替换成照剧本演的替身，确定性地制造"工具失败且无成功调用"，
 *  断言真实错误码与工具名必须出现在用户可见的失败信息里。
 */

process.env.LABOPS_AUTH_MODE = 'demo';

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-failure-report-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'agent.sqlite');
// 置非空只是为了让引擎判定为 agnes（真正的 HTTP 由下面的钩子换掉）
process.env.AGNES_API_KEY = 'stub-not-a-real-key';
process.env.LABOPS_RUNS_PER_MINUTE = '1000';
process.env.LABOPS_RUNS_PER_DAY = '10000';

const STUB_URL = new URL('./fixtures/model-stub.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    // 只替换 run.ts 对 router.ts 的引用，避免影响其它模块（例如 server/index.ts）
    if (context.parentURL?.includes('/server/agent/run.ts') && specifier.endsWith('/llm/router.ts')) {
      return next(STUB_URL, context);
    }
    if (specifier.startsWith('@shared/')) {
      return next(new URL('../shared/' + specifier.slice(8) + '.ts', import.meta.url).href, context);
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.includes('/web/')) {
      return next(new URL(specifier + '.ts', context.parentURL).href, context);
    }
    return next(specifier, context);
  }
});

const { runAgent } = await import('../server/agent/run.ts');
const { resetScript } = await import('./fixtures/model-stub.ts');

const actor = { id: 'stub-owner', role: 'admin' as const, label: 'stub' };

async function run(question: string, sessionId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  for await (const e of runAgent({ question, sessionId, actor })) {
    events.push(e as unknown as { type: string; payload: Record<string, unknown> });
  }
  return events;
}

/** 通用兜底文案 —— 出现即视为回归 */
const LEGACY_GENERIC = '本轮未取得可验证业务依据，未生成事实结论。请明确日期、房间或所需操作后重试。';

test('工具失败且无成功调用：run_failed 必须带上真实工具名与错误码，不得退化成通用文案', async () => {
  // 剧本：第 1 轮要求查一个**参数非法**的课表（date 不是合法日期 ⇒ bad_date），第 2 轮只说一句话
  resetScript([
    { kind: 'tool', name: 'query_schedule', args: { date: '不是日期', labName: 'E310' } },
    { kind: 'text', text: '（替身模型的收尾发言，应被丢弃而不是伪装成结论）' }
  ]);

  const events = await run('帮我发一条通知：请当前节次志愿者来5楼一趟', 'stub-tool-failure');
  const types = events.map((e) => e.type);

  // 前提：确实执行了工具，且工具确实失败
  const toolResult = events.find((e) => e.type === 'tool_result');
  assert.ok(toolResult, `应产生 tool_result，实际事件：${types.join(',')}`);
  assert.equal(toolResult.payload['ok'], false, '该用例的前提是工具调用失败');

  const failed = events.find((e) => e.type === 'run_failed');
  assert.ok(failed, `应为 run_failed（本轮无任何可核验结论），实际事件：${types.join(',')}`);
  assert.ok(!types.includes('run_completed'), '失败轮不得同时出现 run_completed');

  const message = String(failed.payload['message']);
  const hint = String(failed.payload['hint']);

  // 机器码保持稳定：现有前端与测试按 'evidence_missing' 识别该终态，不随实现调整而变更
  assert.equal(failed.payload['code'], 'evidence_missing');
  // 真实原因必须到达用户可见位置
  assert.match(message, /query_schedule/, `失败信息必须点明是哪个工具：${message}`);
  assert.match(message, /bad_date/, `失败信息必须带上真实错误码：${message}`);
  assert.doesNotMatch(message, new RegExp(LEGACY_GENERIC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不得再回退到无效的通用建议');
  assert.ok(hint.length > 0, '必须给出可执行建议');
});

test('框架类失败（工具不存在/当前模式不可用）给出的是"不是参数问题"的建议，而不是让用户补参数', async () => {
  resetScript([
    { kind: 'tool', name: 'publish_notification_now', args: {} }, // 不存在的工具 ⇒ unknown_tool
    { kind: 'text', text: '（收尾）' }
  ]);

  const events = await run('帮我发一条通知：请当前节次志愿者来5楼一趟', 'stub-unknown-tool');
  const failed = events.find((e) => e.type === 'run_failed');
  assert.ok(failed, `应为 run_failed，实际事件：${events.map((e) => e.type).join(',')}`);

  const message = String(failed.payload['message']);
  const hint = String(failed.payload['hint']);
  assert.match(message, /unknown_tool/, `应带真实错误码：${message}`);
  assert.match(hint, /不是参数问题|权限|页面办理/, `框架类失败不该让用户"补参数"：${hint}`);
  assert.doesNotMatch(hint, /明确日期|补充.*房间号.*再试/, `不得给出与失败原因无关的建议：${hint}`);
});
