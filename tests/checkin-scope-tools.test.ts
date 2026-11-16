/**
 * 逐人明细工具的三类签到口径 —— 回归防护（2026-11-10）
 * ============================================================================
 *  用户现象：主系统「最近签到记录」明明有 E310 · 熊海诺 签到，Agent 却答
 *    「2026-11-09 签到签退明细：共 0 条」。
 *
 *  根因（两侧各一半）：
 *    · 主系统 /checkin-records 只读 volunteer_records（志愿者值班台账，**不绑房间**），
 *      学生上机签到在 checkin_records 里，压根不在查询范围内；
 *    · 工具清单也没有 labId，模型连"E310"这个条件都传不进去。
 *
 *  修复：主系统按 scope=student|duty|all 分表取数并支持房间过滤（见批次A），
 *  本工具补 labId/scope 参数与三张表的口径说明。这里守住 Agent 侧的三件事：
 *    ① 参数原样进查询串；② 摘要按口径措辞，不再笼统说"逐人签到"；
 *    ③ 主系统的口径冲突错误如实上抛，不降级成"查无记录"。
 *
 *  运行：node --test tests/checkin-scope-tools.test.ts
 */

import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-checkin-scope-'));
process.env['LABOPS_DB_PATH'] = path.join(temp, 'agent.sqlite');

const STUB_URL = new URL('./fixtures/bridge-stub.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/server/tools/query-checkin-records.ts') && specifier.endsWith('/business/bridge.ts')) {
      return next(STUB_URL, context);
    }
    return next(specifier, context);
  }
});

const { queryCheckinRecords, queryOpenlabRecords } = await import('../server/tools/query-checkin-records.ts');
const bridge = await import('./fixtures/bridge-stub.ts');

test.beforeEach(() => bridge.resetCalls());

function lastQuery(): string {
  const call = bridge.calls.at(-1)!;
  return call.path;
}

test('房间与口径参数原样进查询串（此前连 labId 都传不进去）', async () => {
  bridge.setNextResponse({ date: '2026-11-09', scope: 'student', records: [{ name: '熊海诺', user: '2023****01', type: 'checkin' }], total: 1 });
  const out = await queryCheckinRecords({ date: '2026-11-09', labId: 'E310', scope: 'student' });
  assert.equal(out.ok, true);
  const q = new URL('http://x' + lastQuery()).searchParams;
  assert.equal(q.get('date'), '2026-11-09');
  assert.equal(q.get('labId'), 'E310');
  assert.equal(q.get('scope'), 'student');
});

test('摘要格式（2026-11-16 用户指定）：学生按班级分区只给掩码学号，志愿者只给姓名', async () => {
  bridge.setNextResponse({ date: '2026-11-09', scope: 'student', total: 2, records: [
    { user: '2026****01', name: '张三', type: 'checkin', className: '智能本2501' },
    { user: '2026****02', name: '李四', type: 'checkin', className: '智能本2502' }
  ] });
  const a = await queryCheckinRecords({ date: '2026-11-09', scope: 'student' });
  assert.match(a.summary!, /当前上课班级：智能本2501/);
  assert.match(a.summary!, /已签到学生：2026\*\*\*\*01/);
  assert.match(a.summary!, /当前上课班级：智能本2502/);
  assert.doesNotMatch(a.summary!, /张三/, '学生只给掩码学号，不显示姓名');

  bridge.resetCalls();
  bridge.setNextResponse({ date: '2026-11-09', scope: 'duty', total: 1, records: [
    { user: '2023****99', name: '王五', type: 'checkin', periodKey: 'am1' }
  ] });
  const b = await queryCheckinRecords({ date: '2026-11-09', scope: 'duty' });
  assert.match(b.summary!, /值班志愿者：王五/);
  assert.doesNotMatch(b.summary!, /2023\*\*\*\*99/, '志愿者只给姓名，不显示账号');

  bridge.resetCalls();
  bridge.setNextResponse({ date: '2026-11-09', scope: 'student', records: [], total: 0 });
  const c = await queryCheckinRecords({ date: '2026-11-09', labId: 'E310', scope: 'student' });
  assert.match(c.summary!, /没有查到已签到记录/);
});

test('主系统的口径冲突错误如实上抛，不降级成"查无记录"', async () => {
  bridge.setNextError(Object.assign(new Error('志愿者值班签到不绑定房间：要看某房间的签到请用 scope=student（上机实验室）或 /openlab-records（开放实验室）'), { code: 'scope_conflict', status: 400 }));
  const out = await queryCheckinRecords({ date: '2026-11-09', labId: 'E310', scope: 'duty' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'scope_conflict');
  assert.match(out.message!, /不绑定房间/);
});

test('开放实验室明细带房间时按房号透传（服务端已修 id/名两种口径）', async () => {
  bridge.setNextResponse({ date: '2026-11-09', records: [], total: 0 });
  const out = await queryOpenlabRecords({ date: '2026-11-09', labId: 'D501' });
  assert.equal(out.ok, true);
  const q = new URL('http://x' + lastQuery()).searchParams;
  assert.equal(q.get('labId'), 'D501');
});

test('工具清单写清三张表的边界（防止模型再拿值班台账回答"某房间谁签到"）', async () => {
  const { QUERY_CHECKIN_RECORDS_SPEC, QUERY_OPENLAB_RECORDS_SPEC } = await import('../server/tools/query-checkin-records.ts');
  const d = QUERY_CHECKIN_RECORDS_SPEC.description;
  assert.match(d, /不绑定房间/);
  assert.match(d, /scope=student/);
  assert.match(d, /query_openlab_records/);
  assert.ok(QUERY_CHECKIN_RECORDS_SPEC.parameters.properties['labId'], '缺 labId 参数');
  assert.ok(QUERY_CHECKIN_RECORDS_SPEC.parameters.properties['scope'], '缺 scope 参数');
  assert.match(QUERY_OPENLAB_RECORDS_SPEC.description, /D517|两处/);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
