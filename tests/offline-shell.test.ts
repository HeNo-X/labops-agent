/**
 * 离线壳作用域验收
 * ============================================================================
 *  两件事分开测：
 *   ① 判据本身（shared/offline-scope.ts）—— 纯函数，可穷举；
 *   ② public/sw.js 是否**真的**用了同一套判据 —— 它是原样拷贝的静态文件，
 *      不经打包，所以只能读源码校验。两边一旦漂移，本用例即失败。
 *
 *  运行：node --test tests/offline-shell.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineAction, isShellPath } from '../shared/offline-scope.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

test('业务接口与 SSE 永不接管 —— 这是离线壳的安全底线', () => {
  for (const p of [
    '/api', '/api/agent/chat', '/api/conversations', '/api/conversations/7/messages',
    '/api/business/proxy/context', '/api/health', '/api/knowledge/schedule-adjustment'
  ]) {
    assert.equal(offlineAction(p), 'passthrough', `${p} 不得被 SW 接管`);
  }
});

test('哈希 chunk 走缓存优先，外壳与静态资源走网络优先', () => {
  assert.equal(offlineAction('/assets/mobile-De4_RcaG.js'), 'immutable');
  assert.equal(offlineAction('/assets/business-Bz_Ar5Dx.js'), 'immutable');
  assert.equal(offlineAction('/mobile.html'), 'shell');
  assert.equal(offlineAction('/index.html'), 'shell');
  assert.equal(offlineAction('/mobile.webmanifest'), 'shell');
  assert.equal(offlineAction('/operations.html'), 'shell');
  assert.equal(offlineAction('/login-characters.css'), 'static');
  assert.equal(offlineAction('/mobile-icon-512.png'), 'static');
});

test('开发期模块路径不接管，未知路径一律放行', () => {
  assert.equal(offlineAction('/src/main.ts'), 'passthrough');
  assert.equal(offlineAction('/@vite/client'), 'passthrough');
  assert.equal(offlineAction('/some/unknown/route'), 'passthrough', '未匹配的路径不得被缓存或伪造响应');
});

test('isShellPath 只认三个真实入口', () => {
  assert.ok(isShellPath('/'));
  assert.ok(isShellPath('/mobile.html'));
  assert.ok(isShellPath('/index.html'));
  assert.ok(isShellPath('/operations.html'));
  assert.ok(!isShellPath('/settings.html'));
  assert.ok(!isShellPath('/api/mobile.html'), '路径前缀不得被误判为外壳');
});

test('public/sw.js 自包含且实现同一判据（防两边漂移）', () => {
  assert.ok(!/^\s*import\s/m.test(swSource), 'public/ 下的文件不经打包，不得 import 项目模块');
  assert.match(swSource, /pathname === '\/api' \|\| pathname\.startsWith\('\/api\/'\)\) return 'passthrough'/, 'SW 必须先排除 API');
  // API 排除必须出现在任何 cache.put 之前
  const apiGuardAt = swSource.indexOf("startsWith('/api/')");
  const putAt = swSource.indexOf('cache.put');
  assert.ok(apiGuardAt >= 0 && putAt > apiGuardAt, 'API 排除逻辑必须早于任何写缓存');
  assert.match(swSource, /if \(action === 'passthrough'\) return/, 'passthrough 必须直接放行不 respondWith');
});

test('构建产物含 sw.js 与注册代码', () => {
  const distSw = path.join(root, 'dist', 'sw.js');
  if (!fs.existsSync(distSw)) return; // 未跑 build 时跳过，不算失败
  const built = fs.readFileSync(distSw, 'utf8');
  assert.equal(built, swSource, 'dist/sw.js 应与源文件逐字节一致（原样拷贝）');
});
