/**
 * 方案B（上下文继承改造）纯函数单测 —— docs/上下文继承改造-方案B-20261108.md §6
 * ============================================================================
 *  断言三层职责划分的核心机制：
 *    1. hints 模式下 carried 线索**只进 intent.hints、不写槽位**（沿用与否归模型）；
 *    2. 班级明确时与房间互斥（不产生房间的 carried 线索）；
 *    3. legacy 模式（CONTEXT_HINTS=0 对应 hintsMode:false）保持旧的写槽位行为；
 *    4. 确定性引擎入口 applyHintsToSlots 把 carried 线索落回槽位（与旧继承一致）；
 *    5. buildTimeContext 在有线索时输出"线索不是结论"+ 沿用纪律 + 互斥规则话术。
 *
 *  用例输入选「然后呢」：parseIntent 对它四个槽位全空——carried 线索才是唯一来源。
 *  全部纯函数、零网络、零模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHintsToSlots, applySessionCarry, buildTimeContext, parseIntent, type Intent, type IntentHint } from '../server/agent/intent.ts';
import type { ServerNow } from '../server/time/term.ts';

const NOW = {
  iso: '2026-11-08T14:00:00+08:00',
  date: '2026-11-08',
  weekday: 0,
  weekdayLabel: '周日'
} as unknown as ServerNow;

const SESS = { labName: 'E310', date: '2026-09-28', question: '查 E310 今天的课' };

function baseIntent(text: string): Intent {
  return parseIntent(text, NOW);
}

function hintsOf(intent: Intent): IntentHint[] {
  return intent.hints ?? [];
}

test('B1 hints 模式：carried 线索只进 hints，槽位保持空', () => {
  const intent = baseIntent('然后呢');
  applySessionCarry(intent, SESS, { roomlessIntent: false, hintsMode: true });
  const lab = hintsOf(intent).find((h) => h.slot === 'labName');
  const date = hintsOf(intent).find((h) => h.slot === 'date');
  assert.equal(intent.labName, null, '房间槽位必须为空——沿用与否由模型判断');
  assert.equal(intent.date, null, '日期槽位必须为空');
  assert.equal(lab?.origin, 'carried');
  assert.equal(lab?.value, 'E310');
  assert.match(lab?.basis ?? '', /上一问/);
  assert.match(lab?.basis ?? '', /按上一问的房间 E310 计算/);
  assert.equal(date?.origin, 'carried');
  assert.equal(date?.value, '2026-09-28');
});

test('B2 班级明确时与房间互斥：不产生房间的 carried 线索', () => {
  const intent = baseIntent('智能本2501班的课表');
  assert.ok(intent.className, '前置：班级要能被解析出来');
  applySessionCarry(intent, SESS, { roomlessIntent: false, hintsMode: true });
  assert.equal(hintsOf(intent).find((h) => h.slot === 'labName'), undefined, '班级与房间互斥——不得给出房间的 carried 线索');
  assert.equal(intent.labName, null);
});

test('B3 找空闲房间/寒暄不承接（F13 纪律在 hints 模式下保持）', () => {
  for (const q of ['现在有哪些空闲机房', '你好呀']) {
    const intent = baseIntent(q);
    applySessionCarry(intent, SESS, { roomlessIntent: true, hintsMode: true });
    assert.equal(hintsOf(intent).length, 0, `${q} 不得给出任何线索`);
  }
});

test('B4 legacy 模式（CONTEXT_HINTS=0）：保持旧的写槽位行为', () => {
  const intent = baseIntent('然后呢');
  applySessionCarry(intent, SESS, { roomlessIntent: false, hintsMode: false });
  assert.equal(intent.labName, 'E310', '旧行为：房间直接写入槽位');
  assert.equal(intent.date?.date, '2026-09-28');
  assert.equal(intent.date?.source.includes('沿用上一问'), true);
  assert.equal(hintsOf(intent).length, 0, '旧模式不产生线索');
  assert.ok(intent.notes.some((n) => n.includes('沿用上一问')), '留痕纪律不变');
});

test('B5 非法日期绝不承接（dateInvalid 分支在两种模式下都生效）', () => {
  const intent = baseIntent('查询E310在2026-02-30的课表');
  assert.ok(intent.dateInvalid, '前置：非法日期要被解析器拦下');
  applySessionCarry(intent, SESS, { roomlessIntent: false, hintsMode: true });
  assert.equal(hintsOf(intent).length, 0);
  applySessionCarry(intent, SESS, { roomlessIntent: false, hintsMode: false });
  assert.equal(intent.date, null, '非法日期不得被上一问日期覆盖');
  assert.equal(intent.labName, 'E310', '本例房间是显式解析——理应保留；不承接的只是日期')
});

test('B6 applyHintsToSlots：确定性引擎把 carried 线索落回槽位（与旧继承一致）', () => {
  const intent = baseIntent('然后呢');
  applySessionCarry(intent, SESS, { roomlessIntent: false, hintsMode: true });
  assert.equal(intent.labName, null);
  applyHintsToSlots(intent);
  assert.equal(intent.labName, 'E310');
  assert.equal(intent.date?.date, '2026-09-28');
  assert.ok(intent.notes.filter((n) => n.includes('沿用上一问')).length >= 2, '落回槽位必须留痕');
});

test('B7 applyHintsToSlots 对 explicit 槽位不覆盖', () => {
  const intent = baseIntent('查 E312 明天的课');
  (intent.hints ??= []).push({ slot: 'labName', value: 'E310', origin: 'carried', basis: '不该生效' });
  applyHintsToSlots(intent);
  assert.equal(intent.labName, 'E312', '本轮明确的房间不被 carried 线索覆盖');
});

test('B8 buildTimeContext：有线索时输出"线索不是结论"+ 沿用纪律', () => {
  const intent = baseIntent('然后呢');
  applySessionCarry(intent, SESS, { roomlessIntent: false, hintsMode: true });
  const text = buildTimeContext(NOW, intent, '第 9 教学周（单周）');
  assert.match(text, /【本句可用的线索】/);
  assert.match(text, /线索不是结论/);
  assert.match(text, /【沿用纪律】/);
  assert.match(text, /依据说明/);
  assert.match(text, /上一问用的是 2026-09-28/);
  assert.match(text, /上一问用的是 E310/);
  assert.doesNotMatch(text, /【已识别的房间号】/, 'carried 不得伪装成"已识别"');
});

test('B9 buildTimeContext：班级明确 + 有 carried 时输出互斥规则', () => {
  const intent = baseIntent('智能本2501班的课表');
  (intent.hints ??= []).push({ slot: 'date', value: '2026-09-28', origin: 'carried', basis: '上一问日期' });
  const text = buildTimeContext(NOW, intent, '第 9 教学周（单周）');
  assert.match(text, /【规则】班级与房间互斥/);
  assert.match(text, /按班级查询/);
});

test('B10 buildTimeContext：无线索时保持旧话术（回归基线）', () => {
  const intent = baseIntent('查询E310在2026-09-28的课表');
  const text = buildTimeContext(NOW, intent, '第 4 教学周');
  assert.match(text, /【已识别的房间号】E310/);
  assert.match(text, /【已解算的日期指代】/);
  assert.doesNotMatch(text, /【本句可用的线索】/);
});
