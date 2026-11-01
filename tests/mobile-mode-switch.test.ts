/**
 * A10 移动端模式开关——源级断言（移动端无单测挂载，沿用 T7 源反射手法）
 * ============================================================================
 *  锁死：MobileConversation 有真实的切换入口（不是只读标签）——两档按钮走
 *  session.changeConversationMode（服务端契约已被 round-actions 测试覆盖），
 *  busy/切换中禁用，失败走既有 error 行；R6：不做平台分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../web/mobile/MobileConversation.vue', import.meta.url)), 'utf8');

test('A10-移动端 会话页有模式分段开关且走 changeConversationMode', () => {
  assert.match(src, /m-mode-switch__opt/, '存在分段开关按钮');
  assert.match(src, /changeConversationMode\(props\.conversationId/, '切换走 session.changeConversationMode（服务端契约）');
  assert.match(src, /setMode\('task'\)/, '左=工作会话');
  assert.match(src, /setMode\('chat'\)/, '右=聊天会话');
  assert.match(src, /:disabled="switching\|\|busy"/, '运行中/切换中禁用');
});

test('A10-移动端 失败走既有 error 行；同模式不重复提交；无平台分支', () => {
  assert.match(src, /error\.value=\(e as Error\)\.message/, '切换失败进既有错误行');
  assert.match(src, /if\(m===mode\.value\|\|switching\.value\|\|busy\.value\)return/, '同模式与忙态直接返回');
  assert.ok(!/isMobile|platform\s*===|userAgent/.test(src), '不做平台分支（R6）');
});
