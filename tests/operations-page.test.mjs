/**
 * 工作台页面资源可用性验收（operations.html）
 * ============================================================================
 *  这个页面曾因 `sync-rules` 镜像清单漏了 client-runtime.js 而在发布包里 404，
 *  控制台报 `LabClient is not defined`。check:rules 已补上"引用必须存在"的静态检查，
 *  但**静态检查证明不了运行时可用** —— 文件在、路径错、或被服务端 DENY 掉，
 *  都只有真加载一次才会暴露。本用例就是补这一层。
 *
 *  它不起主系统、不登录、不调模型：只做"构建产物里的这个页面能否自洽加载"。
 *
 *  运行：LABOPS_BROWSER_PATH=<chromium> node tests/operations-page.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

if (!fs.existsSync(path.join(dist, 'operations.html'))) {
  console.error('dist/operations.html 不存在，先执行 npm run build');
  process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.resolve(dist, rel || 'index.html');
  // 只允许 dist 内，且拒绝源码/数据目录 —— 与真实服务端的静态策略同向
  if (!file.startsWith(dist) || /(server|node_modules|\.sqlite|\.env)/.test(path.relative(dist, file))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const executablePath = [process.env.LABOPS_BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find((p) => p && fs.existsSync(p));
if (!executablePath) {
  server.close();
  console.error('未找到浏览器：请设置 LABOPS_BROWSER_PATH（本用例需要真实 Chromium 系浏览器）');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let failed = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};

try {
  const page = await browser.newPage();
  const requested = [];
  const failedRequests = [];
  const consoleErrors = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  page.on('requestfailed', (r) => failedRequests.push(new URL(r.url()).pathname));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${new URL(r.url()).pathname} ${r.status()}`); });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

  await page.goto(`${base}/operations.html`, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  check('client-runtime.js 被请求且未 404',
    requested.includes('/lib/client-runtime.js') && !failedRequests.some((f) => f.includes('client-runtime')),
    failedRequests.filter((f) => f.includes('client-runtime')).join(',') || '200');
  check('operations-ui.js 被请求且未 404',
    requested.includes('/lib/operations-ui.js') && !failedRequests.some((f) => f.includes('operations-ui')));
  // 这是当初的真实故障症状
  const globals = await page.evaluate(() => ({
    labClient: typeof window.LabClient,
    ui: typeof window.OperationsUI ?? typeof window.operationsUI ?? typeof window.LabOpsOperations
  }));
  check('LabClient 已定义（原故障为 undefined）', globals.labClient !== 'undefined', JSON.stringify(globals));
  check('页面无 JS 运行时异常', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  // 只判静态子资源：本用例的替身服务器**故意不代理主系统 API**，
  // 页面起来后请求 /api/integration/context 拿 404 是预期行为，不该算失败。
  const staticFailures = failedRequests.filter((f) => !f.startsWith('/api'));
  check('无 4xx/5xx 静态子资源', staticFailures.length === 0, staticFailures.slice(0, 3).join(', '));
  const body = await page.locator('body').innerText();
  check('页面渲染出内容而非空白', body.trim().length > 0, `${body.trim().length} 字`);
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error(`\n${failed} 项未通过`);
  process.exit(1);
}
console.log('\n工作台页面可自洽加载。');
