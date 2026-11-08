/**
 * 学生签到接入（批次 1）真实浏览器验收
 * ============================================================================
 *  场景一：学生在 LabOps 内以本人主系统账号提问"我签到了吗"，演示引擎确定性路由
 *          调用 query_checkin_status，回答来自主系统真实签到数据（工具轨迹显示
 *          「查询签到状态」）。
 *  场景二：回答里的签到入口路径在主系统真实可达——未登录先跳登录页，登录后回到
 *          student-checkin.html?lab=…，二维码参数锁定与课程归属照常工作。
 *
 *  隔离口径与 next-browser 相同：只起本地虚构夹具服务；本机浏览器优先 Edge
 *  （LABOPS_BROWSER_PATH，缺省探测 msedge），无则回落 Chrome。
 *  运行：node tests/checkin-browser.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createReviewFixture } from '../scripts/create-review-fixture.mjs';

// 直接运行也必须与 run-tests.mjs 同口径切断磁盘 .env（测试不得调用付费模型）
process.env.LABOPS_SKIP_ENV_FILE = '1';
for (const k of ['AGNES_API_KEY', 'DASHSCOPE_API_KEY', 'VISION_API_KEY']) delete process.env[k];

const root = fileURLToPath(new URL('../../', import.meta.url)), agentRoot = path.join(root, 'labops-agent');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-checkin-browser-'));
const fixture = createReviewFixture(path.join(temp, 'native'));
const shots = path.join(agentRoot, '.screenshots', 'checkin'); fs.mkdirSync(shots, { recursive: true });
const results = [], children = []; let browser, debugPage, logs = '';
async function freePort() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function launch(file, env) { const child = spawn(process.execPath, [file], { cwd: agentRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); child.stdout.on('data', c => { logs += c.toString(); }); child.stderr.on('data', c => { logs += c.toString(); }); return child; }
async function ready(url, child) { for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error('启动失败：' + logs); try { if ((await fetch(url + '/api/health')).ok) return; } catch { } await new Promise(r => setTimeout(r, 50)); } throw new Error('启动超时：' + logs); }
async function record(name, fn) { console.log('RUN ' + name); await fn(); results.push({ name, pass: true }); console.log('PASS ' + name); }
async function send(page, message) {
  const n = await page.locator('.msg--assistant').count();
  await page.locator('#cmd').fill(message);
  await page.locator('.bar__btn').click();
  await page.waitForFunction((c) => document.querySelectorAll('.msg--assistant').length > c, n, { timeout: 20000 });
  await page.waitForFunction(() => { const m = [...document.querySelectorAll('.msg--assistant')].at(-1); return m && m.dataset.status !== 'streaming'; }, null, { timeout: 20000 });
  assert.equal(await page.locator('.msg--assistant').last().getAttribute('data-status'), 'completed');
}

// ⚠️ 记录类唯一权威是 SQLite：评审夹具学生的签到记录必须走主系统数据层写入
process.env.DATA_DIR = path.join(temp, 'native');
const nativeDb = createRequire(import.meta.url)('../../Pages/lib/db.js');
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
nativeDb.insertCheckin({ id: 'ck-browser-1', labId: 'fixture-e310', type: 'checkin', time: `${shDate} 14:05:00`, valid: true, username: 'review-student', className: '评审示例班', timetableId: 'fixture-lesson' });

try {
  const nativePort = await freePort(), agentPort = await freePort();
  const nativeUrl = `http://127.0.0.1:${nativePort}`, base = `http://127.0.0.1:${agentPort}`;
  const native = await launch(path.join(root, 'Pages', 'serve.js'), { HOST: '127.0.0.1', PORT: String(nativePort), DATA_DIR: path.join(temp, 'native'), REGISTER_OPEN: '0', ENABLE_SEED_ACCOUNTS: '0', ENABLE_BASE_SEED: '0' });
  const agent = await launch(path.join(agentRoot, 'server', 'index.ts'), { HOST: '127.0.0.1', PORT: String(agentPort), LABOPS_DB_PATH: path.join(temp, 'agent.sqlite'), LABOPS_BUSINESS_URL: nativeUrl, AGNES_API_KEY: '', LIVE_DATA: '0', LABOPS_AUTH_MODE: 'demo', LABOPS_SECURE_COOKIE: '0', LOG_LEVEL: 'warn' });
  await ready(nativeUrl, native); await ready(base, agent);
  const executablePath = [process.env.LABOPS_BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
  if (!executablePath) throw new Error('请安装 Edge/Chrome 并设置 LABOPS_BROWSER_PATH');
  console.log('BROWSER ' + executablePath);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors = [];
  debugPage = page;
  page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(20000); page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') logs += '\n[console.error] ' + m.text(); });
  page.on('requestfailed', r => { logs += '\n[requestfailed] ' + r.url() + ' ' + (r.failure()?.errorText || ''); });
  page.on('response', r => { if (r.status() >= 400 && r.url().includes('/api/')) logs += `\n[http ${r.status()}] ${r.request().method()} ${r.url()}`; });
  const account = fixture.accounts.find(a => a.identity === 'student');

  await record('学生在 LabOps 以本人账号连接并提问签到状态', async () => {
    await page.goto(base + '?desktop=1');
    await page.locator('#username').fill('checkin-review'); await page.locator('#password').fill('demo-only');
    await page.locator('.login-btn').click(); await page.locator('#cmd').waitFor();
    await (await import('./sidebar-actions.mjs')).showConnections(page);
    await page.getByRole('button', { name: '连接管理', exact: true }).click();
    await page.locator('[name="native-account"]').fill(account.account);
    await page.locator('[name="native-password"]').fill(account.password);
    await page.getByRole('button', { name: '连接账号', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.business-panel').textContent.includes('原系统已连接'));
    await (await import('./sidebar-actions.mjs')).closeSettings(page);
    await send(page, '我签到了吗');
    const answer = await page.locator('.msg--assistant').last().innerText();
    assert.ok(answer.includes('示例程序设计'), '回答必须来自真实课程：' + answer);
    assert.ok(answer.includes('E310'), '回答必须包含真实实验室：' + answer);
    assert.match(answer, /已签到|未签到/);
    assert.ok(answer.includes('本人在场') || answer.includes('不代签') || (await page.locator('.msg--assistant').last().innerText()).includes('Agent 不代签'), '边界文案必须在场');
    await page.screenshot({ path: path.join(shots, 'student-checkin-answer.png'), fullPage: false });
  });

  await record('工具轨迹以「查询签到状态」呈现，不出现办理单卡', async () => {
    assert.ok(await page.getByText('查询签到状态', { exact: true }).count() >= 1, '工具中文名必须来自 turn-view 单一事实源');
    assert.equal(await page.locator('[data-native-confirm]:enabled').count(), 0, '只读查询不得产生确认按钮');
  });

  await record('签到入口直达主系统：登录后回到签到页且二维码参数锁定生效', async () => {
    const studentPage = await context.newPage(); debugPage = studentPage;
    studentPage.on('pageerror', e => errors.push(e.message));
    await studentPage.goto(nativeUrl + '/student-checkin.html?lab=fixture-e310');
    if (studentPage.url().includes('login.html')) {
      await studentPage.locator('input[placeholder="请输入账号"]').fill(account.account);
      const pwd = studentPage.locator('input[placeholder="请输入密码"]');
      await pwd.fill(account.password);
      await pwd.press('Enter'); // 登录页有常驻动画，submit 按钮对 Playwright 永不 stable；用回车提交
    }
    await studentPage.waitForURL(/student-checkin\.html/, { timeout: 20000 });
    await studentPage.waitForFunction(() => document.body.textContent.includes('已锁定'), null, { timeout: 20000 });
    assert.ok((await studentPage.locator('body').innerText()).includes('E310'), '签到页应显示锁定的实验室名称');
    await studentPage.evaluate(() => document.fonts.ready);
    await studentPage.screenshot({ path: path.join(shots, 'native-checkin-deeplink.png'), fullPage: false });
    await studentPage.close(); debugPage = page;
  });

  assert.deepEqual(errors, [], '无页面错误：' + errors.join(' | '));
  console.log(JSON.stringify({ passed: results.length, failed: 0, results }, null, 2));
  fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify({ passed: results.length, failed: 0, results }, null, 2));
} catch (e) {
  console.error(e);
  if (debugPage) {
    try {
      console.error('PAGE-URL ' + debugPage.url());
      console.error('PAGE-TEXT ' + (await debugPage.locator('body').innerText()).slice(0, 1500));
      await debugPage.screenshot({ path: path.join(shots, 'failure.png'), fullPage: true });
    } catch (dumpErr) { console.error('dump failed: ' + dumpErr); }
  }
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(c => new Promise(r => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once('exit', r); setTimeout(() => { c.kill('SIGKILL'); r(); }, 1000); })));
  // Windows 下子进程句柄释放有延迟，rmSync 偶发 EPERM（04 §15 环境噪声）：清不掉就留在系统临时目录
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) { console.warn('cleanup skipped: ' + e.code); }
}
