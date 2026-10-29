/**
 * 质量指标自测 —— 指标本身不可信，报出来的数字就没有意义。
 * 运行：node --test tests/quality-metrics.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimNumbers, checkHallucination, checkCitations, summarize } from '../shared/quality-metrics.ts';

test('结构化定位与自述数字不算业务断言', () => {
  const nums = claimNumbers('依据 schedule-adjustment §3（v20261004.2，2026-10-29 15:00 查询，置信度 62%）');
  assert.deepEqual(nums, [], '§N、版本号、日期、时间、百分比都不应被当作需出处的数字');
});

test('业务数字有出处 → clean；无出处 → suspect 并报出该数字', () => {
  const facts = [{ result: { capacity: 100, lessons: [{ id: 'T1' }] }, summary: '有 7 条排课' }];
  const ok = checkHallucination('E310 容量 100 人，今天有 7 节安排。', facts);
  assert.equal(ok.verdict, 'clean', JSON.stringify(ok));

  const bad = checkHallucination('E310 容量 120 人。', facts);
  assert.equal(bad.verdict, 'suspect');
  assert.deepEqual(bad.unsupported, ['120']);
});

test('房间号等字母数字标识不得被拆成"无出处数字"（否则幻觉率虚高）', () => {
  assert.deepEqual(claimNumbers('E310、D517、T12、att-7f3a 的容量 100 人'), ['100']);
});

test('本轮没有任何工具事实却说出了数字 → 直接判 suspect（凭空生成）', () => {
  const r = checkHallucination('这间实验室大约能坐 40 人。', []);
  assert.equal(r.verdict, 'suspect');
  assert.deepEqual(r.unsupported, ['40']);
});

test('本轮无事实且无数字 → no-facts，不参与幻觉率统计（拒答本就无事实）', () => {
  const r = checkHallucination('本阶段做不到：这需要现场核实。', []);
  assert.equal(r.verdict, 'no-facts');
  assert.equal(r.checked, 0);
});

test('回归：hits 只含部分段落时，不得拿它当"文档总段数"误判越界', () => {
  // 段落级检索改造后，hits.paragraphs 只带命中的 ≤4 段，locator 仍是原文序号
  const partial = [{ id: 'occupancy', paragraphs: [{ locator: '§2' }, { locator: '§5' }, { locator: '§7' }] }];
  // 不传真值：以命中段落最大 §N 为下界，§7 合法
  assert.equal(checkCitations('见 occupancy §7。', partial).bad.length, 0, '命中过的段落序号不得判越界');
  // 传真值：文档共 9 段，§9 合法、§10 越界
  assert.equal(checkCitations('见 occupancy §9。', partial, { occupancy: 9 }).bad.length, 0);
  assert.equal(checkCitations('见 occupancy §10。', partial, { occupancy: 9 }).bad.length, 1);
});

test('引用判定：文档不在命中集、段落越界都要报出来', () => {
  const hits = [{ id: 'notice', paragraphs: [{ locator: '§1' }, { locator: '§2' }] }];
  assert.equal(checkCitations('见 notice §2。', hits).bad.length, 0);
  assert.equal(checkCitations('见 notice §5。', hits).bad.length, 1, '段落越界');
  assert.equal(checkCitations('见 ghost-doc §1。', hits).bad.length, 1, '文档不在命中集');
  assert.equal(checkCitations('见 §2。', hits).bad.length, 0, '省略文档名时只要任一命中含该段即可');
  assert.equal(checkCitations('见 §9。', hits).bad.length, 1);
});

test('汇总：分母为 0 时返回 null，不写成 0 分', () => {
  const s = summarize(
    [{ hallucination: checkHallucination('容量 100 人', [{ result: { capacity: 100 } }]), citation: { checked: 0, bad: [] } }],
    { expected: 0, honoured: 0 }
  );
  assert.equal(s.hallucination.rate, 0);
  assert.equal(s.citation.accuracy, null, '没有引用可查时必须报 null，而不是 100% 或 0%');
  assert.equal(s.refusal.rate, null);
});

test('汇总数字可复核：3 项里 1 项可疑 = 33.3%', () => {
  const rows = [
    { hallucination: checkHallucination('容量 100 人', [{ result: { capacity: 100 } }]), citation: { checked: 1, bad: [] } },
    { hallucination: checkHallucination('容量 999 人', [{ result: { capacity: 100 } }]), citation: { checked: 1, bad: [{ ref: '§9', reason: 'x' }] } },
    { hallucination: checkHallucination('有 5 台设备', [{ result: { devices: 5 } }]), citation: { checked: 0, bad: [] } }
  ];
  const s = summarize(rows, { expected: 4, honoured: 4 });
  assert.equal(s.hallucination.checked, 3);
  assert.equal(s.hallucination.suspect, 1);
  assert.ok(Math.abs((s.hallucination.rate ?? 0) - 1 / 3) < 1e-9);
  assert.ok(Math.abs((s.citation.accuracy ?? 0) - 0.5) < 1e-9, '2 条有引用的样本里 1 条错');
  assert.equal(s.refusal.rate, 1);
});
