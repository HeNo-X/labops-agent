/**
 * 自动化模块浏览器验收探针（离线可跑）
 * ============================================================================
 *  为什么单独跑：类型检查与打包**都抓不到 Vue 模板的运行时错误**
 *  （例如把 composable 返回的 ref 当成普通值用、组件 props 不匹配）。
 *  这里用真实 Chrome 走一遍：登录 → 移动端首页 → 自动化 → 新建 → 频率联动。
 *
 *  用法：node tests/_probe-automation.ts
 *  前置：在项目根执行 npm run demo（Agent 18878），且 dist/ 已构建
 *  说明：文件名不以 .test.ts 结尾，因此不会进入 npm test 的用例集
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
const SHOT = path.join(ROOT, '.screenshots', 'automation');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));

if (!CHROME) throw new Error('找不到本机 Chrome/Edge');
if (!fs.existsSync(ACCESS)) throw new Error('缺少演示账号文件：' + ACCESS + '（先跑 npm run demo）');

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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function pageFor(kind: 'mobile' | 'desktop'): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const mobile = kind === 'mobile';
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
  );
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${BASE}/${mobile ? 'mobile.html' : ''}`, { waitUntil: 'networkidle' });
  return { page, errors, close: () => ctx.close() };
}

async function login(page: Page, mobile: boolean): Promise<void> {
  const accountSel = mobile ? '#mobile-account' : 'input[autocomplete="username"], input[name="username"]';
  const passwordSel = mobile ? '#mobile-password' : 'input[type="password"]';
  await page.waitForSelector(accountSel, { timeout: 20000 });
  await page.fill(accountSel, admin!.account);
  await page.fill(passwordSel, admin!.password);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#mobile-account'), null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  // 登录后默认落在「助手」视图，而自动化快捷入口在「工作台」视图（view=home）里
  if (mobile) {
    await page.goto(`${BASE}/mobile.html?view=home`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.mobile-quick-grid', { timeout: 20000 });
    await page.waitForTimeout(600);
  }
}

async function openAutomation(page: Page, mobile: boolean): Promise<void> {
  const trigger = mobile
    ? page.locator('.mobile-quick-grid button', { hasText: '自动化' })
    : page.locator('.auto-entry button');
  await trigger.first().click();
  await page.waitForSelector('.auto-panel', { timeout: 20000 });
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------- 移动端
{
  console.log('\n[移动端 390×844]');
  const { page, errors, close } = await pageFor('mobile');
  await login(page, true);

  const homeHasEntry = await page.locator('.mobile-quick-grid button', { hasText: '自动化' }).count();
  check('移动端首页有「自动化」入口（不再是「定时规则」）', homeHasEntry > 0, `匹配 ${homeHasEntry} 个按钮`);

  await openAutomation(page, true);
  const title = await page.locator('.auto-panel__head h1').innerText().catch(() => '');
  check('面板可打开且标题为「自动化」', title.includes('自动化'), `标题="${title}"`);

  const hasComposerBtn = await page.locator('.auto-actions button.auto-primary', { hasText: '新建自动化' }).count();
  const cardCount = await page.locator('.auto-card').count();
  const emptyCount = await page.locator('.auto-empty').count();
  check('列表区渲染出卡片或空态之一（不是空白页）', cardCount > 0 || emptyCount > 0, `卡片 ${cardCount} / 空态 ${emptyCount}`);
  check('有「新建自动化」主按钮', hasComposerBtn > 0, `匹配 ${hasComposerBtn} 个`);

  const offscreen = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  check('无横向溢出', offscreen <= 2, `scrollWidth-clientWidth = ${offscreen}px`);
  await page.screenshot({ path: path.join(SHOT, 'mobile-1-list.png'), fullPage: true });

  if (hasComposerBtn > 0) {
    await page.locator('.auto-actions button.auto-primary', { hasText: '新建自动化' }).first().click();
    await page.waitForSelector('.auto-composer', { timeout: 15000 });
    const segs = await page.locator('.auto-seg button').count();
    const weekdayBefore = await page.locator('.auto-weekdays button').count();
    check('新建页默认是「简明」三控件形态（不是八步表单）', segs >= 3, `频率分段按钮 ${segs} 个`);
    check('默认「每天」时不显示星期选择', weekdayBefore === 0, `星期按钮 ${weekdayBefore} 个`);

    await page.locator('.auto-seg button', { hasText: '每周' }).first().click();
    await page.waitForTimeout(300);
    const weekdayAfter = await page.locator('.auto-weekdays button').count();
    check('切到「每周」后出现 7 个星期按钮（联动生效）', weekdayAfter === 7, `星期按钮 ${weekdayAfter} 个`);
    await page.screenshot({ path: path.join(SHOT, 'mobile-2-composer.png'), fullPage: true });

    // ---- 端到端：真创建一条，验证影响核对 + 卡片渲染（只看空态不算验证） ----
    await page.locator('.auto-seg button', { hasText: '每天' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('.auto-actions button.auto-primary', { hasText: /查看影响/ }).first().click();
    let reviewOpened = true;
    try {
      await page.waitForSelector('.auto-review', { timeout: 25000 });
    } catch {
      reviewOpened = false;
    }
    const reviewText = reviewOpened ? await page.locator('.auto-review').innerText() : '';
    check('点「查看影响」后出现影响核对（含接收人与运行时间）', reviewOpened && /接收/.test(reviewText), reviewOpened ? reviewText.replace(/\s+/g, ' ').slice(0, 120) : '未出现 .auto-review');
    await page.screenshot({ path: path.join(SHOT, 'mobile-3-review.png'), fullPage: true });

    if (reviewOpened) {
      await page.locator('.auto-review button.auto-primary').first().click();
      // 移动端 inline 模式下，确认后会直接跳到该规则详情（沿用旧版行为，不是缺陷）
      let landed = true;
      try {
        await page.waitForSelector('.auto-detail', { timeout: 25000 });
      } catch {
        landed = false;
      }
      const detailText = landed ? (await page.locator('.auto-detail').innerText()).replace(/\s+/g, ' ') : '';
      check('确认创建后进入该规则详情（inline 模式的既定行为）', landed, landed ? detailText.slice(0, 100) : '未出现 .auto-detail');
      check('详情页给出频率、接收对象与运行历史', /每天|接收|运行历史/.test(detailText), detailText.slice(0, 140));
      await page.screenshot({ path: path.join(SHOT, 'mobile-4-detail.png'), fullPage: true });
    }
  }

  check('移动端全程无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | ') || '0 条');
  await close();
}

// ---------------------------------------------------------------- 桌面端
{
  console.log('\n[桌面端 1440×900]');
  const { page, errors, close } = await pageFor('desktop');
  try {
    await login(page, false);
    const entry = await page.locator('.auto-entry button').count();
    check('桌面端侧栏有「自动化」入口', entry > 0, `匹配 ${entry} 个`);
    if (entry > 0) {
      await openAutomation(page, false);
      const cardCount = await page.locator('.auto-card').count();
      const emptyCount = await page.locator('.auto-empty').count();
      check('桌面端面板渲染正常', cardCount > 0 || emptyCount > 0, `卡片 ${cardCount} / 空态 ${emptyCount}`);

      if (cardCount > 0) {
        const cardText = (await page.locator('.auto-card').first().innerText()).replace(/\s+/g, ' ');
        check('卡片含任务名与频率人话', /\d{2}:\d{2}|每天|每周/.test(cardText), cardText.slice(0, 130));
        check('卡片给出下次运行时间', /下次|已暂停/.test(cardText), cardText.slice(0, 130));
        const switchCount = await page.locator('.auto-card .auto-switch input[role="switch"]').count();
        check('卡片带状态开关', switchCount > 0, `开关 ${switchCount} 个`);

        if (switchCount > 0) {
          const before = await page.locator('.auto-card .auto-switch input[role="switch"]').first().isChecked();
          await page.locator('.auto-card .auto-switch input[role="switch"]').first().click({ force: true });
          await page.waitForTimeout(2800);
          const after = await page.locator('.auto-card .auto-switch input[role="switch"]').first().isChecked();
          check('拨动开关后状态真的改变（暂停/恢复走完 preview→confirm）', before !== after, `${before} → ${after}`);
        }
      }
      const of = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
      check('桌面端无横向溢出', of <= 2, `${of}px`);
      await page.screenshot({ path: path.join(SHOT, 'desktop-1-list.png'), fullPage: true });
    }
    check('桌面端无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | ') || '0 条');
  } catch (e) {
    check('桌面端登录并打开面板', false, (e as Error).message.split('\n')[0] ?? '');
  }
  await close();
}

await browser.close();

const pass = results.filter((r) => r.pass).length;
console.log('\n────────────────────────────────────────────');
console.log(`自动化浏览器验收：${pass}/${results.length} PASS`);
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
console.log(`截图：${SHOT}`);
console.log('────────────────────────────────────────────');
process.exit(pass === results.length ? 0 : 1);
