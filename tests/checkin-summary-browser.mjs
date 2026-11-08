/**
 * 学生签到接入（批次 2）真实浏览器验收
 * ============================================================================
 *  场景一：管理员在 LabOps 问"今天签到情况怎么样"，query_checkin_summary 返回真实
 *          应到/已签到/缺口与未签到学号名单，回答带"请勿代替学生签到"口径。
 *  场景二：学生问同一句话 → 路由到 query_checkin_status（本人状态），拿不到缺口名单。
 *
 *  隔离口径与 checkin-browser 相同：本地虚构夹具；本机浏览器优先 Edge。
 *  运行：node tests/checkin-summary-browser.mjs
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

const root = fileURLToPath(new URL('../../', import.meta.url)), agentRoot = path.join(root, 'labops-agent');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-checkin-sum-browser-'));
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

// 直接运行也必须与 run-tests.mjs 同口径切断磁盘 .env（测试不得调用付费模型）
process.env.LABOPS_SKIP_ENV_FILE = '1';
for (const k of ['AGNES_API_KEY', 'DASHSCOPE_API_KEY', 'VISION_API_KEY']) delete process.env[k];

// 夹具名册补两名未签到学号（只动名册；签到记录唯一权威是 SQLite）
{
  const read = (f) => JSON.parse(fs.readFileSync(path.join(temp, 'native', f), 'utf8'));
  const write = (f, v) => fs.writeFileSync(path.join(temp, 'native', f), JSON.stringify(v, null, 2), { mode: 0o600 });
  const wrapped = read('state.json');
  wrapped.state.classRoster.push({ sno: '2023002', className: '评审示例班' }, { sno: '2023003', className: '评审示例班' });
  write('state.json', wrapped);
}
process.env.DATA_DIR = path.join(temp, 'native');
const nativeDb = createRequire(import.meta.url)('../../Pages/lib/db.js');
const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
nativeDb.insertCheckin({ id: 'ck-sum-browser-1', labId: 'fixture-e310', type: 'checkin', time: `${shDate} 14:05:00`, valid: true, username: 'review-student', className: '评审示例班', timetableId: 'fixture-lesson' });

try {
  const nativePort = await freePort(), agentPort = await freePort();
  const base = `http://127.0.0.1:${agentPort}`;
  const native = await launch(path.join(root, 'Pages', 'serve.js'), { HOST: '127.0.0.1', PORT: String(nativePort), DATA_DIR: path.join(temp, 'native'), REGISTER_OPEN: '0', ENABLE_SEED_ACCOUNTS: '0', ENABLE_BASE_SEED: '0' });
  const agent = await launch(path.join(agentRoot, 'server', 'index.ts'), { HOST: '127.0.0.1', PORT: String(agentPort), LABOPS_DB_PATH: path.join(temp, 'agent.sqlite'), LABOPS_BUSINESS_URL: `http://127.0.0.1:${nativePort}`, AGNES_API_KEY: '', LIVE_DATA: '0', LABOPS_AUTH_MODE: 'demo', LABOPS_SECURE_COOKIE: '0', LOG_LEVEL: 'warn' });
  await ready(`http://127.0.0.1:${nativePort}`, native); await ready(base, agent);
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
    await page.locator('#username').fill('sum-' + who); await page.locator('#password').fill('demo-only');
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
  await record('管理员问签到情况：真实汇总（应到/缺口/学号名单）+ 红线口径 + 结果卡', async () => {
    await send(adminWs.page, '今天签到情况怎么样');
    const answer = await adminWs.page.locator('.msg--assistant').last().innerText();
    assert.ok(answer.includes('应到 3'), '应到必须来自补录后的名册：' + answer);
    assert.ok(answer.includes('已签到 1'), '实到必须来自真实签到记录：' + answer);
    assert.ok(answer.includes('2023002') && answer.includes('2023003'), '未签到学号必须如实列出：' + answer);
    assert.ok(answer.includes('请勿代替学生签到'), '红线口径必须在回答中：' + answer);
    assert.ok(await adminWs.page.getByText('查询签到汇总', { exact: true }).count() >= 1, '工具轨迹标题必须来自 turn-view 单一事实源');
    // 批次3：结构化结果卡（aria-label 定位，与文本回答并列）
    const card = adminWs.page.locator('section[aria-label="签到汇总"]');
    assert.ok(await card.count() >= 1, 'CheckinCard 必须渲染（批次3）');
    assert.ok((await card.first().locator('.ckcard__ids').innerText()).includes('2023002'), '卡内学号名单必须与工具结果一致');
    assert.equal(await adminWs.page.locator('[data-native-confirm]:enabled').count(), 0, '只读查询不得产生确认按钮');
    await adminWs.page.screenshot({ path: path.join(shots, 'admin-checkin-summary.png'), fullPage: false });
  });

  const studentWs = await newWorkspace('student'); debugPage = studentWs.page;
  await record('学生问同一句话：路由到本人状态卡，拿不到缺口名单', async () => {
    await send(studentWs.page, '今天签到情况怎么样');
    const answer = await studentWs.page.locator('.msg--assistant').last().innerText();
    assert.ok(await studentWs.page.getByText('查询签到状态', { exact: true }).count() >= 1, '学生应走本人状态工具');
    assert.equal(await studentWs.page.getByText('查询签到汇总', { exact: true }).count(), 0, '学生不得触发汇总工具');
    // 批次3：本人状态卡渲染（桌面工作会话非 textOnly → 卡与文本并列）
    const card = studentWs.page.locator('section[aria-label="本人签到状态"]');
    assert.ok(await card.count() >= 1, 'CheckinCard 本人状态卡必须渲染');
    assert.ok((await card.first().innerText()).includes('已签到'), '卡内状态与真实记录一致');
    assert.equal(await studentWs.page.locator('section[aria-label="签到汇总"]').count(), 0, '学生不得看到汇总卡');
    assert.ok(answer.includes('示例程序设计'), '本人状态含真实课程：' + answer);
    assert.ok(!answer.includes('2023002') && !answer.includes('2023003'), '学生不得看到他人缺口名单：' + answer);
    await studentWs.page.screenshot({ path: path.join(shots, 'student-checkin-route.png'), fullPage: false });
  });

  assert.deepEqual(errors, [], '无页面错误：' + errors.join(' | '));
  console.log(JSON.stringify({ passed: results.length, failed: 0, results }, null, 2));
  fs.writeFileSync(path.join(shots, 'summary-results.json'), JSON.stringify({ passed: results.length, failed: 0, results }, null, 2));
} catch (e) {
  console.error(e);
  if (debugPage) {
    try {
      console.error('PAGE-URL ' + debugPage.url());
      console.error('PAGE-TEXT ' + (await debugPage.locator('body').innerText()).slice(0, 1500));
      await debugPage.screenshot({ path: path.join(shots, 'summary-failure.png'), fullPage: true });
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
