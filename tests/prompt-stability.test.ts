/**
 * A1 提示词前缀稳定化（KV-cache 友好）—— 契约测试
 * ============================================================================
 *  随 run 变化的内容（当前时间、解算日期、注入疑似声明）绝不能留在 system 前缀里，
 *  否则供应商前缀缓存（DeepSeek / DashScope context caching）每次 run 都 miss，白白多花钱多花时间。
 *
 *  本文件锁死的契约：
 *    ① buildSystemPrompt 输出**不含任何时间上下文**，且同参字节稳定；
 *    ② 动态内容全部在 buildDynamicTurnContext（尾块）里，随 run 变化；
 *    ③ run.ts 的组装顺序（system 静态 → system 事实 → user → system 尾块）下，
 *       前缀跨 run 字节一致、尾块随 run 变化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_VERSION, buildSystemPrompt, buildDynamicTurnContext } from '../server/agent/prompts.ts';
import { buildTimeContext } from '../server/agent/intent.ts';
import type { Intent } from '../server/agent/intent.ts';
import type { ServerNow } from '../server/time/term.ts';
import type { ChatMessage } from '../server/llm/agnes.ts';

const TOOL_LIST = '【可用工具】\n- query_schedule：查询课表\n- query_free_rooms：查询空闲房间';

function nowOf(iso: string): ServerNow {
  const d = new Date(iso);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()] ?? '';
  return {
    iso,
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    weekday: d.getUTCDay(),
    weekdayLabel: wd
  };
}

function intentOf(): Intent {
  return { date: null, dateInvalid: null, periodKey: null, periodKeys: null, labName: null, className: null, notes: [] };
}

/** 与 run.ts:runAgnesEngine 相同的组装顺序（A1 后的形态） */
function assembleMessages(now: ServerNow, injectionSuspected: boolean): ChatMessage[] {
  const system = buildSystemPrompt({ toolList: TOOL_LIST, sourceTypeLabel: '演示快照', chatMode: false });
  return [
    { role: 'system', content: system + '\n' + '调课推荐JSON格式说明（静态）' },
    { role: 'system', content: '{"authorizedHistoricalFacts":[],"rule":"历史事实只可转换或参考"}' },
    { role: 'user', content: 'E310 今天有哪些课？' },
    { role: 'system', content: buildDynamicTurnContext({ timeContext: buildTimeContext(now, intentOf(), '第 8 教学周'), injectionSuspected }) }
  ];
}

test('A1-01 system 前缀不含时间上下文，且同参字节稳定', () => {
  const a = buildSystemPrompt({ toolList: TOOL_LIST, sourceTypeLabel: '演示快照', chatMode: false });
  const b = buildSystemPrompt({ toolList: TOOL_LIST, sourceTypeLabel: '演示快照', chatMode: false });
  assert.equal(a, b, '同参两次构建必须字节一致');
  assert.ok(!a.includes('【服务端当前时间】'), 'system 前缀不得出现时间上下文（挪到动态尾块）');
  assert.ok(!a.includes('【已解算的日期指代】'), '解算日期也属动态内容，不得留在前缀');
  assert.ok(a.includes(TOOL_LIST), '工具清单仍在 system 前缀（逐 run 稳定）');
  assert.ok(a.includes('演示快照'), '数据来源标注仍在 system 前缀');
});

test('A1-02 动态尾块承载时间上下文，随 run 变化', () => {
  const t1 = buildDynamicTurnContext({ timeContext: buildTimeContext(nowOf('2026-10-31T09:00:00+08:00'), intentOf(), '第 8 教学周'), injectionSuspected: false });
  const t2 = buildDynamicTurnContext({ timeContext: buildTimeContext(nowOf('2026-10-31T09:01:00+08:00'), intentOf(), '第 8 教学周'), injectionSuspected: false });
  assert.ok(t1.includes('【服务端当前时间】'), '时间上下文必须在尾块里');
  assert.notEqual(t1, t2, '不同时刻的尾块必须不同（证明动态内容已移出前缀）');
});

test('A1-03 注入疑似声明在尾块，且默认不在前缀', () => {
  const withNote = buildDynamicTurnContext({ timeContext: '【服务端当前时间】x', injectionSuspected: true });
  const withoutNote = buildDynamicTurnContext({ timeContext: '【服务端当前时间】x', injectionSuspected: false });
  assert.ok(withNote.includes('# 安全提示'));
  assert.ok(!withoutNote.includes('# 安全提示'));
  const system = buildSystemPrompt({ toolList: TOOL_LIST, sourceTypeLabel: '演示快照' });
  assert.ok(!system.includes('# 安全提示'), '前缀不得含注入声明（它会随 run 变化）');
});

test('A1-04 组装契约：前缀跨 run 字节一致，尾块随 run 变化', () => {
  const runA = assembleMessages(nowOf('2026-10-31T09:00:00+08:00'), false);
  const runB = assembleMessages(nowOf('2026-10-31T09:01:00+08:00'), false);
  assert.equal(runA.length, runB.length);
  // 前缀 = 除最后一条（动态尾块）外的全部消息，逐条字节比对
  for (let i = 0; i < runA.length - 1; i += 1) {
    assert.equal(JSON.stringify(runA[i]), JSON.stringify(runB[i]), `消息 ${i} 属于可缓存前缀，必须跨 run 一致`);
  }
  assert.notEqual(runA.at(-1)?.content, runB.at(-1)?.content, '尾块随 run 变化');
  assert.equal(runA.at(-1)?.role, 'system');
});

test('A1-05 版本号已随前缀重构递增', () => {
  assert.ok(PROMPT_VERSION.startsWith('labops-1.0.7'), `PROMPT_VERSION 应递增（当前 ${PROMPT_VERSION}）`);
});
