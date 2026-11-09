/**
 * routeTurn 单一裁决点（整合方案 §4）——每条规则的命中样例与反例
 * 运行：node --test tests/route-turn.test.ts
 */
process.env.LABOPS_SKIP_ENV_FILE = '1';
process.env.LABOPS_AUTH_MODE = 'demo';
for (const k of Object.keys(process.env)) if (/API_KEY|API_SECRET/.test(k)) delete process.env[k];

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { routeTurn } = await import('../server/agent/route-turn.ts');

const base = { hasContext: false, engineDemo: false };
const turn = (question: string, extra: Partial<typeof base> = {}) => routeTurn({ question, ...base, ...extra });

test('R1 寒暄走范围引导快速通道（capabilities 话术），混合问句不再是寒暄', () => {
  const hi = turn('你好');
  assert.equal(hi.kind, 'scope');
  assert.equal(hi.domain, 'capabilities');
  assert.ok(hi.smalltalk);
  assert.ok(hi.reason.length > 0, 'reason 必须能解释判定');
  const mixed = turn('你好，E310今天有课吗');
  assert.equal(mixed.kind, 'agent');
  assert.equal(mixed.smalltalk, false, '带具体业务实体的问句不得按寒暄兜底');
});

test('R2 签到红线确定性婉拒：代签/补录拦截，纯查询不误伤', () => {
  const lend = turn('替张同学签到');
  assert.equal(lend.kind, 'sign_refusal');
  assert.ok(lend.signRefusal && lend.signRefusal.includes('本人'), '婉拒话术须说明须本人扫码');
  assert.equal(lend.singlePassEligible('query_checkin_status', 1), true, '红线判定不影响其他字段');
  const ask = turn('查一下今天的签到情况');
  assert.equal(ask.kind, 'agent');
  assert.equal(ask.signRefusal, null, '纯查询不得被红线误伤（动作子句不命中查询词）');
});

test('R3 找空闲不继承房间上下文；房间状态问句保留任务提示', () => {
  const free = turn('哪些实验室现在空着');
  assert.ok(free.roomless, '找空闲是范围语义，不得承接上一问的房间');
  assert.equal(free.taskHint, 'free_rooms');
  const status = turn('E310现在有多少人');
  assert.equal(status.roomless, false);
  assert.equal(status.taskHint, 'lab_status');
  const sched = turn('查E310课表');
  assert.equal(sched.taskHint, 'schedule');
  assert.equal(turn('今天谁值班').taskHint, null, '识别不出任务类型就返回 null，不猜');
});

test('R4 单程往返白名单：只读单调用允许；多调用/多意图/写工具/开关关闭都不允许', () => {
  const one = turn('查E310在2026-09-28的课表');
  assert.equal(one.singlePassEligible('query_schedule', 1), true);
  assert.equal(one.singlePassEligible('query_schedule', 2), false, '多调用说明还要更多信息');
  assert.equal(one.singlePassEligible('prepare_issue_ticket', 1), false, '写类工具绝不单程定稿');
  const multi = turn('查E310课表，再看看E312');
  assert.equal(multi.singlePassEligible('query_schedule', 1), false, '多意图标记命中就走第二轮');
  process.env.AGENT_SINGLE_PASS = '0';
  try {
    assert.equal(one.singlePassEligible('query_schedule', 1), false, '开关一键回退');
  } finally {
    delete process.env.AGENT_SINGLE_PASS;
  }
});

test('R5 越界问句无上下文时范围引导；上下文追问放行归模型', () => {
  const out = turn('讲个笑话');
  assert.equal(out.kind, 'scope');
  assert.equal(out.domain, 'redirect');
  const follow = turn('那明天天气呢', { hasContext: true });
  assert.equal(follow.kind, 'agent', '有上下文的追问按批1口径放行，由模型判断——裁决点必须与门控一致');
});

test('R6 演示引擎标记只影响 reason，不改变 kind 判定', () => {
  const demo = turn('查E310课表', { engineDemo: true });
  assert.equal(demo.kind, 'agent');
  assert.match(demo.reason, /演示引擎/);
  assert.match(turn('查E310课表').reason, /模型/);
});
