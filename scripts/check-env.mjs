/**
 * 环境自检 —— 启动前把该知道的都问清楚，避免用报错当提示
 * 用法：node scripts/check-env.mjs
 * 退出码：0 = 可以直接启动；1 = 必须先处理某项
 *
 * 只用 node 内置模块：它在 npm install 之前就要能跑。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 尊重 NO_COLOR（https://no-color.org）：终端不支持 ANSI 时用户可以关掉 */
const useColor = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

const C = {
  ok: (s) => wrap(32, s),
  warn: (s) => wrap(33, s),
  err: (s) => wrap(31, s),
  dim: (s) => wrap(2, s)
};

const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 18;

const blockers = [];
const warnings = [];
const notes = [];

function line(mark, title, detail) {
  console.log(`  ${mark} ${title}${detail ? C.dim('  ' + detail) : ''}`);
}

// ---------------------------------------------------------------- Node 版本
{
  const raw = process.versions.node;
  const [maj, min] = raw.split('.').map(Number);
  const ok = maj > REQUIRED_MAJOR || (maj === REQUIRED_MAJOR && min >= REQUIRED_MINOR);
  if (ok) {
    line(C.ok('✓'), 'Node 版本', `${raw}（要求 ≥ ${REQUIRED_MAJOR}.${REQUIRED_MINOR}）`);
  } else {
    line(C.err('✗'), 'Node 版本', `${raw} —— 低于要求的 ${REQUIRED_MAJOR}.${REQUIRED_MINOR}`);
    blockers.push(
      `Node 版本过低（${raw}）。本项目用 Node 原生 TypeScript 类型剥离，不依赖 tsx/esbuild，` +
        `因此必须 ≥ ${REQUIRED_MAJOR}.${REQUIRED_MINOR}。请升级 Node：https://nodejs.org/`
    );
  }
}

// ---------------------------------------------------------------- 依赖
{
  const hasModules = fs.existsSync(path.join(ROOT, 'node_modules'));
  const hasLock = fs.existsSync(path.join(ROOT, 'package-lock.json'));
  if (hasModules) line(C.ok('✓'), '依赖', 'node_modules 已就位');
  else {
    line(C.warn('!'), '依赖', 'node_modules 不存在 —— 需要先装');
    notes.push('将自动执行 npm install');
    void hasLock;
  }
}

// ---------------------------------------------------------------- 前端产物
{
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) line(C.ok('✓'), '前端产物', 'dist/index.html 已就位');
  else {
    line(C.warn('!'), '前端产物', 'dist/ 不存在 —— 需要先构建');
    notes.push('将自动执行 npm run build');
  }
}

// ---------------------------------------------------------------- 数据源
{
  const snap = path.join(ROOT, 'seed', 'snapshot.json');
  const fb = path.join(ROOT, 'seed', 'fallback-demo.json');
  if (fs.existsSync(snap)) {
    try {
      const j = JSON.parse(fs.readFileSync(snap, 'utf8'));
      const c = j?.meta?.counts ?? {};
      line(
        C.ok('✓'),
        '数据来源',
        `脱敏快照：实验室 ${c.labs ?? '?'} + 开放 ${c.openLabs ?? '?'} / 课表 ${c.timetable ?? '?'} 条` +
          `｜学期 ${j?.term?.term ?? '?'}，起始 ${j?.term?.termStart ?? '未配置'}`
      );
      if (!j?.term?.termStart) {
        warnings.push('快照里 termStart 缺失 → 教学周无法确定，结果会标注为"有条件的结论"');
      }
    } catch (e) {
      line(C.err('✗'), '数据来源', `snapshot.json 解析失败：${e.message}`);
      blockers.push('seed/snapshot.json 不是合法 JSON，请重新生成：npm run seed -- <真实 state.json 路径>');
    }
  } else if (fs.existsSync(fb)) {
    line(C.warn('!'), '数据来源', '未找到脱敏快照 → 将使用模拟演示数据（房间号 DEMO- 开头）');
    warnings.push('当前是模拟演示数据，与真实实验室无关。要用真实数据请先跑：npm run seed -- <真实 state.json 路径>');
  } else {
    line(C.err('✗'), '数据来源', '既没有 snapshot.json 也没有 fallback-demo.json');
    blockers.push('没有任何可用数据文件，服务端会拒绝启动。请运行：npm run seed -- <真实 state.json 路径>');
  }
}

// ---------------------------------------------------------------- 推理引擎
{
  const envPath = path.join(ROOT, '.env');
  let key = process.env.AGNES_API_KEY ?? '';
  let fromEnvFile = false;
  if (!key && fs.existsSync(envPath)) {
    const m = /^\s*AGNES_API_KEY\s*=\s*(.+)$/m.exec(fs.readFileSync(envPath, 'utf8'));
    if (m && m[1].trim()) {
      key = m[1].trim();
      fromEnvFile = true;
    }
  }
  if (key) {
    line(C.ok('✓'), '推理引擎', `Agnes 3.0 Flash（Key 已配置${fromEnvFile ? '，来自 .env' : '，来自环境变量'}）`);
    notes.push('真实模型会参与工具选择；真实调用若失败会显示错误，不会静默退回演示引擎');
  } else {
    line(C.warn('!'), '推理引擎', '演示引擎（未配置 AGNES_API_KEY）');
    warnings.push(
      '未配置 AGNES_API_KEY → 回答由服务端规则引擎生成，界面与回答都会明确标注，未调用大模型。' +
        '要切到真实模型：复制 .env.example 为 .env 并填入 Key，然后重启。'
    );
  }
}

// ---------------------------------------------------------------- 端口
async function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? 'busy' : 'error'));
    srv.once('listening', () => srv.close(() => resolve('free')));
    srv.listen(port, '127.0.0.1');
  });
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
{
  const state = await checkPort(PORT);
  if (state === 'free') line(C.ok('✓'), '端口', `${PORT} 可用`);
  else if (state === 'busy') {
    line(C.err('✗'), '端口', `${PORT} 已被占用`);
    blockers.push(
      `端口 ${PORT} 已被占用。可能已经有一个实例在跑 —— 先试试直接打开 http://127.0.0.1:${PORT}；` +
        `或者换个端口启动：PORT=8799 npm run dev`
    );
  } else {
    line(C.warn('!'), '端口', `${PORT} 状态未知`);
  }
}

// ---------------------------------------------------------------- 输出
console.log('');
if (notes.length) {
  console.log(C.dim('  将要自动做的事：'));
  for (const n of notes) console.log(C.dim('    · ' + n));
  console.log('');
}
if (warnings.length) {
  for (const w of warnings) console.log(C.warn('  ⚠️  ' + w));
  if (warnings.length) console.log('');
}

if (blockers.length) {
  console.log(C.err('  ✗ 无法启动，请先处理：'));
  for (const b of blockers) console.log(C.err('    · ' + b));
  console.log('');
  process.exit(1);
}

console.log(C.ok(`  ✓ 环境就绪 —— 启动后访问 http://${HOST}:${PORT}`));
if (HOST === '127.0.0.1') {
  console.log(C.dim('    （默认只监听本机。要在手机上看，用 HOST=0.0.0.0 启动）'));
}
console.log('');
process.exit(0);
