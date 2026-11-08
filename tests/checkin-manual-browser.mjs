/**
 * 学生签到接入（批次 4）真实浏览器验收
 * ============================================================================
 *  管理员在 LabOps 桌面工作会话问"给 2023002 补录下午第一大节 E310 的签到…" →
 *  prepare_business_workflow 准备方案 → BusinessPlanCard(view=checkin) 带确认按钮
 *  → 点击确认提交 → 主系统回执（business-plan-…）入卡内 → 再问汇总：
 *  缺口由 2 变为 1（真实落库）。
 *  隔离口径与 checkin-summary-browser 同（只起虚构夹具，浏览器优先 Edge）。
 *  运行：node tests/checkin-manual-browser.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createReviewFixture } from '../scripts/create-review-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), agentRoot = path.join(root, 'labops-agent');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-checkin-manual-browser-'));
const fixture = createReviewFixture(path.join(temp, 'native'));
const shots = path.join(agentRoot, '.screenshots', 'manual'); fs.mkdirSync(shots, { recursive: true });
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

// 直接运行也必须与 run-tests.mjs 同口径切断磁盘 .env（测试不得调用付费模型）
process.env.LABOPS_SKIP_ENV_FILE = '1';
for (const k of ['AGNES_API_KEY', 'DASHSCOPE_API_KEY', 'VISION_API_KEY']) delete process.env[k];

// 夹具补一名未签到学号（代录目标必须在主系统存在：账号+凭据+名册）
{
  const read = (f) => JSON.parse(fs.readFileSync(path.join(temp, 'native', f), 'utf8'));
  const write = (f, v) => fs.writeFileSync(path.join(temp, 'native', f), JSON.stringify(v, null, 2), { mode: 0o600 });
  const wrapped = read('state.json');
  wrapped.state.classRoster.push({ sno: '2023002', className: '评审示例班' });
  wrapped.state.users.push({ username: '2023002', identity: 'student', className: '评审示例班', name: '评审学生二' });
  const password = crypto.randomBytes(12).toString('base64url'), salt = crypto.randomBytes(16).toString('hex');
  const creds = read('credentials.json');
  creds['2023002'] = { username: '2023002', identity: 'student', name: '评审学生二', className: '评审示例班', status: 'active', salt, hash: crypto.scryptSync(password, salt, 64).toString('hex'), mustChangePassword: false };
  write('credentials.json', creds);
  write('state.json', wrapped);
}
process.env.DATA_DIR = path.join(temp, 'native');
const nativeDb = createRequire(import.meta.url)('../../Pages/lib/db.js');
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
nativeDb.insertCheckin({ id: 'ck-m-browser-1', labId: 'fixture-e310', type: 'checkin', time: `${shDate} 14:05:00`, valid: true, username: 'review-student', className: '评审示例班', timetableId: 'fixture-lesson' });

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
  const { showConnections, closeSettings } = await import('./sidebar-actions.mjs');
  const errors = [];

  async function newWorkspace(who) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(20000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '?desktop=1');
    await page.locator('#username').fill('manual-' + who); await page.locator('#password').fill('demo-only');
    await page.locator('.login-btn').click(); await page.locator('#cmd').waitFor();
    await showConnections(page);
    await page.getByRole('button', { name: '连接管理', exact: true }).click();
    const account = fixture.accounts.find(a => a.identity === who);
    await page.locator('[name="native-account"]').fill(account.account);
    await page.locator('[name="native-password"]').fill(account.password);
    await page.getByRole('button', { name: '连接账号', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.business-panel').textContent.includes('原系统已连接'));
    await closeSettings(page);
    return { context, page, account };
  }

  const adminWs = await newWorkspace('admin'); debugPage = adminWs.page;
  await record('管理员问补录 → 方案卡出现 → 本人确认提交 → 主系统回执入卡', async () => {
    await send(adminWs.page, '给 2023002 补录今天下午第一大节在 E310 的签到，原因：设备故障无法扫码（隔离样例）');
    const answer = await adminWs.page.locator('.msg--assistant').last().innerText();
    assert.match(answer, /方案/, '应准备出待确认方案：' + answer);
    const card = adminWs.page.locator('.native-card[data-view="checkin"]');
    await card.waitFor({ state: 'visible', timeout: 20000 });
    const cardText = await card.first().innerText();
    assert.match(cardText, /2023002/, '方案卡必须显示目标学号');
    assert.match(cardText, /设备故障/, '方案卡必须显示代录原因');
    await card.first().screenshot({ path: path.join(shots, 'plan-before-confirm.png'), fullPage: false });
    const confirm = card.locator('[data-native-confirm]');
    assert.equal(await confirm.count(), 1, '必须有一个确认按钮');
    assert.equal(await confirm.first().isDisabled(), false, '方案未过期时确认按钮必须可用');
    await confirm.first().click();
    const receipt = card.locator('.native-receipt');
    await receipt.waitFor({ state: 'visible', timeout: 20000 });
    const receiptText = await receipt.first().innerText();
    assert.match(receiptText, /回执/, '提交后必须出现回执：' + receiptText);
    assert.match(receiptText, /checkin_record/, '回执对象必须带 checkin_record 标记');
    await adminWs.page.screenshot({ path: path.join(shots, 'receipt-after-confirm.png'), fullPage: false });
  });

  await record('提交后缺口真实闭合：再问汇总 应到2/已签到2/缺口0', async () => {
    await send(adminWs.page, '今天签到情况怎么样');
    const answer = await adminWs.page.locator('.msg--assistant').last().innerText();
    assert.ok(answer.includes('应到 2'), '应到必须来自补录后的名册（review-student + 2023002）：' + answer);
    assert.ok(answer.includes('已签到 2'), '补录后实到必须为 2：' + answer);
    assert.match(answer, /缺口 0|无账面缺口/, '补录后缺口应为 0：' + answer);
    await adminWs.page.screenshot({ path: path.join(shots, 'gap-closed.png'), fullPage: false });
  });

  assert.deepEqual(errors, [], '无页面错误：' + errors.join(' | '));
  console.log(JSON.stringify({ passed: results.length, failed: 0, results }, null, 2));
  fs.writeFileSync(path.join(shots, 'manual-results.json'), JSON.stringify({ passed: results.length, failed: 0, results }, null, 2));
} catch (e) {
  console.error(e);
  if (debugPage) {
    try {
      console.error('PAGE-URL ' + debugPage.url());
      console.error('PAGE-TEXT ' + (await debugPage.locator('body').innerText()).slice(0, 1500));
      await debugPage.screenshot({ path: path.join(shots, 'manual-failure.png'), fullPage: true });
    } catch (dumpErr) { console.error('dump failed: ' + dumpErr); }
  }
  console.error(logs.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(c => new Promise(r => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once('exit', r); setTimeout(() => { c.kill('SIGKILL'); r(); }, 1000); })));
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) { console.warn('cleanup skipped: ' + e.code); }
}
