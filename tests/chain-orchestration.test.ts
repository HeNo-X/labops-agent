/**
 * 确定性链编排 —— 单元回归
 * ============================================================================
 *  为什么测：这条链存在的唯一理由是"省掉模型的多轮机械往返"。省时间不能靠少做事，
 *  所以这里把三件事钉死：
 *    ① 前置参数不齐时**一步都不许执行**（交回模型，绝不替用户猜日期/节次/房间）；
 *    ② 候选不唯一、有阻塞、搜索被截断时**停在 analyze**，把选择权交回人；
 *    ③ 全程不出现 plans/commit —— 链只准备方案，确认权在用户。
 *
 *  运行：node --test tests/chain-orchestration.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectChain, runChain } = await import('../server/agent/chain-plan.ts');

const ds = { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-d517', name: 'D517' }], openLabs: [{ id: 'ol-d517', name: 'D517' }] } as never;
const now = { iso: '2026-11-10T09:00:00+08:00', date: '2026-11-10', time: '09:00:00', weekday: 2, weekdayLabel: '周二' } as never;

const intent = (over: Record<string, unknown> = {}) => ({
  date: { date: '2026-11-12', raw: '2026-11-12', source: 'explicit' },
  dateInvalid: null, periodKey: null, periodKeys: ['pm1'],
  labName: 'E310', className: null, ...over
}) as never;

const Q = 'E310 在 2026-11-12 下午第一大节投影仪没有信号，帮我登记故障事件并准备联合处置方案';

/** 主系统各步的返回体，形状照 shared/business.ts 的 NativeIncidentSet/NativePlan */
function responses(over: { options?: Array<{ id: string }>; blocked?: string[]; truncated?: boolean; draftFail?: { code: string; message: string } } = {}) {
  const set = {
    id: 'set-1', taskId: 'task-1', kind: 'incident.bundle', incidentId: 'incident-1',
    options: over.options ?? [{ id: 'opt-1' }], blocked: over.blocked ?? [],
    search: { nodes: 4, limit: 50, truncated: over.truncated === true }
  };
  return {
    draft: over.draftFail ? { ok: false, code: over.draftFail.code, message: over.draftFail.message }
      : { ok: true, resultKind: 'business_plan', summary: '草稿已保存', result: { incident: { id: 'incident-1', revision: 1 }, plan: null } },
    analyze: { ok: true, resultKind: 'business_plan', summary: '候选已分析', result: { incidentSet: set } },
    preview: { ok: true, resultKind: 'business_plan', summary: '方案已准备', result: { plan: { id: 'plan-1', state: 'awaiting_confirmation' }, impact: { activityCount: 1 } } }
  };
}

function harness(spy: Array<{ tool: string; args?: Record<string, unknown> }>, r: ReturnType<typeof responses>) {
  return async (tool: string, args: Record<string, unknown>) => {
    spy.push({ tool, args });
    const step = args.action === 'draft' ? r.draft : args.action === 'analyze' ? r.analyze : r.preview;
    return step as never;
  };
}

test('D1 只说报修不要求方案 → 不进链（交回模型，它可能一步就够）', () => {
  assert.equal(detectChain({ question: 'E310 投影仪没有信号，帮我报修', mode: 'task' }), null);
  assert.equal(detectChain({ question: 'E310 在 2026-11-12 下午第一大节投影仪没有信号，登记故障事件并准备联合处置方案', mode: 'task' }), 'incident_joint');
  assert.equal(detectChain({ question: 'E310 投影仪没有信号，准备联合处置方案', mode: 'chat' }), null, '聊天模式不办理');
  assert.equal(detectChain({ question: 'E310 今天天气不错，准备联合处置方案', mode: 'task' }), null, '没有故障征象不进链');
});

test('D2 开关一键回退纯模型链', () => {
  process.env.AGENT_CHAIN_ORCHESTRATION = '0';
  try {
    assert.equal(detectChain({ question: Q, mode: 'task' }), null);
  } finally {
    delete process.env.AGENT_CHAIN_ORCHESTRATION;
  }
});

test('D3 参数不齐一律零执行并交回模型（缺日期/缺节次/缺事实/房间歧义/房间不存在）', async () => {
  const cases: Array<[string, never]> = [
    ['缺日期', intent({ date: null })],
    ['缺节次', intent({ periodKeys: null, periodKey: null })],
    ['房间两处登记', intent({ labName: 'D517' })],
    ['没有房间', intent({ labName: null })]
  ];
  for (const [label, it] of cases) {
    const spy: Array<{ tool: string }> = [];
    const out = await runChain('incident_joint', { question: Q, intent: it, ds, now, mode: 'task', execute: async (tool) => { spy.push({ tool }); return { ok: true, resultKind: 'business_plan', summary: '', result: {} } as never; } });
    assert.equal(out.steps.length, 0, `${label}：不该执行任何一步`);
    assert.equal(out.answer, null, `${label}：交回模型时不该有正文`);
    assert.ok(out.stoppedReason, `${label}：要说明为什么不做`);
  }
  // 用户没说故障事实（只有设备名）也不开工
  const spy: Array<{ tool: string }> = [];
  const noFact = await runChain('incident_joint', { question: 'E310 在 2026-11-12 下午第一大节，登记故障事件并准备联合处置方案', intent: intent(), ds, now, mode: 'task', execute: async (tool) => { spy.push({ tool }); return { ok: true, resultKind: 'business_plan', summary: '', result: {} } as never; } });
  assert.equal(noFact.steps.length, 0);
  assert.match(String(noFact.stoppedReason), /故障事实/);
});

test('D4 唯一候选走满三步，正文把"尚未写入、确认权在你"说清', async () => {
  const spy: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const out = await runChain('incident_joint', { question: Q, intent: intent(), ds, now, mode: 'task', execute: harness(spy, responses()) });
  assert.equal(out.steps.length, 3);
  assert.deepEqual(spy.map(s => (s.args as { action: string }).action), ['draft', 'analyze', 'preview']);
  assert.equal(spy[0]!.args.roomId, 'lab-e310');
  assert.deepEqual(spy[0]!.args.periodKeys, ['pm1']);
  assert.equal(spy[0]!.args.description, 'E310 在 2026-11-12 下午第一大节投影仪没有信号', '故障事实必须用用户原话，不改写');
  assert.equal(spy[1]!.args.incidentId, 'incident-1');
  assert.equal(spy[1]!.args.expectedRevision, 1, 'analyze 要带事件版本');
  assert.equal(spy[1]!.args.preference, 'keep_period');
  assert.equal(spy[2]!.args.candidateSetId, 'set-1');
  assert.equal(spy[2]!.args.optionId, 'opt-1');
  assert.equal(out.awaitingConfirmation, true);
  assert.match(out.answer!, /plan-1/);
  assert.match(out.answer!, /尚未写入主系统/);
  assert.match(out.answer!, /确认权在你/);
  assert.match(out.answer!, /默认/);
});

test('D5 候选不唯一 / 有阻塞 / 搜索截断 → 停在 analyze，不替用户挑', async () => {
  for (const [label, over] of [
    ['两个候选', { options: [{ id: 'opt-1' }, { id: 'opt-2' }] }],
    ['有阻塞', { blocked: ['目标房间容量不足'] }],
    ['搜索被截断', { truncated: true }]
  ] as Array<[string, { options?: Array<{ id: string }>; blocked?: string[]; truncated?: boolean }]>) {
    const spy: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    const out = await runChain('incident_joint', { question: Q, intent: intent(), ds, now, mode: 'task', execute: harness(spy, responses(over)) });
    assert.equal(out.steps.length, 2, `${label}：只该执行到 analyze`);
    assert.equal(out.awaitingConfirmation, false, `${label}：没有方案卡可确认`);
    assert.match(out.answer!, /我不会替你选/);
    if (label === '两个候选') assert.match(out.answer!, /2 个候选/);
  }
});

test('D6 任一步失败就地停下，错误码如实上报（不掩盖半提交）', async () => {
  const spy: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const out = await runChain('incident_joint', {
    question: Q, intent: intent(), ds, now, mode: 'task',
    execute: harness(spy, responses({ draftFail: { code: 'bad_period', message: '请选择故障影响节次' } }))
  });
  assert.equal(out.steps.length, 1);
  assert.equal(out.answer, null, '失败交由上层生成如实文案');
  assert.match(String(out.stoppedReason), /bad_period/);
  assert.match(String(out.stoppedReason), /请选择故障影响节次/);
});

test('D7 红线：整条链不许出现 plans/commit 或任何确认动作', async () => {
  const spy: Array<{ tool: string; args: Record<string, unknown> }> = [];
  await runChain('incident_joint', { question: Q, intent: intent(), ds, now, mode: 'task', execute: harness(spy, responses()) });
  const names = spy.map(s => s.tool);
  assert.deepEqual([...new Set(names)], ['prepare_incident_plan']);
  assert.ok(!names.some(n => /commit|confirm|apply/i.test(n)), `链里出现了执行类工具：${names.join(',')}`);
  assert.ok(spy.every(s => !('planId' in s.args)), '不许直接提交方案编号');
});

test('D8 偏好可被用户话术改变，且默认值在正文里写明是默认', async () => {
  for (const [q, want] of [
    ['E310 在 2026-11-12 下午第一大节投影仪没有信号，登记故障事件并准备联合处置方案，尽量少用房间', 'few_rooms'],
    ['E310 在 2026-11-12 下午第一大节投影仪没有信号，登记故障事件并准备联合处置方案，希望尽早结束', 'early'],
    ['E310 在 2026-11-12 下午第一大节投影仪没有信号，登记故障事件并准备联合处置方案', 'keep_period']
  ] as Array<[string, string]>) {
    const spy: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const out = await runChain('incident_joint', { question: q, intent: intent(), ds, now, mode: 'task', execute: harness(spy, responses()) });
    assert.equal(spy[1]!.args.preference, want, q.slice(-12));
    if (want === 'keep_period') assert.match(out.answer!, /默认/);
  }
});

// ============================ 调课提案链 ============================

const scheduleResult = (lessons: Array<{ timetableId: string; periodKey: string; courseName: string; className?: string }>) => ({
  ok: true, resultKind: 'schedule', summary: '课表已查询', result: { lessons, reason: 'ok' }
}) as never;

function moveHarness(spy: Array<{ tool: string; args?: Record<string, unknown> }>, opts: { lessons?: Array<{ timetableId: string; periodKey: string; courseName: string; className?: string }>; prepareFail?: { code: string; message: string } } = {}) {
  return async (tool: string, args: Record<string, unknown>) => {
    spy.push({ tool, args });
    if (tool === 'query_schedule') return scheduleResult(opts.lessons ?? [{ timetableId: 'tt-1', periodKey: 'pm1', courseName: '示例程序设计', className: '测试示例班' }]);
    if (opts.prepareFail) return { ok: false, code: opts.prepareFail.code, message: opts.prepareFail.message } as never;
    return { ok: true, resultKind: 'business_plan', summary: '方案已准备', result: { plan: { id: 'plan-move-1', state: 'awaiting_confirmation' } } } as never;
  };
}

const MOVE_Q = '把 E310 在 2026-11-12 下午第一大节的课调到 E312，因为投影仪故障';

test('E1 检测分流：调课话术进 schedule_move，故障+方案进 incident_joint，其余不进链', () => {
  assert.equal(detectChain({ question: MOVE_Q, mode: 'task' }), 'schedule_move');
  assert.equal(detectChain({ question: 'E310 投影仪没有信号，登记故障事件并准备联合处置方案', mode: 'task' }), 'incident_joint');
  assert.equal(detectChain({ question: 'E310 今天下午有谁签到', mode: 'task' }), null, '纯查询不该进办理链');
  assert.equal(detectChain({ question: MOVE_Q, mode: 'chat' }), null, '聊天模式不办理');
});

test('E2 原因/目标缺失一律零执行并交回模型问用户', async () => {
  for (const [label, q] of [
    ['没说原因', '把 E310 在 2026-11-12 下午第一大节的课调到 E312'],
    ['没说目标房间', '把 E310 在 2026-11-12 下午第一大节的课换一间教室，因为投影仪故障'],
    ['目标说了两间', '把 E310 在 2026-11-12 下午第一大节的课调到 E312 或 E315，因为投影仪故障']
  ] as Array<[string, string]>) {
    const spy: Array<{ tool: string }> = [];
    const out = await runChain('schedule_move', { question: q, intent: intent(), ds: { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-e312', name: 'E312' }, { id: 'lab-e315', name: 'E315' }], openLabs: [] } as never, now, mode: 'task', execute: async (tool) => { spy.push({ tool }); return { ok: true, resultKind: 'schedule', summary: '', result: { lessons: [] } } as never; } });
    assert.equal(out.steps.length, 0, `${label}：不许先查了再说`);
    assert.equal(out.answer, null, `${label}：交回模型时不该有正文`);
    assert.ok(out.stoppedReason, label);
  }
});

test('E3 正常链两步走通，未说新节次时保持原节次并在正文写明', async () => {
  const spy: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const out = await runChain('schedule_move', {
    question: MOVE_Q, intent: intent(), ds: { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-e312', name: 'E312' }], openLabs: [] } as never, now, mode: 'task',
    execute: moveHarness(spy)
  });
  assert.deepEqual(spy.map(s => s.tool), ['query_schedule', 'prepare_schedule_adjustment']);
  assert.equal(spy[1]!.args.timetableId, 'tt-1');
  assert.equal(spy[1]!.args.toLabId, 'lab-e312', '目标必须换成主系统编号');
  assert.equal(spy[1]!.args.toPeriodKey, 'pm1', '未指定新节次→保持原节次');
  assert.equal(spy[1]!.args.reason, '投影仪故障', '原因用用户原话');
  assert.match(out.answer!, /保持原节次/);
  assert.match(out.answer!, /尚未写入主系统/);
  assert.match(out.answer!, /确认权在你/);
  assert.equal(out.awaitingConfirmation, true);
});

test('E4 说了新节次就用新节次；命中多门课程时停在查询并要用户指定', async () => {
  const spy: Array<{ tool: string; args: Record<string, unknown> }> = [];
  await runChain('schedule_move', {
    question: '把 E310 在 2026-11-12 下午第一大节的课调到 E312 上午第二大节，因为投影仪故障',
    intent: intent(), ds: { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-e312', name: 'E312' }], openLabs: [] } as never, now, mode: 'task', execute: moveHarness(spy)
  });
  assert.equal(spy[1]!.args.toPeriodKey, 'am2');

  const spy2: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const two = await runChain('schedule_move', {
    question: MOVE_Q, intent: intent(), ds: { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-e312', name: 'E312' }], openLabs: [] } as never, now, mode: 'task',
    execute: moveHarness(spy2, { lessons: [{ timetableId: 'a', periodKey: 'pm1', courseName: '课A' }, { timetableId: 'b', periodKey: 'pm1', courseName: '课B' }] })
  });
  assert.equal(two.steps.length, 1, '多门课程时不许猜一门去准备');
  assert.match(String(two.stoppedReason), /需用户指定/);
});

test('E5 目标不合格（constraints_failed）时如实上报，不换个目标重试', async () => {
  const spy: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const out = await runChain('schedule_move', {
    question: MOVE_Q, intent: intent(), ds: { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-e312', name: 'E312' }], openLabs: [] } as never, now, mode: 'task',
    execute: moveHarness(spy, { prepareFail: { code: 'constraints_failed', message: '目标房间该节次已有其他课程' } })
  });
  assert.equal(out.steps.length, 2);
  assert.equal(out.answer, null);
  assert.match(String(out.stoppedReason), /constraints_failed/);
  assert.match(String(out.stoppedReason), /目标房间该节次已有其他课程/);
});

test('E6 红线：调课链同样不许出现 plans/commit', async () => {
  const spy: Array<{ tool: string; args: Record<string, unknown> }> = [];
  await runChain('schedule_move', { question: MOVE_Q, intent: intent(), ds: { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-e312', name: 'E312' }], openLabs: [] } as never, now, mode: 'task', execute: moveHarness(spy) });
  assert.ok(!spy.some(s => /commit|confirm|apply/i.test(s.tool)), spy.map(s => s.tool).join(','));
  assert.ok(spy.every(s => !('planId' in s.args)), '不许直接提交方案编号');
});

test('E7 「原因是X」这种最自然的说法也要进链（彩排实测：正则少收「是」时整条链零执行，白烧 3 轮模型 81.5 s）', async () => {
  const spy: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const q = '2026-11-16 第一大节 E310 的 Java 程序设计想换到 E312，原因是投影仪故障，帮我准备调课提案';
  assert.equal(detectChain({ question: q, mode: 'task' }), 'schedule_move');
  const out = await runChain('schedule_move', {
    question: q, intent: intent({ labName: 'E310', periodKey: 'am1', periodKeys: null }), ds: { labs: [{ id: 'lab-e310', name: 'E310' }, { id: 'lab-e312', name: 'E312' }], openLabs: [] } as never, now, mode: 'task',
    execute: moveHarness(spy, { lessons: [{ timetableId: 'tt-java', periodKey: 'am1', courseName: 'Java 程序设计', className: '智能本2501' }] })
  });
  assert.equal(spy.length, 2, '前置条件齐了就该执行，不该交回模型');
  assert.equal(spy[1]!.args.reason, '投影仪故障');
  assert.equal(spy[1]!.args.toLabId, 'lab-e312');
  assert.equal(out.awaitingConfirmation, true);
});

// ============================ 钥匙借还链 ============================
const keyDs = { labs: [{ id: 'lab-e310', name: 'E310' }], openLabs: [] } as never;
function keyHarness(spy: Array<{ tool: string; args?: Record<string, unknown> }>, keys: Array<{ id: string; name: string; labName: string; holder: string; borrowed: boolean }>, prepareFail?: { code: string; message: string }) {
  return async (tool: string, args: Record<string, unknown>) => {
    spy.push({ tool, args });
    if (tool === 'query_key_records') return { ok: true, resultKind: 'records', summary: '台账已查询', result: { keys } } as never;
    if (prepareFail) return { ok: false, ...prepareFail } as never;
    return { ok: true, resultKind: 'business_plan', summary: '方案已准备', result: { plan: { id: 'plan-key-1', state: 'awaiting_confirmation' } } } as never;
  };
}

test('F1 检测：话术含钥匙/借还才进链', () => {
  assert.equal(detectChain({ question: '帮我把 E310 的钥匙借给 2023001', mode: 'task' }), 'key_transaction');
  assert.equal(detectChain({ question: 'E312 的钥匙归还一下', mode: 'task' }), 'key_transaction');
  assert.equal(detectChain({ question: 'E310 现在有空吗', mode: 'task' }), null);
});

test('F2 借出：没说借给谁就零执行交回模型（不猜人）', async () => {
  const spy: Array<{ tool: string }> = [];
  const out = await runChain('key_transaction', { question: '帮我把 E310 的钥匙借出去', intent: intent({ labName: 'E310' }), ds: keyDs, now, mode: 'task', execute: async (tool) => { spy.push({ tool }); return { ok: true, resultKind: 'records', summary: '', result: { keys: [] } } as never; } });
  assert.equal(spy.length, 0);
  assert.match(String(out.stoppedReason), /借给人/);
});

test('F3 借出/归还两条路都走通，参数与正文口径正确', async () => {
  const lendSpy: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const lend = await runChain('key_transaction', {
    question: '帮我把 E310 的钥匙借给 2023001', intent: intent({ labName: 'E310' }), ds: keyDs, now, mode: 'task',
    execute: keyHarness(lendSpy, [{ id: 'key_E310', name: 'E310 门钥匙', labName: 'E310', holder: '', borrowed: false }])
  });
  assert.deepEqual(lendSpy.map(s => s.tool), ['query_key_records', 'prepare_business_workflow']);
  assert.equal(lendSpy[0]!.args!.labId, 'E310', '台账按房间定位');
  assert.equal(lendSpy[1]!.args!.kind, 'key.lend');
  assert.equal(lendSpy[1]!.args!.keyId, 'key_E310');
  assert.equal(lendSpy[1]!.args!.holderUsername, '2023001');
  assert.match(lend.answer!, /台账尚未变化/);
  assert.match(lend.answer!, /确认权在你/);

  const retSpy: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const ret = await runChain('key_transaction', {
    question: 'E310 的钥匙归还一下', intent: intent({ labName: 'E310' }), ds: keyDs, now, mode: 'task',
    execute: keyHarness(retSpy, [{ id: 'key_E310', name: 'E310 门钥匙', labName: 'E310', holder: '2023****01', borrowed: true }])
  });
  assert.equal(retSpy[1]!.args!.kind, 'key.return');
  assert.ok(!('expectedHolder' in (retSpy[1]!.args ?? {})), '并发令牌由主系统按台账写入，编排侧不传');
  assert.match(ret.answer!, /放回柜内/);
});

test('F4 台账状态与请求矛盾时停下，不准备注定被拒的方案', async () => {
  const inCabinet: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const a = await runChain('key_transaction', {
    question: 'E310 的钥匙归还一下', intent: intent({ labName: 'E310' }), ds: keyDs, now, mode: 'task',
    execute: keyHarness(inCabinet, [{ id: 'key_E310', name: 'E310 门钥匙', labName: 'E310', holder: '', borrowed: false }])
  });
  assert.equal(inCabinet.length, 1, '在柜的钥匙不该再准备归还方案');
  assert.match(String(a.stoppedReason), /当前在柜/);

  const alreadyOut: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const b = await runChain('key_transaction', {
    question: '把 E310 的钥匙借给我', intent: intent({ labName: 'E310' }), ds: keyDs, now, mode: 'task',
    execute: keyHarness(alreadyOut, [{ id: 'key_E310', name: 'E310 门钥匙', labName: 'E310', holder: '2023****01', borrowed: true }])
  });
  assert.equal(alreadyOut.length, 1);
  assert.match(String(b.stoppedReason), /当前已借出/);

  const two: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const c = await runChain('key_transaction', {
    question: '把 E310 的钥匙借给我', intent: intent({ labName: 'E310' }), ds: keyDs, now, mode: 'task',
    execute: keyHarness(two, [{ id: 'k1', name: 'E310 门钥匙', labName: 'E310', holder: '', borrowed: false }, { id: 'k2', name: 'E310 窗钥匙', labName: 'E310', holder: '', borrowed: false }])
  });
  assert.match(String(c.stoppedReason), /2 把钥匙/);
});

test('F5 借用人不存在等主系统拒绝如实上报；链里绝不出现执行类工具', async () => {
  const spy: Array<{ tool: string; args?: Record<string, unknown> }> = [];
  const out = await runChain('key_transaction', {
    question: '把 E310 的钥匙借给 2099001', intent: intent({ labName: 'E310' }), ds: keyDs, now, mode: 'task',
    execute: keyHarness(spy, [{ id: 'key_E310', name: 'E310 门钥匙', labName: 'E310', holder: '', borrowed: false }], { code: 'holder_invalid', message: '借用人不存在、未激活或待改密' })
  });
  assert.equal(out.steps.length, 2);
  assert.match(String(out.stoppedReason), /holder_invalid/);
  assert.ok(!spy.some(s => /commit|confirm|apply/i.test(s.tool)));
});

test('F6 只给角色称谓（志愿者/学生）时零执行交回模型：不许先查台账再留一条注定失败的写步骤', async () => {
  for (const to of ['志愿者', '学生', '管理员']) {
    const spy: Array<{ tool: string }> = [];
    const out = await runChain('key_transaction', {
      question: `把 E312 的钥匙借给${to}，用于今天下午第一节，帮我准备借出提案`, intent: intent({ labName: 'E312' }), ds: keyDs, now, mode: 'task',
      execute: async (tool) => { spy.push({ tool }); return { ok: true, resultKind: 'records', summary: '', result: { keys: [] } } as never; }
    });
    assert.equal(spy.length, 0, `${to}：不该执行任何步骤`);
    assert.equal(out.answer, null);
    assert.match(String(out.stoppedReason), /角色称谓/, `${to}：应说明要问具体哪一位`);
  }
});

test('D9 接线守卫：run.ts 必须真的调用编排，且交回模型时不产生任何事件', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/agent/run.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bdetectChain\b[^}]*\brunChain\b[^}]*\} from '\.\/chain-plan\.ts'/, 'run.ts 未接入 chain-plan');
  assert.match(src, /strategy: 'deterministic_chain'/, 'run_completed 未标注确定性链策略');
  assert.match(src, /handback/, '缺少"零执行交回模型"的分支');
  // 交回分支只在 steps 为 0 时打日志，不许 emit 事件（否则界面会看到半截回答）
  const handback = src.slice(src.indexOf('log.info(\'chain_orchestration\', { runId, kind: chainKind, steps: 0'), 240);
  assert.ok(!/yield emit/.test(handback), '交回模型前不该 emit 任何事件');
  const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(env, /AGENT_CHAIN_ORCHESTRATION/, '.env.example 应写明这个开关');
});

test('D10 停下时的文案要说清是哪条链（真实数据实测到三条链都写成"联合处置链"）', async () => {
  const { CHAIN_LABEL } = await import('../server/agent/chain-plan.ts');
  assert.deepEqual(CHAIN_LABEL, {
    incident_joint: '故障事件联合处置链',
    schedule_move: '调课提案链',
    key_transaction: '钥匙借还链'
  });
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/agent/run.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('${CHAIN_LABEL[chainKind]}在第'), 'run.ts 兜底文案仍写死某一条链');
  assert.ok(!src.includes('`联合处置链在第'), '仍有硬编码文案');
});
