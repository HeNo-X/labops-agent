/**
 * 故障事件草稿参数前置校验 —— 回归防护
 * ============================================================================
 *  问题形态：问「E310 投影仪没有信号，帮我准备报修」时，若工具清单只把 action 标成
 *    必填，模型会省掉节次，请求撞上主系统的 bad_period，最终只剩一句错误话术。
 *
 *  两侧口径（代码可证）：
 *    · 主系统 POST /incidents/draft 要求 roomId + date + description + periodKeys
 *      （Pages/server/operations.js：`请选择故障影响节次` → bad_period）；
 *    · LabOps 工具清单里 prepare_incident_plan 只把 action 标成必填，
 *      模型据此认为节次可省 → 拿到的报错既没合法值也没映射，只能原样重试；
 *    · 重试会耗尽步数上限，本轮没有可办理方案。
 *
 *  现在的做法：prepareIncident 在**发请求之前**按主系统同一口径校验 draft 四项，
 *  报错里一次给全缺什么、六个合法节次键与中文对照；缺资料时模型应先问用户。
 *
 *  运行：node --test tests/incident-draft-guard.test.ts
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-incident-draft-'));
process.env['LABOPS_DB_PATH'] = path.join(temp, 'agent.sqlite');

const STUB_URL = new URL('./fixtures/bridge-stub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/server/tools/business.ts') && specifier.endsWith('/business/bridge.ts')) {
      return next(STUB_URL, context);
    }
    return next(specifier, context);
  }
});

const { prepareIncident, queryIncident } = await import('../server/tools/business.ts');
const bridge = await import('./fixtures/bridge-stub.ts');
type Ctx = Parameters<typeof prepareIncident>[1];

const ctx = (): Ctx => ({
  dataset: {
    sourceType: 'demo',
    labs: [{ id: 'fixture-e310', name: 'E310' }, { id: 'lab-d517', name: 'D517' }],
    openLabs: [{ id: 'ol-d501', name: 'D501' }, { id: 'ol-d517', name: 'D517' }]
  } as never,
  now: { iso: new Date().toISOString(), date: '2026-11-10', time: '10:00:00', weekday: 2, weekdayLabel: '周二' },
  mode: 'task',
  conversationId: 'conv-stub',
  actor: { id: 'stub-admin', role: 'admin', label: '管理' }
}) as unknown as Ctx;

/** 主系统认账的完整草稿参数 */
const complete = { action: 'draft', roomId: 'fixture-e310', date: '2026-11-10', description: 'E310 投影仪没有信号', periodKeys: ['pm1'] };

test.beforeEach(() => bridge.resetCalls());

test('缺 periodKeys 本地拦截：一次报清合法值，且不发起主系统请求', async () => {
  const { periodKeys, ...without } = complete;
  const out = await prepareIncident(without, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.code, 'missing_period');
  const message = out.message || '';
  assert.match(message, /am1/);
  assert.match(message, /eve_cd/);
  assert.match(message, /下午第一大节=pm1/);
  assert.match(message, /不要猜测/);
  assert.deepEqual(bridge.calls, [], '参数不全时不该打到主系统');
});

test('非法节次（中文原词）本地拦截：指出非法项并列出六个合法键', async () => {
  const out = await prepareIncident({ ...complete, periodKeys: ['下午第一大节', 'pm1'] }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.code, 'bad_period');
  assert.match(out.message || '', /下午第一大节/);
  assert.match(out.message || '', /am1 \/ am2 \/ pm1 \/ pm2 \/ eve_ab \/ eve_cd/);
  assert.equal(bridge.calls.length, 0);
});

test('缺 roomId / 非法 date / 无故障事实各自独立报错，均不发请求', async () => {
  const cases: Array<[Record<string, unknown>, string, RegExp]> = [
    [{ ...complete, roomId: '  ' }, 'missing_room', /rooms\[\]\.id/],
    [{ ...complete, date: '11-10' }, 'bad_date', /YYYY-MM-DD/],
    [{ ...complete, date: undefined }, 'bad_date', /未提供/],
    [{ ...complete, description: '坏了' }, 'missing_description', /不得代用户猜测/]
  ];
  for (const [args, code, re] of cases) {
    bridge.resetCalls();
    const out = await prepareIncident(args, ctx());
    assert.equal(out.ok, false, JSON.stringify(args));
    assert.equal(out.code, code);
    assert.match(out.message || '', re);
    assert.equal(bridge.calls.length, 0, `${code} 应本地拦截`);
  }
});

test('四项齐全照旧提交主系统，参数原样透传并带 conversationId', async () => {
  bridge.setNextResponse({ plan: { id: 'plan-1', state: 'awaiting_confirmation' } });
  const out = await prepareIncident(complete, ctx());
  assert.equal(out.ok, true);
  assert.equal(bridge.calls.length, 1);
  const call = bridge.calls[0]!;
  assert.equal(call.path, '/incidents/draft');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { ...complete, conversationId: 'conv-stub' });
});

test('房间名一次映射成 rooms[].id（实测里模型交 E310 被主系统退回）', async () => {
  bridge.setNextResponse({ incident: { id: 'incident-1' } });
  const out = await prepareIncident({ ...complete, roomId: 'E310' }, ctx());
  assert.equal(out.ok, true);
  assert.equal(bridge.calls.length, 1, '映射在本地完成，不该先撞主系统再回头');
  assert.equal((bridge.calls[0]!.body as { roomId: string }).roomId, 'fixture-e310');
});

test('开放实验室房号同样能解析（只查 labs 会让 5 楼全部报找不到）', async () => {
  bridge.setNextResponse({ incident: { id: 'incident-2' } });
  const out = await prepareIncident({ ...complete, roomId: 'D501' }, ctx());
  assert.equal(out.ok, true, out.ok ? '' : `${out.code} ${out.message}`);
  assert.equal((bridge.calls[0]!.body as { roomId: string }).roomId, 'ol-d501');
});

test('房号在两处各登记一次时不自行挑选，要求向用户确认（D517 双身份）', async () => {
  const out = await prepareIncident({ ...complete, roomId: 'D517' }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.code, 'lab_ambiguous');
  assert.match(out.message || '', /lab-d517（D517）/);
  assert.match(out.message || '', /ol-d517（D517）/);
  assert.match(out.message || '', /不要自行挑选/);
  assert.equal(bridge.calls.length, 0);
});

test('房间清单里没有时报错并给出可选编号，不发请求', async () => {
  const ghost = await prepareIncident({ ...complete, roomId: 'E999' }, ctx());
  assert.equal(ghost.ok, false);
  assert.equal(ghost.code, 'lab_not_found');
  assert.match(ghost.message || '', /fixture-e310（E310）/);
  assert.equal(bridge.calls.length, 0);
});

test('空 incidentId 不再打到 /incidents/（实测里白烧一步 not_found）', async () => {
  bridge.setNextResponse({ rooms: [], incidents: [] });
  const out = await queryIncident({ incidentId: '  ' }, ctx());
  const paths = bridge.calls.map(c => c.path);
  assert.ok(!paths.includes('/incidents/'), `空编号不应拼出 /incidents/ 这种请求：${JSON.stringify(paths)}`);
  assert.ok(paths.includes('/incidents'), `空编号应回落到事件清单查询：${JSON.stringify(paths)}`);
  const code = 'code' in out ? String(out['code']) : '';
  assert.notEqual(code, 'not_found');
});

test('非 draft 动作不受新校验牵连，但事件编号仍必填', async () => {
  const out = await prepareIncident({ action: 'analyze' }, ctx());
  assert.equal(out.ok, false);
  assert.match(out.message || '', /事件编号/);
  assert.equal(bridge.calls.length, 0);

  bridge.resetCalls();
  bridge.setNextResponse({ candidateSet: { id: 'set-1' } });
  const ok = await prepareIncident({ action: 'analyze', incidentId: 'incident-1' }, ctx());
  assert.equal(ok.ok, true);
  assert.equal(bridge.calls[0]!.path, '/incidents/incident-1/analyze');
});

test('聊天模式不准备事件方案（红线不变）', async () => {
  const chat = prepareIncident(complete, { ...ctx(), mode: 'chat' } as Ctx);
  const out = await chat;
  assert.equal(out.ok, false);
  assert.match(out.message || '', /任务模式/);
  assert.equal(bridge.calls.length, 0);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
