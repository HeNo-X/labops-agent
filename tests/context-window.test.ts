/**
 * 结构感知的工具结果窗口 —— 不做字符数盲切
 * ============================================================================
 *  参考 SWE-agent ACI（observation windowing）：截断必须让模型知道
 *  「后面还有数据」「共有多少条」「下一步怎么拿到」，且绝不能把 JSON
 *  腰斩成残缺记录。按固定字符数盲切会让模型看到半个课表却以为
 *  只有那几条，读到的是截断留下的残缺数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyContextBudget, slimToolMessage } from '../server/agent/context-budget.ts';
import type { ChatMessage } from '../server/llm/agnes.ts';

const CFG_FORCE = {
  enabled: true,
  window: 200,
  outputReserve: 40,
  circuitBreakerAfter: 3,
  thresholdRatio: 0.5
};

function toolMsg(content: string): ChatMessage {
  return { role: 'tool', tool_call_id: 'tc1', content };
}

function bigScheduleData(items: number): unknown {
  return {
    labName: 'E310',
    date: '2026-10-31',
    lessons: Array.from({ length: items }, (_, i) => ({
      periodKey: `am${(i % 4) + 1}`,
      className: `Class-${i}`,
      courseName: `Course-${i}`
    })),
    provenance: { sourceType: 'snapshot' }
  };
}

test('A3-01 大数组开窗：保前 8 项 + dataNote 带总数与省略量，且裁后仍是合法 JSON', () => {
  const m = toolMsg(JSON.stringify({ ok: true, summary: '查询到 100 条课表记录', data: bigScheduleData(100), dataSource: '演示快照', reminder: '只能依据本结果作答' }));
  const slim = slimToolMessage(m);
  assert.notEqual(slim, m, '超长消息必须被瘦身');
  // 关键契约：裁剪后的内容必须仍是合法 JSON（按字符腰斩就会坏掉）
  const parsed = JSON.parse(String(slim.content)) as Record<string, unknown>;
  const data = parsed['data'] as { lessons: unknown[] };
  assert.equal(data.lessons.length, 8, '数组只保留前 8 项');
  const note = String(parsed['dataNote']);
  assert.match(note, /lessons（共 100 条，已省略 92 条）/);
  assert.match(note, /缩小查询范围/);
  assert.equal(parsed['summary'], '查询到 100 条课表记录', '结论段 summary 必须保留');
  assert.equal(parsed['ok'], true);
  assert.equal(parsed['dataSource'], '演示快照');
  assert.equal(parsed['reminder'], '只能依据本结果作答');
});

test('A3-02 嵌套对象里的数组同样被开窗，路径如实标注', () => {
  const data = { report: { sections: Array.from({ length: 30 }, (_, i) => ({ id: i, text: 'x'.repeat(30) })) } };
  const m = toolMsg(JSON.stringify({ ok: true, summary: '报告', data }));
  const slim = slimToolMessage(m);
  assert.notEqual(slim, m, '消息必须超过 1200 字才触发瘦身（本用例先保证这一点）');
  const parsed = JSON.parse(String(slim.content)) as { data: { report: { sections: unknown[] } }; dataNote: string };
  assert.equal(parsed.data.report.sections.length, 8);
  assert.match(parsed.dataNote, /data\.report\.sections（共 30 条，已省略 22 条）/);
});

test('A3-03 开窗后仍超长才字符截断兜底，并如实标注原始长度', () => {
  const data = { blob: 'z'.repeat(4000) };
  const m = toolMsg(JSON.stringify({ ok: true, summary: '大文本', data }));
  const slim = slimToolMessage(m);
  assert.ok(String(slim.content).length <= 1200 + 60, '兜底后必须短于保留线（含标注）');
  assert.match(String(slim.content), /已精简：原始长度 \d+ 字/);
});

test('A3-04 非 JSON 内容回退旧行为（字符截断 + 标注），不抛异常', () => {
  const m = toolMsg('这不是 JSON'.repeat(400));
  const slim = slimToolMessage(m);
  assert.ok(String(m.content).length >= 3000, '前置：原消息确实超长');
  assert.ok(String(slim.content).length < 1400, '回退路径按保留线截断');
  assert.match(String(slim.content), /已精简：原始长度/);
});

test('A3-05 短消息原样返回（瘦身不碰小消息）', () => {
  const m = toolMsg(JSON.stringify({ ok: true, summary: '一条', data: { a: 1 } }));
  assert.equal(slimToolMessage(m), m, '同引用返回，未做任何加工');
});

test('A3-06 集成：超阈值时走开窗路径且决策如实计数', () => {
  const big = toolMsg(JSON.stringify({ ok: true, summary: '查询到 100 条课表记录', data: bigScheduleData(100), dataSource: '演示快照' }));
  const messages: ChatMessage[] = [
    { role: 'system', content: '系统提示（保留）' },
    big,
    { role: 'user', content: 'E310 今天有哪些课？' }
  ];
  const failures = { consecutive: 0 };
  const out = applyContextBudget(messages, CFG_FORCE, failures);
  assert.equal(out.decision.shouldTrim, true);
  assert.equal(out.decision.reason, 'above_threshold');
  assert.ok(out.decision.trimmed.toolResultsDropped >= 1, '精简计数必须如实反映');
  const slimmed = out.messages[1]!;
  const parsed = JSON.parse(String(slimmed.content)) as Record<string, unknown>;
  assert.ok(Array.isArray((parsed['data'] as { lessons: unknown[] }).lessons));
  // system 与 user 正文不动（A3 只碰 tool 消息）
  assert.equal(out.messages[0]!.content, '系统提示（保留）');
  assert.equal(out.messages[2]!.content, 'E310 今天有哪些课？');
});

test('A3-07 未超阈值时完全不精简（绝不预先删东西）', () => {
  const small = toolMsg(JSON.stringify({ ok: true, summary: '小结果', data: { a: 1 } }));
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, small, { role: 'user', content: 'q' }];
  const out = applyContextBudget(messages, CFG_FORCE, { consecutive: 0 });
  assert.equal(out.decision.shouldTrim, false);
  assert.equal(out.messages[1], small, '同引用返回');
});
