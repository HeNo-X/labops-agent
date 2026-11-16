/**
 * 自动化模块展示层纯函数单测
 * ============================================================================
 *  这些函数决定了用户看到的"多久一次""下次什么时候""会通知谁"。
 *  旧版这些逻辑写在模板表达式里，无法测试，PC 与移动端各写一遍 ——
 *  一处改了另一处没改，用户就会看到两种说法。这里锁死口径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canToggle,
  effectsText,
  formatDateTime,
  isOn,
  kindHint,
  nextRunText,
  recipientsText,
  statusMeta,
  triggerText
} from '../web/business/automation-format.ts';

test('triggerText：五种触发方式都翻成人话', () => {
  assert.equal(triggerText({ trigger: { type: 'daily', time: '20:30' } }), '每天 20:30');
  assert.equal(triggerText({ trigger: { type: 'duty', minutesBefore: 30 } }), '正式班次前 30 分钟');
  assert.equal(triggerText({ trigger: { type: 'cron', expression: '30 20 * * *' } }), '自定义 Cron：30 20 * * *');
  assert.match(triggerText({ trigger: { type: 'once', at: '2026-10-30T12:30:00+08:00' } }), /^仅一次 /);
});

test('triggerText：每周要把星期说清楚，不能只说"每周"', () => {
  const weekday = triggerText({ trigger: { type: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '08:00' } });
  assert.equal(weekday, '工作日 08:00');
  const weekend = triggerText({ trigger: { type: 'weekly', weekdays: [0, 6], time: '09:00' } });
  assert.equal(weekend, '周末 09:00');
  const single = triggerText({ trigger: { type: 'weekly', weekdays: [3], time: '14:00' } });
  assert.equal(single, '周三 14:00');
  const all = triggerText({ trigger: { type: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6], time: '07:00' } });
  assert.equal(all, '每天 07:00');
});

test('triggerText：字段缺失/类型异常时给可读兜底，绝不抛异常或输出 undefined', () => {
  assert.equal(triggerText({ trigger: {} }), '未设置触发时间');
  assert.equal(triggerText({ trigger: { type: 'unknown-type' } }), '未设置触发时间');
  const weeklyNoDays = triggerText({ trigger: { type: 'weekly', time: '10:00' } });
  assert.ok(!weeklyNoDays.includes('undefined'), weeklyNoDays);
  assert.ok(!weeklyNoDays.includes('NaN'), weeklyNoDays);
});

test('nextRunText：相对时间分档，且绝不把已逾期说成"即将"', () => {
  const now = Date.parse('2026-10-29T12:00:00+08:00');
  assert.equal(nextRunText(null, now), '无后续运行');
  assert.equal(nextRunText('2026-10-29T12:30:00+08:00', now), '30 分钟后');
  assert.equal(nextRunText('2026-10-29T15:00:00+08:00', now), '3 小时后');
  assert.equal(nextRunText('2026-10-30T12:00:00+08:00', now), '明天');
  assert.equal(nextRunText('2026-11-02T12:00:00+08:00', now), '4 天后');
  // 逾期必须显式说出来，不能伪装成正常状态
  assert.match(nextRunText('2026-10-28T12:00:00+08:00', now), /^已逾期/);
  // 小于一分钟
  assert.equal(nextRunText('2026-10-29T12:00:30+08:00', now), '即将运行');
});

test('recipientsText：四种接收对象，超过 3 个只报数量（卡片放不下明细）', () => {
  assert.equal(recipientsText([{ kind: 'user', userId: 'review-admin' }]), '本人（review-admin）');
  assert.equal(recipientsText([{ kind: 'role', role: 'volunteer' }]), '全体志愿者');
  assert.equal(recipientsText([{ kind: 'role', role: 'student' }]), '全体学生', 'student 不得原样甩英文');
  assert.equal(recipientsText([{ kind: 'role', role: 'admin' }]), '全体管理员');
  assert.equal(recipientsText([{ kind: 'role', role: 'weird' }]), '全体weird', '表外身份原样显示，不吞值');
  assert.equal(recipientsText([{ kind: 'class', className: '计工本2503' }]), '班级 计工本2503');
  assert.equal(recipientsText([{ kind: 'all' }]), '全体成员');
  assert.equal(recipientsText([]), '未设置接收人');
  assert.equal(recipientsText(undefined), '未设置接收人');
  assert.equal(recipientsText([{ kind: 'user', userId: 'a' }, { kind: 'user', userId: 'b' }, { kind: 'user', userId: 'c' }, { kind: 'user', userId: 'd' }]), '4 个接收对象');
});

test('effectsText：报告与站内信要说人话，不能直接甩 report/inbox', () => {
  assert.equal(effectsText(['report']), '生成报告');
  assert.equal(effectsText(['report', 'inbox']), '生成报告 + 投递站内通知');
  assert.equal(effectsText([]), '无输出');
});

test('statusMeta / isOn / canToggle：12 个状态全覆盖，且不是只靠颜色区分', () => {
  const all = [
    'active', 'completed', 'paused', 'suspended', 'archived',
    'needs_authorization', 'pending', 'running', 'success', 'failed', 'skipped', 'unknown'
  ];
  for (const status of all) {
    const meta = statusMeta(status);
    assert.ok(meta.label.length > 0, `${status} 缺中文标签`);
    assert.ok(meta.glyph.length > 0, `${status} 缺形状符号（色盲用户需要）`);
    assert.ok(['ok', 'warn', 'danger', 'info', 'muted'].includes(meta.tone), `${status} tone 非法`);
  }
  // 未知状态不能抛异常，要退化成"对账中"而不是空白
  assert.equal(statusMeta('weird').label, statusMeta('unknown').label);
  assert.equal(statusMeta(null).label, statusMeta('unknown').label);

  assert.equal(isOn('active'), true);
  assert.equal(isOn('paused'), false);
  assert.equal(isOn(null), false);

  assert.equal(canToggle('active'), true);
  assert.equal(canToggle('paused'), true);
  assert.equal(canToggle('archived'), false);
  assert.equal(canToggle('completed'), false);
  assert.equal(canToggle('needs_authorization'), false);
});

test('kindHint：8 个模板都有一句话说明，未知模板有兜底', () => {
  const kinds = [
    'daily_report', 'tomorrow_courses', 'duty_reminder', 'due_followup',
    'notice_reminder', 'lab_open_reminder', 'session_checkin_reminder', 'patrol_reminder'
  ];
  for (const kind of kinds) {
    const hint = kindHint(kind);
    assert.ok(hint.length > 8, `${kind} 的说明太短，用户读不懂`);
    assert.notEqual(hint, '按模板规则运行', `${kind} 没有专属说明`);
  }
  assert.equal(kindHint('not_a_kind'), '按模板规则运行');
  assert.equal(kindHint(null), '按模板规则运行');
});

test('formatDateTime：固定按 Asia/Shanghai 输出，不随运行机器时区漂移', () => {
  const text = formatDateTime('2026-10-29T12:00:00Z');
  assert.match(text, /2026/);
  assert.match(text, /20:00/, `UTC 12:00 应为北京时间 20:00，实际 ${text}`);
  assert.equal(formatDateTime(null), '无');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
});
