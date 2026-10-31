/**
 * A6 配额感知的诚实降级
 * ============================================================================
 *  2026-10-30 部署实测：账号免费额度耗尽时，7 个模型逐个 403
 *  AllocationQuota.FreeTierOnly，旧 classify 把它归为 agnes_auth_failed
 *  （提示"检查 KEY"——误导），且 fallback 链把其余模型白试一遍。
 *  本文件锁死三件事：
 *    ① 403 + 配额签名 → agnes_quota_exhausted（不再误报鉴权失败）；
 *    ② 配额错误**短路整条链**（账号级配额对链上所有模型同样生效，上游只被打 1 次）；
 *    ③ 非配额的 403（真鉴权失败）仍照常走完整条链（分类必须可区分，上游被打 2 次）。
 *
 *  ② ③ 用自包含子进程探针（tests/fixtures/quota-probe.ts，假上游由子进程自己起）：
 *  config 进程内只读一次配置，两个场景必须各起一个进程；且父进程不能用
 *  execFileSync——它会冻结自己的事件循环，与回连父进程的子进程互等死锁。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isQuotaExhaustedResponse } from '../server/llm/agnes.ts';

const PROBE = fileURLToPath(new URL('./fixtures/quota-probe.ts', import.meta.url));

interface ProbeResult {
  code: string | null;
  hits: number;
}

function runProbe(scenario: 'quota' | 'auth'): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, scenario], {
      env: { ...process.env, LABOPS_AUTH_MODE: 'demo' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`探针 30s 未完成：stdout=${out.slice(-200)} stderr=${err.slice(-300)}`));
    }, 30000);
    child.stdout.on('data', (d: Buffer) => { out += String(d); });
    child.stderr.on('data', (d: Buffer) => { err += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code_) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (code_ === 0 && line) {
        try { resolve(JSON.parse(line) as ProbeResult); return; } catch (e) { reject(e); return; }
      }
      reject(new Error(`探针异常退出 code=${code_}：${err.slice(-400)}`));
    });
  });
}

test('A6-01 分类：403+配额签名 → 配额耗尽；403 裸响应仍是鉴权失败', () => {
  assert.equal(isQuotaExhaustedResponse(403, '{"error":"AllocationQuota.FreeTierOnly","message":"add funds or disable the use-free-tier-only mode"}'), true);
  assert.equal(isQuotaExhaustedResponse(403, '{"code":"Arrearage","message":"您的账户已欠费"}'), true);
  assert.equal(isQuotaExhaustedResponse(403, '{"code":"InvalidApiKey","message":"无效的 API Key"}'), false, '裸 403 不带配额签名 → 鉴权失败');
  assert.equal(isQuotaExhaustedResponse(401, 'AllocationQuota.FreeTierOnly'), false, '401 即便提到配额也不是 403 配额语义');
  assert.equal(isQuotaExhaustedResponse(429, 'rate limit exceeded'), false, '429 是限流（可自愈），不是配额耗尽');
  assert.equal(isQuotaExhaustedResponse(200, 'ok'), false);
});

test('A6-02 配额耗尽短路整条链：两个模型只打上游一次，错误码如实', async () => {
  const r = await runProbe('quota');
  assert.equal(r.code, 'agnes_quota_exhausted', '不得误报为 agnes_auth_failed');
  assert.equal(r.hits, 1, '账号级配额不得再试链上第二个模型（试了也白烧）');
});

test('A6-03 非配额的 403（真鉴权失败）仍照常走完整条链', async () => {
  const r = await runProbe('auth');
  assert.equal(r.code, 'agnes_auth_failed');
  assert.equal(r.hits, 2, '普通鉴权失败保留原 fallback 行为：两个模型都试过');
});
