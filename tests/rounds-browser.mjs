/**
 * 浏览器验收：侧栏分区 + 轮次操作（删除本轮 / 回档 / 修改）—— 0.6.0
 * ============================================================================
 *  隔离演示模式：不连主系统，工作模式的写入落在沙盒（biz_*），
 *  因此"回档连带回退业务写入"这条最容易被吹牛的路径可以在真实浏览器里走完全程。
 *
 *  运行：node tests/rounds-browser.mjs（需要 Chrome；可用 LABOPS_BROWSER_PATH 指定）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const agentRoot = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-rounds-browser-'));
const shots = path.join(agentRoot, '.screenshots', 'rounds');
fs.mkdirSync(shots, { recursive: true });

const children = [];
const results = [];
let browser;
let logs = '';

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function launch(file, env) {
  const c = spawn(process.execPath, [file], { cwd: agentRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  c.stdout.on('data', (d) => (logs += d.toString()));
  c.stderr.on('data', (d) => (logs += d.toString()));
  return c;
}
async function ready(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('服务启动失败：' + logs);
    try {
      if ((await fetch(url + '/api/health')).ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('服务启动超时：' + logs);
}
async function record(name, fn) {
  console.log('RUN ' + name);
  await fn();
  results.push({ name, pass: true });
  console.log('PASS ' + name);
}

let page;
const roundCount = () => page.locator('.round').count();
const userTexts = () => page.locator('.msg--user .msg__userbubble').allInnerTexts();
/** 侧栏分区计数：折叠按钮旁边的 .sidebar-group h2>span */
const sectionCount = (name) => page.locator(`.sidebar-group h2>button:first-child:has-text("${name}") ~ span`).innerText().then(Number);
/** 发一条并等到回答落定（与其它浏览器用例同一套等待口径） */
async function send(q) {
  const n = await page.locator('.msg--assistant').count();
  await page.locator('#cmd').fill(q);
  await page.locator('.bar__btn').click();
  await page.waitForFunction((c) => document.querySelectorAll('.msg--assistant').length > c, n);
  await page.waitForFunction(() => [...document.querySelectorAll('.msg--assistant')].at(-1)?.dataset.status !== 'streaming');
  assert.equal(await page.locator('.msg--assistant').last().getAttribute('data-status'), 'completed');
}
async function chooseMode(name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForFunction((n) => [...document.querySelectorAll('.mode-seg__btn')].some((b) => b.textContent.trim() === n && b.getAttribute('aria-pressed') === 'true'), name);
}
/** 点某一轮的工具条按钮（工具条默认透明，Playwright 仍可点击） */
async function roundAction(index, label) {
  await page.locator('.round').nth(index).getByRole('button', { name: label }).click();
}

try {
  const agentPort = await freePort();
  const base = 'http://127.0.0.1:' + agentPort;
  const agent = launch(path.join(agentRoot, 'server/index.ts'), {
    HOST: '127.0.0.1',
    PORT: String(agentPort),
    LABOPS_DB_PATH: path.join(temp, 'agent.sqlite'),
    LABOPS_AUTH_MODE: 'demo',
    LABOPS_SECURE_COOKIE: '0',
    AGNES_API_KEY: '',
    LOG_LEVEL: 'warn'
  });
  await ready(base, agent);

  const executablePath = [process.env.LABOPS_BROWSER_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => p && fs.existsSync(p));
  if (!executablePath) throw new Error('请安装 Chrome 并设置 LABOPS_BROWSER_PATH 为浏览器可执行文件');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(20000);

  await page.goto(base+'?desktop=1');
  await page.locator('#username').fill('rounds-review');
  await page.locator('#password').fill('demo-only');
  await page.locator('.login-btn').click();
  await page.locator('#cmd').waitFor({ state: 'visible' });

  // ---------------------------------------------------------------- W01
  await record('W01 侧栏把工作会话与聊天会话分成两个分区，各自计数与新建按钮', async () => {
    assert.equal(await page.locator('.sidebar-group h2>button:first-child:has-text("工作会话")').count(), 1);
    assert.equal(await page.locator('.sidebar-group h2>button:first-child:has-text("聊天会话")').count(), 1);
    assert.equal(await page.getByRole('button', { name: '新建工作会话' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '新建聊天会话' }).count(), 1);
    assert.equal(await sectionCount('工作会话'), 0);
    assert.equal(await sectionCount('聊天会话'), 0);
    assert.ok((await page.locator('.sidebar-group').filter({ hasText: '工作会话' }).innerText()).includes('暂无会话'));
    assert.ok((await page.locator('.sidebar-group').filter({ hasText: '聊天会话' }).innerText()).includes('暂无会话'));

    // 工作模式发一条 → 只进工作分区
    await send('查询E310在2026-09-28的课表');
    await page.waitForFunction(() => document.querySelectorAll('#nav-work-list li').length === 1);
    assert.equal(await sectionCount('工作会话'), 1);
    assert.equal(await sectionCount('聊天会话'), 0);

    // 从聊天分区新建 → 聊天模式，发一条 → 只进聊天分区
    await page.getByRole('button', { name: '新建聊天会话' }).click();
    await page.waitForFunction(() => document.querySelector('.mode-seg__btn[aria-pressed="true"]')?.textContent.trim() === '聊天');
    await send('实验室值班要注意哪些事？');
    await page.waitForFunction(() => document.querySelectorAll('#nav-chat-list li').length === 1);
    assert.equal(await sectionCount('聊天会话'), 1);
    assert.equal(await sectionCount('工作会话'), 1, '工作分区不该被聊天会话串进来');
    await page.screenshot({ path: path.join(shots, 'sidebar-sections.png'), fullPage: true });
  });

  // ---------------------------------------------------------------- W02
  await record('W02 分区可折叠，折叠态跨刷新保持', async () => {
    await page.locator('.sidebar-group h2>button:first-child:has-text("聊天会话")').click();
    await page.waitForFunction(() => !document.querySelector('#nav-chat-list'));
    assert.equal(await page.locator('#nav-work-list li').count(), 1);
    await page.reload();
    await page.locator('#cmd').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#nav-work-list li').length === 1);
    assert.equal(await page.locator('#nav-chat-list').count(), 0, '折叠状态必须被记住');
    await page.locator('.sidebar-group h2>button:first-child:has-text("聊天会话")').click();
    await page.waitForFunction(() => document.querySelectorAll('#nav-chat-list li').length === 1);
  });

  // ---------------------------------------------------------------- W03
  await record('W03 工作模式每轮有删除/回档/修改；聊天模式只有删除本轮', async () => {
    const work = page.locator('.sidebar-group h2>button:first-child:has-text("工作会话") ~ span');
    assert.ok(work);
    await page.locator('#nav-work-list li').first().locator('.sidebar-conversation').click();
    await page.locator('.round').first().waitFor();
    await page.locator('.round').first().hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.round .roundtool')).opacity === '1');
    for (const label of ['删除第 1 轮', '回档到第 1 轮发起前', '修改第 1 轮的提问并重新发起']) {
      assert.equal(await page.locator('.round').first().getByRole('button', { name: label }).count(), 1, label);
    }
    await page.locator('#nav-chat-list li').first().locator('.sidebar-conversation').click();
    await page.locator('.round').first().waitFor();
    assert.equal(await page.locator('.round').first().getByRole('button', { name: '删除第 1 轮' }).count(), 1);
    assert.equal(await page.locator('.round').first().getByRole('button', { name: '回档到第 1 轮发起前' }).count(), 0, '聊天模式不提供回档');
    assert.equal(await page.locator('.round').first().getByRole('button', { name: '修改第 1 轮的提问并重新发起' }).count(), 0);
  });

  // ---------------------------------------------------------------- W04
  await record('W04 修改：弹窗预填原提问，改完重发后只剩新的这一轮', async () => {
    await page.locator('#nav-work-list li').first().locator('.sidebar-conversation').click();
    await page.locator('.round').first().waitFor();
    await roundAction(0, '修改第 1 轮的提问并重新发起');
    const dlg = page.getByRole('dialog');
    await dlg.waitFor();
    assert.equal(await dlg.locator('textarea').inputValue(), '查询E310在2026-09-28的课表');
    await dlg.locator('textarea').fill('查询E312在2026-09-28的课表');
    await dlg.getByRole('button', { name: '确认修改并重发' }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.waitForFunction(() => document.querySelector('.msg--user .msg__userbubble')?.textContent.includes('E312'));
    assert.equal(await roundCount(), 1, '修改后不该留下旧轮');
    assert.equal((await userTexts()).length, 1);
    assert.ok((await page.locator('.chat__notice').innerText()).includes('已回档到第 1 轮发起前'));
    await page.locator('.chat__noticedismiss').click();
  });

  // ---------------------------------------------------------------- W05
  await record('W05 回档：只回到本轮之前，后面的轮次一并移除', async () => {
    await send('查询E310在2026-09-29的课表');
    await send('查询E310在2026-09-30的课表');
    assert.equal(await roundCount(), 3);
    await roundAction(1, '回档到第 2 轮发起前');
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: '确认回档' }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.waitForFunction(() => document.querySelectorAll('.round').length === 1);
    assert.equal(await roundCount(), 1);
    assert.ok((await userTexts())[0].includes('E312'));
  });

  // ---------------------------------------------------------------- W06
  await record('W06 删除本轮：只删这一轮，后面的轮次保持不动', async () => {
    await send('查询E310在2026-09-29的课表');
    await send('查询E310在2026-09-30的课表');
    assert.equal(await roundCount(), 3);
    const before = await userTexts();
    page.once('dialog', (d) => d.accept());
    await roundAction(1, '删除第 2 轮');
    await page.waitForFunction(() => document.querySelectorAll('.round').length === 2);
    const after = await userTexts();
    assert.deepEqual(after, [before[0], before[2]], '被删的是中间那一轮，前后顺序不变');
    assert.equal(await roundCount(), 2);
  });

  // ---------------------------------------------------------------- W07
  await record('W07 工作办理：回档连带把沙盒写入真的撤回，并在界面上如实说明', async () => {
    await page.getByRole('button', { name: '新建工作会话' }).click();
    await page.locator('#cmd').waitFor({ state: 'visible' });
    await send('E310 投影没有信号，帮我报修');
    const confirmBtn = page.locator('.opcard__confirm');
    await confirmBtn.waitFor();
    const version = (await confirmBtn.innerText()).match(/v(\d+)/)?.[1];
    assert.ok(version, '确认按钮必须绑定提案版本');
    await confirmBtn.click();
    await page.waitForFunction(() => document.querySelector('.opcard')?.dataset.state === 'executed');
    await page.locator('.chat__notice').count();
    // 回档这一轮，并勾选"同时回退本轮业务写入"（默认即勾选）
    await roundAction(0, '回档到第 1 轮发起前');
    const dlg = page.getByRole('dialog');
    await dlg.waitFor();
    assert.equal(await dlg.locator('input[type="checkbox"]').isChecked(), true, '回退业务写入应默认勾选');
    assert.ok((await dlg.innerText()).includes('本轮牵涉业务办理'), '牵涉业务办理时必须提示');
    await dlg.getByRole('button', { name: '确认回档' }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.locator('.chat__notice').waitFor();
    const notice = await page.locator('.chat__notice').innerText();
    assert.ok(notice.includes('已回退沙盒写入 1 项'), notice);
    assert.equal(await page.locator('.opcard').count(), 0, '回档后旧办理单不该还挂在这里');
    await page.screenshot({ path: path.join(shots, 'rollback-effects.png'), fullPage: true });
  });

  // ---------------------------------------------------------------- W08
  await record('W08 390px 窄窗口桌面版：分区与轮次操作可用，无整页横向溢出', async () => {
    // 演示模式下每个浏览器上下文是独立的演示身份（独立工作区）——
    // 所以手机端必须复用桌面端的存储状态，否则看到的是"另一个人的空列表"
    const storageState = await ctx.storageState();
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    // 演示模式的"已登录"标记在 sessionStorage（不是 cookie），storageState 带不过来
    await mctx.addInitScript(() => {
      try {
        sessionStorage.setItem('labops.auth', 'rounds-review');
      } catch {
        /* 忽略 */
      }
    });
    const m = await mctx.newPage();
    m.on('pageerror', (e) => errors.push(e.message));
    m.setDefaultTimeout(20000);
    await m.goto(base+'?desktop=1');
    await m.locator('#cmd').waitFor({ state: 'visible' });
    await m.locator('.chat__navtoggle').click();
    await m.locator('.sidebar-group h2>button:first-child:has-text("工作会话")').waitFor();
    assert.equal(await m.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)), 0);
    // 挑一个"确实有消息"的工作会话：W07 回档后留下的空会话排在列表最前
    await m.locator('#nav-work-list .sidebar-conversation:not([title*="（0 条消息）"])').first().click();
    await m.locator('.round').first().waitFor();
    // 触摸端没有 hover：操作条必须常显，否则功能等于不存在
    assert.equal(await m.locator('.round').first().locator('.roundtool').evaluate((el) => getComputedStyle(el).opacity), '1');
    const roundsBefore = await m.locator('.round').count();
    // 确认框必须在点击前挂上监听：没有监听时 Playwright 会自动取消对话框
    m.once('dialog', (d) => d.accept());
    await m.locator('.round').first().getByRole('button', { name: '删除第 1 轮' }).click();
    await m.waitForFunction((n) => document.querySelectorAll('.round').length === n - 1, roundsBefore);
    assert.equal(await m.locator('.round').count(), roundsBefore - 1);
    assert.equal(await m.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)), 0);
    await m.screenshot({ path: path.join(shots, 'mobile-rounds.png'), fullPage: true });
    await mctx.close();
  });

  await record('W09 全程无页面级脚本错误', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  try {
    await browser?.close();
  } catch {
    /* 忽略 */
  }
  for (const c of children) c.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 150));
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ results }, null, 2));
  if (results.some((r) => !r.pass) || results.length === 0) process.exitCode = 1;
}
