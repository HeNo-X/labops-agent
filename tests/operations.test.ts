/**
 * ops.v1 单元测试 —— 提案 → 决策 → 回执 → 幂等 / 越权 / 过期（任务书 T04/T05/T02）
 * ============================================================================
 *  独立于 unit.test.ts：本文件在**任何 db 导入之前**把 LABOPS_DB_PATH 指到临时文件，
 *  避免污染真实用户数据库（R25-lite 的测试约定）。
 *
 *  运行：node --test tests/operations.test.ts
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- 必须先于 db 模块加载设置测试库路径 ----
const tmpDb = path.join(os.tmpdir(), `labops-ops-test-${process.pid}-${Date.now()}.sqlite`);
process.env['LABOPS_DB_PATH'] = tmpDb;

const { executeTool } = await import('../server/tools/registry.ts');
const typeRegistry = await import('../server/tools/registry.ts');
const db = await import('../server/persistence/db.ts');
const { decideOnProposal } = await import('../server/operations/executor.ts');
const { resolveActor } = await import('../server/operations/identity.ts');
const { DATA_SOURCE_LABELS } = await import('../shared/types.ts');
import type { Dataset, TimetableRow } from '../server/data/store.ts';
import type { ServerNow } from '../server/time/term.ts';
import type { SandboxActor } from '../shared/operations-contract.ts';
import type { ToolContext } from '../server/tools/registry.ts';

const NOW: ServerNow = {
  iso: '2026-09-27T11:00:00+08:00',
  date: '2026-09-27',
  time: '11:00:00',
  weekday: 0,
  weekdayLabel: '周日'
};

function row(over: Partial<TimetableRow>): TimetableRow {
  return {
    id: 'tt_x',
    term: 'T1',
    classNames: ['软件1班'],
    className: '软件1班',
    courseId: '',
    courseName: '测试课程',
    teacher: '教师T01',
    labId: 'lab_1',
    labName: 'E310',
    weekday: 3,
    periodKey: 'am1',
    weeks: { from: 1, to: 20, parity: 'all' },
    status: 'normal',
    updatedAt: '2026-09-07T00:00:00+08:00',
    ...over
  };
}

function dataset(): Dataset {
  return {
    sourceType: 'snapshot',
    sourceLabel: DATA_SOURCE_LABELS['snapshot'],
    meta: { sourceSha256Prefix: 'deadbeefdeadbeef', snapshotAt: '2026-09-26T00:00:00+08:00' },
    term: { term: 'T1', termStart: '2026-09-07', holidays: [] },
    labs: [
      { id: 'lab_1', sortOrder: 1, name: 'E310', location: '文渊E区3层E310', capacity: 40, status: 'active', description: '' }
    ],
    openLabs: [],
    timetable: [row({}), row({ id: 'tt_2', weekday: 3, periodKey: 'pm1', className: '软件2班', classNames: ['软件2班'], labName: 'E310' })],
    loadedAt: NOW.iso,
    warnings: []
  } as Dataset;
}

const ADMIN: SandboxActor = resolveActor('admin');
const STUDENT: SandboxActor = resolveActor('student');

function ctx(actor: SandboxActor, ds: Dataset = dataset()): ToolContext {
  return { dataset: ds, now: NOW, actor, conversationId: 'conv-test' };
}

async function prepareIssue(actor: SandboxActor = ADMIN): Promise<Extract<Awaited<ReturnType<typeof executeTool>>, { ok: true; resultKind: 'operation_proposal' }>> {
  const r = await executeTool(
    'prepare_issue_ticket',
    { roomId: 'E310', category: 'equipment', description: '讲台投影无信号' },
    ctx(actor)
  );
  assert.equal(r.ok, true, `准备报修单应成功：${r.ok ? '' : (r as { message: string }).message}`);
  assert.equal(r.resultKind, 'operation_proposal');
  return r as never;
}

test('prepare_issue_ticket：生成待确认提案 + 任务落库，提案卡可执行', async () => {
  const r = await prepareIssue();
  const p = r.result;
  assert.equal(p.state, 'awaiting_confirmation');
  assert.equal(p.executionEnvironment, 'sandbox');
  assert.equal(p.canExecute, true);
  assert.ok(p.taskId.startsWith('task-'));
  const task = db.getOpsTask(p.taskId);
  assert.ok(task);
  assert.equal(task!.status, 'awaiting_confirmation');
  assert.equal(task!.actor.role, 'admin');
  // 同房间有 1 张未结工单提示应在 summary 中体现（本测试第二轮建单时）
});

test('学生确认报修单：可以建单（issue:create:self 全角色都有）', async () => {
  const r = await executeTool(
    'prepare_issue_ticket',
    { roomId: 'E310', category: 'other', description: '地面有水渍' },
    ctx(STUDENT)
  );
  assert.equal(r.ok, true);
  const p = (r as { result: { proposalId: string; version: number; taskId: string } }).result;
  const outcome = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'confirm',
    clientRequestId: 'req-stu-1',
    actor: STUDENT
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok && outcome.decision === 'confirm') {
    assert.equal(outcome.receipt.businessStatus, 'committed');
    assert.equal(outcome.receipt.executionEnvironment, 'sandbox');
    assert.equal(outcome.receipt.objects[0]!.kind, 'issue');
    assert.equal(outcome.task.status, 'completed');
  }
});

test('学生确认通知提案 → forbidden（notice:publish 只有管理员）', async () => {
  // 学生准备通知：提案可生成，但 canExecute=false
  const r = await executeTool(
    'prepare_notification',
    { title: '停用通知', content: '明天停用', audience: { kind: 'role_scope', role: 'student' }, level: 'warning' },
    ctx(STUDENT)
  );
  assert.equal(r.ok, true);
  const p = (r as { result: { proposalId: string; version: number; canExecute: boolean } }).result;
  assert.equal(p.canExecute, false, '学生的通知提案应标记为不可执行');

  const outcome = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'confirm',
    clientRequestId: 'req-stu-2',
    actor: STUDENT
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'forbidden');
});

test('T04 版本错配：确认旧版本被拒绝', async () => {
  const r = await executeTool(
    'prepare_issue_ticket',
    { roomId: 'E310', category: 'equipment', description: '键盘坏了' },
    ctx(ADMIN)
  );
  const p = (r as { result: { proposalId: string; version: number } }).result;
  const outcome = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version + 100,
    decision: 'confirm',
    clientRequestId: 'req-ver-1',
    actor: ADMIN
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'version_mismatch');
});

test('T05 幂等：同一 clientRequestId 重复确认只产生一次业务效果', async () => {
  const r = await executeTool(
    'prepare_issue_ticket',
    { roomId: 'E310', category: 'environment', description: '白板笔没水了' },
    ctx(ADMIN)
  );
  const p = (r as { result: { proposalId: string; version: number } }).result;
  const o1 = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'confirm',
    clientRequestId: 'req-idem-1',
    actor: ADMIN
  });
  const o2 = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'confirm',
    clientRequestId: 'req-idem-1',
    actor: ADMIN
  });
  assert.equal(o1.ok, true);
  assert.equal(o2.ok, true);
  if (o1.ok && o2.ok && o1.decision === 'confirm' && o2.decision === 'confirm') {
    assert.equal(o1.receipt.operationId, o2.receipt.operationId, '重放必须返回同一回执');
  }
  // 业务事实层面：重复确认没有创建第二张工单
  const issues = db.listBizIssues().filter((i) => i.description.includes('白板笔'));
  assert.equal(issues.length, 1, '同一提案重复确认只能产生一张业务工单');
});

test('拒绝流程：提案 rejected、任务 cancelled，确认通道关闭', async () => {
  const r = await executeTool(
    'prepare_issue_ticket',
    { roomId: 'E310', category: 'other', description: '误报测试' },
    ctx(ADMIN)
  );
  const p = (r as { result: { proposalId: string; version: number; taskId: string } }).result;
  const rej = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'reject',
    clientRequestId: 'req-rej-1',
    actor: ADMIN
  });
  assert.equal(rej.ok, true);
  if (rej.ok && rej.decision === 'reject') assert.equal(rej.task.status, 'cancelled');
  const again = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'confirm',
    clientRequestId: 'req-rej-2',
    actor: ADMIN
  });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, 'proposal_already_decided');
});

test('提案过期：expireStaleProposals 标记后不可确认', async () => {
  const r = await executeTool(
    'prepare_issue_ticket',
    { roomId: 'E310', category: 'other', description: '过期测试' },
    ctx(ADMIN)
  );
  const p = (r as { result: { proposalId: string; version: number; taskId: string } }).result;
  // 直接把过期时间改到过去（模拟 TTL 到期）
  db.getDb().prepare(`UPDATE ops_proposals SET expiresAt = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(p.proposalId);
  db.expireStaleProposals();
  const outcome = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'confirm',
    clientRequestId: 'req-exp-1',
    actor: ADMIN
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'proposal_expired');
  assert.equal(db.getOpsTask(p.taskId)!.status, 'expired');
});

test('房间不存在：lab_not_found 结构化错误（可恢复）', async () => {
  const r = await executeTool(
    'prepare_issue_ticket',
    { roomId: 'E999', category: 'other', description: '不存在房间' },
    ctx(ADMIN)
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'lab_not_found');
    assert.ok(r.suggestions.includes('E310'));
  }
});

test('F02 停用联动：确认后一次产生 停用+工单+通知 三个对象', async () => {
  const r = await executeTool(
    'prepare_room_closure',
    {
      roomId: 'E310',
      startDate: '2026-09-30',
      endDate: '2026-09-30',
      periodKeys: ['am1'],
      reason: '投影检修',
      createIssue: true,
      prepareNotice: true
    },
    ctx(ADMIN)
  );
  assert.equal(r.ok, true, r.ok ? '' : (r as { message: string }).message);
  const p = (r as { result: { proposalId: string; version: number } }).result;
  const outcome = decideOnProposal({
    proposalId: p.proposalId,
    proposalVersion: p.version,
    decision: 'confirm',
    clientRequestId: 'req-clo-1',
    actor: ADMIN
  });
  assert.equal(outcome.ok, true, outcome.ok ? '' : (outcome as { message: string }).message);
  if (outcome.ok && outcome.decision === 'confirm') {
    const kinds = outcome.receipt.objects.map((o) => o.kind).sort();
    assert.deepEqual(kinds, ['closure', 'issue', 'notification']);
    assert.equal(outcome.receipt.deliveryStatus, 'pending');
  }
});

test('F06 值班：start → handover 闭环；无会话时 handover 明确报错', async () => {
  const noSession = await executeTool(
    'prepare_duty_session',
    { mode: 'handover', checklist: [{ key: 'lights', label: '关灯', state: 'done' }], note: '' },
    ctx(ADMIN)
  );
  assert.equal(noSession.ok, false);
  if (!noSession.ok) assert.equal(noSession.code, 'duty_session_not_found');

  const start = await executeTool('prepare_duty_session', { mode: 'start', roomId: 'E310' }, ctx(ADMIN));
  assert.equal(start.ok, true);
  const sp = (start as { result: { proposalId: string; version: number } }).result;
  const started = decideOnProposal({
    proposalId: sp.proposalId,
    proposalVersion: sp.version,
    decision: 'confirm',
    clientRequestId: 'req-duty-1',
    actor: ADMIN
  });
  assert.equal(started.ok, true);

  const handover = await executeTool(
    'prepare_duty_session',
    {
      mode: 'handover',
      checklist: [
        { key: 'power', label: '关闭电源与设备', state: 'done' },
        { key: 'keys', label: '钥匙交接', state: 'abnormal' }
      ],
      note: '投影问题交给下一班'
    },
    ctx(ADMIN)
  );
  assert.equal(handover.ok, true);
  const hp = (handover as { result: { proposalId: string; version: number } }).result;
  const done = decideOnProposal({
    proposalId: hp.proposalId,
    proposalVersion: hp.version,
    decision: 'confirm',
    clientRequestId: 'req-duty-2',
    actor: ADMIN
  });
  assert.equal(done.ok, true);
  if (done.ok && done.decision === 'confirm') {
    // 回执里的 objects[].id 是业务对象 ID（duty_session）；操作凭据本身用 operationId 查
    const duty = db.getOpsOperation(done.receipt.operationId);
    assert.ok(duty, '操作回执应已落库');
    assert.equal(duty!.businessStatus, 'committed');
  }
});

test('F10 日报：直接产出报告（非提案），缺数据源指标为 unknown 而非 0', async () => {
  const r = await executeTool('create_operations_report', {}, ctx(ADMIN));
  assert.equal(r.ok, true);
  if (r.ok && r.resultKind === 'operations_report') {
    const att = r.result.metrics.find((m) => m.key === 'attendance_hours');
    assert.ok(att);
    assert.equal(att!.status, 'unknown');
    assert.equal(att!.value, null, '缺数据源不得显示为 0');
  }
});

test('能力协商：capabilities 描述沙盒环境与当前身份', async () => {
  const admin = resolveActor('admin');
  assert.equal(admin.role, 'admin');
  const caps = typeRegistry.toolNames();
  assert.ok(caps.includes('prepare_issue_ticket'));
  assert.ok(caps.includes('create_operations_report'));
  assert.equal(caps.length,18,'9 个只读（含 analyze_evidence_image 视觉初判）+ 9 个准备/草稿工具');
  assert.ok(caps.includes('analyze_evidence_image'),'视觉初判必须是只读能力，不得带草稿效果');
  const visionTool = typeRegistry.REGISTRY.find((t) => t.spec.name === 'analyze_evidence_image');
  assert.equal(visionTool?.effect, 'read', '看图不得产生提案或任何业务写入');
  assert.equal(visionTool?.spec.danger, false);
  assert.ok(caps.includes('query_scheduled_jobs'));
  assert.ok(caps.includes('prepare_scheduled_job'));
});

after(async () => {
  try {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-shm`, { force: true });
    fs.rmSync(`${tmpDb}-wal`, { force: true });
  } catch {
    /* 忽略 */
  }
});
