/**
 * 一条命令同时起服务端与前端（零依赖，不引 concurrently）
 * ============================================================================
 *  为什么自己拼：concurrently / npm-run-all 为了跑两个子进程要拖进一整套依赖树，
 *  而这里只需要 spawn 两个进程 + 转发信号 + 任一退出就收工。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const children = [];

function run(name, bin, args, color) {
  const child = spawn(bin, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: isWin
  });
  children.push(child);
  const tag = `\u001b[${color}m[${name}]\u001b[0m `;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(tag + line + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code, signal) => {
    process.stdout.write(tag + `退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）\n`);
    // 任一进程退出 → 全部收工，避免留下孤儿进程占端口
    shutdown(code ?? 0);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) {
      try {
        c.kill('SIGTERM');
      } catch {
        /* 忽略 */
      }
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('启动：服务端（node --watch + 原生 TS）+ 前端（Vite）…');
console.log('提示：前端 http://127.0.0.1:5173 已把 /api 代理到服务端 8787，');
console.log('      直接开前端地址即可，不需要单独访问服务端端口。');
console.log('      需要 Node >= 22.18（原生 TypeScript 类型剥离；本项目不依赖 tsx/esbuild）。\n');

run('server', process.execPath, ['--watch', 'server/index.ts'], '36');
run('web', isWin ? 'npx.cmd' : 'npx', ['vite'], '35');
