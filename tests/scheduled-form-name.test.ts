/**
 * A-G3：规则名保留用户原话短语（对标 ZCode：title 保留自然语言日程短语）
 * ============================================================================
 *  锁死：仅 agent_prompt 参与；空名/上次自动名/模板名三种情况下跟随原话前
 *  16 字（超出加省略号）；用户改过名绝不覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRuleName } from '../web/business/scheduled-form.ts';

test('A-G3-01 agent 模板：空名/上次自动名/模板名 → 跟随原话前 16 字', () => {
  const prompt = '每天早上 8 点给我发昨天的日报，并总结要点';
  assert.equal(autoRuleName('agent_prompt', prompt, '', '', '自定义指令'), '每天早上 8 点给我发昨天的日报…', '前 16 个码元 + 省略号');
  assert.equal(autoRuleName('agent_prompt', prompt, '自定义指令', '自定义指令', '自定义指令'), '每天早上 8 点给我发昨天的日报…', '模板名占位也会被原话替换');
  const short = autoRuleName('agent_prompt', '帮我查课', '自定义指令', '', '自定义指令');
  assert.equal(short, '帮我查课', '不足 16 字不加省略号');
});

test('A11-G3-02 用户改过名 → 绝不覆盖（返回 null 保持现名）', () => {
  const prompt = '每天早上 8 点给我发昨天的日报';
  assert.equal(autoRuleName('agent_prompt', prompt, '我的晨报', '自定义指令', '自定义指令'), null);
});

test('A11-G3-03 非 agent 模板 / 空正文 → 不参与自动命名', () => {
  assert.equal(autoRuleName('daily_report', '随便写点什么', '', '', '每日运行报告'), null);
  assert.equal(autoRuleName('agent_prompt', '   ', '', '自定义指令', '自定义指令'), null);
  assert.equal(autoRuleName('agent_prompt', undefined, '', '自定义指令', '自定义指令'), null);
});

test('A11-G3-04 原话中的空白折叠后再截断（不把换行带进名字）', () => {
  const out = autoRuleName('agent_prompt', '查一下今天的课\n然后用一句话总结', '', '', '自定义指令');
  assert.equal(out, '查一下今天的课 然后用一句话总结');
  assert.ok(!out!.includes('\n'));
});
