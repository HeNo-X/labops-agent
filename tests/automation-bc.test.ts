/**
 * 自动化前端契约与渲染的源级/纯函数断言
 * ============================================================================
 *  主系统调度器侧（maxRuns 计数、completed 状态机、interval nextRun）由
 *  native 全栈浏览器验证覆盖（仓外脚本一次性执行）；本文件锁死前端可静态
 *  断言的部分：
 *    ① triggerText 认 interval（分钟/小时自适应文案）；
 *    ② 创建器有 interval 档与 maxRuns 输入，且提交前做范围校验；
 *    ③ 卡片对 displayStatus=completed 显示「已按次数完成」而非「已暂停」；
 *    ④ 详情显示已运行 N / M（maxRuns 存在时）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { triggerText } from '../web/business/automation-format.ts';

const composer = readFileSync(fileURLToPath(new URL('../web/components/automation/AutomationComposer.vue', import.meta.url)), 'utf8');
const card = readFileSync(fileURLToPath(new URL('../web/components/automation/AutomationTaskCard.vue', import.meta.url)), 'utf8');
const panel = readFileSync(fileURLToPath(new URL('../web/components/automation/AutomationPanel.vue', import.meta.url)), 'utf8');

test('B/C-01 triggerText：interval 按分钟/小时自适应文案', () => {
  assert.equal(triggerText({ trigger: { type: 'interval', minutes: 30 } }), '每 30 分钟');
  assert.equal(triggerText({ trigger: { type: 'interval', minutes: 120 } }), '每 2 小时');
  assert.equal(triggerText({ trigger: { type: 'interval', minutes: 15 } }), '每 15 分钟');
});

test('B/C-02 创建器：interval 档 + maxRuns 输入 + 客户端范围校验', () => {
  assert.match(composer, /value: 'interval', label: '每隔'/, '频率选择器有「每隔」档');
  assert.match(composer, /intervalMinutes/, 'interval 数字输入（分钟）');
  assert.match(composer, /maxRunsInput/, 'maxRuns 输入');
  assert.match(composer, /最多运行次数应为 1—99 的整数/, '提交前范围校验');
  assert.match(composer, /间隔应为 15—10080 分钟/, 'interval 范围校验');
  assert.match(composer, /单次任务不需要 maxRuns/, 'once 不允许 maxRuns（与服务端同口径）');
});

test('B/C-03 卡片：completed 显示「已按次数完成，历史保留」而非「已暂停」', () => {
  assert.match(card, /job\.displayStatus === 'completed' \? tr\('已按次数完成，历史保留'\)/);
});

test('B/C-04 详情：maxRuns 存在时显示已运行 N / M', () => {
  assert.match(panel, /v-if="detail\.job\.spec\.trigger\.maxRuns"/);
  assert.match(panel, /detail\.runs\.length[\s\S]{0,80}detail\.job\.spec\.trigger\.maxRuns/, '已运行 N / M');
});
