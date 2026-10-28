/**
 * 模型 Key 测试隔离验收
 * ============================================================================
 *  起因：开发机系统环境里存在真实 DASHSCOPE_API_KEY，而多数测试只清了
 *  AGNES_API_KEY ⇒ 自称"确定性规则引擎"的用例实际在真实调用付费模型，
 *  表现为偶发 truncated_response / 超时，并消耗真实额度。
 *
 *  本用例锁死：`npm test`（scripts/run-tests.mjs）派生的测试进程拿不到环境模型 Key；
 *  而测试代码里**显式设定**的替身 Key 不受影响（这是刻意不用 config 闸门的原因——
 *  闸门会把替身 Key 一起清掉，实测打断 reliability 两个用例）。
 *
 *  运行：node --test tests/config-key-isolation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error 测试入口是普通 JS，无构建产物；只用到它导出的两个函数
import { sanitizedEnv } from '../scripts/run-tests.mjs';

// 刻意不用 `sk-` 前缀：作品包审计器会拦任何 sk- 形态字符串（宁误拦不漏放），
// 测试替身没必要长得像真凭据。
const CANARY = 'CANARY-NOT-A-REAL-KEY-0123456789abcdef';
const root = fileURLToPath(new URL('..', import.meta.url));

test('净化函数摘掉全部三把模型 Key，其它变量原样保留', () => {
  const out = sanitizedEnv({
    AGNES_API_KEY: CANARY,
    DASHSCOPE_API_KEY: CANARY,
    VISION_API_KEY: CANARY,
    LABOPS_BUSINESS_URL: 'https://example.test',
    LOG_LEVEL: 'warn'
  });
  assert.equal(out.AGNES_API_KEY, undefined);
  assert.equal(out.DASHSCOPE_API_KEY, undefined);
  assert.equal(out.VISION_API_KEY, undefined);
  assert.equal(out.LABOPS_BUSINESS_URL, 'https://example.test', '非凭据配置不得被顺手清掉');
  assert.equal(out.LOG_LEVEL, 'warn');
});

test('净化后的子进程读不到环境 Key，但能读到测试自己设的替身 Key', () => {
  const probe =
    "const c=await import('./server/config.ts');const g=c.getConfig();" +
    "console.log(JSON.stringify({inherited:g.dashscope.apiKey,own:g.vision.apiKey}));";
  // 继承环境里有一把"真"Key —— 净化后子进程应当拿不到
  const stripped = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root,
      env: { ...sanitizedEnv({ ...process.env, DASHSCOPE_API_KEY: CANARY }) },
      encoding: 'utf8'
    }).trim().split('\n').pop()!
  ) as { inherited: string; own: string };
  assert.equal(stripped.inherited, '', '环境残留的真 Key 不得进入测试进程');

  // 测试代码显式设定的替身 Key 必须照常生效
  const withStub = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root,
      env: { ...sanitizedEnv({ ...process.env, DASHSCOPE_API_KEY: CANARY }), VISION_API_KEY: 'stub-for-local-fake' },
      encoding: 'utf8'
    }).trim().split('\n').pop()!
  ) as { inherited: string; own: string };
  assert.equal(withStub.own, 'stub-for-local-fake', '替身 Key 必须可用，否则桩测试无法测模型路径');
});

test('视觉 Key 缺省时回落 DashScope', () => {
  const probe =
    "const c=await import('./server/config.ts');console.log(JSON.stringify(c.getConfig().vision.apiKey));";
  const out = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root,
      env: { ...sanitizedEnv({ ...process.env }), DASHSCOPE_API_KEY: CANARY, VISION_API_KEY: '' },
      encoding: 'utf8'
    }).trim().split('\n').pop()!
  ) as string;
  assert.equal(out, CANARY, '未单独配 VISION_API_KEY 时应复用 DashScope');
});
