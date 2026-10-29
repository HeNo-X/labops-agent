/**
 * PC 端「实验室监控」浏览器验收探针
 * ============================================================================
 *  前置（两窗口）：
 *    VISION_INGEST_SECRET=dev-secret npm run demo
 *    VISION_INGEST_SECRET=dev-secret npm run mock:vision
 *  用法：node tests/_probe-vision-pc.ts
 *  说明：文件名不以 .test.ts 结尾，不进 npm test 用例集。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ACCESS = path.resolve(ROOT, '..', '.review-data', 'review-access.json');
const BASE = process.env['LABOPS_BASE'] ?? 'http://127.0.0.1:18878';
const SHOT = path.join(ROOT, '.screenshots', 'vision-pc');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('找不到本机 Chrome/Edge');
if (!fs.existsSync(ACCESS)) throw new Error('缺少演示账号文件（先跑 npm run demo）');

interface Account {
  account: string;
  password: string;
  identity: string;
}
const access = JSON.parse(fs.readFileSync(ACCESS, 'utf8')) as { accounts?: Account[] };
const admin = (access.accounts ?? []).find((a) => a.identity === 'admin');
if (!admin) throw new Error('演示账号里没有 admin');

fs.mkdirSync(SHOT, { recursive: true });

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}`);
  if (detail) console.log(`      ${detail}`);
}

async function login(page: Page): Promise<void> {
  const accountSel = 'input[autocomplete="username"], input[name="username"]';
  const passwordSel = 'input[type="password"]';
  await page.waitForSelector(accountSel, { timeout: 20000 });
  await page.fill(accountSel, admin!.account);
  await page.fill(passwordSel, admin!.password);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

console.log('\n[PC 1440×900 · 实验室监控]');
await page.goto(BASE, { waitUntil: 'networkidle' });
await login(page);

const entry = await page.locator('.vision-entry button').count();
check('PC 侧栏出现「实验室监控」入口', entry > 0, `匹配 ${entry} 个`);
if (!entry) {
  await page.screenshot({ path: path.join(SHOT, 'no-entry.png'), fullPage: true });
  await browser.close();
  process.exit(1);
}

await page.locator('.vision-entry button').first().click();
await page.waitForSelector('.vision-panel', { timeout: 15000 });
await page.waitForTimeout(2500);

check('点击后打开监控面板', (await page.locator('.vision-panel').count()) > 0, '');

const setupShown = await page.locator('.vision-setup').count();
check('通道已接入（未显示"未接入"配置指引）', setupShown === 0, `setup 区块 ${setupShown} 个`);

const badge = (await page.locator('.vision-head .vision-badge').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
check('顶栏给出通道状态徽标', badge.length > 0, `徽标="${badge}"`);

const cardCount = await page.locator('.vision-card').count();
check('房间监测网格有卡片（真实数据已进来）', cardCount > 0, `卡片 ${cardCount} 张`);

if (cardCount > 0) {
  const firstCard = (await page.locator('.vision-card').first().innerText()).replace(/\s+/g, ' ');
  check('卡片含房间号 / AI 计数 / 场景或护具', /[A-Z]+\d+/.test(firstCard) && /AI 计数/.test(firstCard), firstCard.slice(0, 140));
  const numText = (await page.locator('.vision-card__num').first().innerText()).trim();
  check('计数以数字呈现（不是占位符）', /\d|—/.test(numText), `计数="${numText}"`);
}

const eventCount = await page.locator('.vision-events li').count();
check('事件流水有记录', eventCount > 0, `事件 ${eventCount} 条`);

const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
check('无横向溢出', overflow <= 2, `${overflow}px`);

await page.screenshot({ path: path.join(SHOT, 'panel.png'), fullPage: false });

// 关闭后是否停止轮询（不验证定时器，只验证可关闭且不残留面板）
await page.locator('.vision-head button', { hasText: '关闭' }).first().click();
await page.waitForTimeout(500);
check('可关闭面板', (await page.locator('.vision-panel').count()) === 0, '');

check('无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | ') || '0 条');

await browser.close();

const pass = results.filter((r) => r.pass).length;
console.log('\n────────────────────────────────────────────');
console.log(`PC 实验室监控验收：${pass}/${results.length} PASS`);
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
console.log(`截图：${SHOT}`);
console.log('────────────────────────────────────────────');
process.exit(pass === results.length ? 0 : 1);
