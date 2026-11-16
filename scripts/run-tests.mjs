#!/usr/bin/env node
/**
 * 测试入口：在**确定净化**的环境下跑 node:test。
 * ============================================================================
 *  为什么要有这个文件：开发机系统环境里存在真实 DASHSCOPE_API_KEY，而多数测试
 *  只清了 AGNES_API_KEY ⇒ 自称"确定性规则引擎"的用例实际在真实调用付费模型，
 *  表现为偶发 truncated_response / 超时，并消耗真实额度。
 *
 *  做法：在**进程环境层面**摘掉三把模型 Key，而不是在 config 里加"测试闸门"——
 *  闸门会连测试自己设的替身 Key 一起清空（会打断 reliability 用例），
 *  而摘环境只影响"从系统继承来的真 Key"，测试代码里显式设置的替身 Key 照常生效。
 *
 *  真模型评测不走这里，走 scripts/evaluate-model.ts 与 evaluate-release.mjs。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从给定环境中摘掉所有模型类凭据（供测试直接验证） */
export function sanitizedEnv(base = process.env) {
  const env = { ...base };
  for (const k of ['AGNES_API_KEY', 'DASHSCOPE_API_KEY', 'VISION_API_KEY']) delete env[k];
  // 只删 Key 不够：config.ensureEnv() 会 loadEnvFile('.env')，而它只补「未设置」的
  // 变量 —— 刚删掉的会被 .env 全部补回（含 BIGMODEL_/XFYUN_ 备用链与真实 Key），
  // 导致夹具被真实配置污染、且真连外网。这个开关让子进程连 .env 都不读。
  env.LABOPS_SKIP_ENV_FILE = '1';
  return env;
}

/** 显式展开测试文件，避免 Windows 下 glob 不生效 */
export function testFiles() {
  return fs
    .readdirSync(path.join(root, 'tests'))
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => path.join('tests', f));
}

// 仅在直接执行时跑测试（被 import 时只导出函数）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args =
    process.argv.length > 2
      ? process.argv.slice(2)
      : ['--test', '--test-concurrency=1', ...testFiles()];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: sanitizedEnv(),
    stdio: 'inherit',
    shell: false
  });
  process.exit(result.status ?? 1);
}
