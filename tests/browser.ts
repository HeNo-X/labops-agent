/// <reference lib="dom" />
/**
 * 浏览器端验收（真实渲染）—— 会话工作台版（M2）
 * ============================================================================
 *  检查项：
 *    ① 无 console error / pageerror / 4xx
 *    ② 空会话 hero：输入是首屏主角（桌面与手机）
 *    ③ 示例点击即发起；消息流按轮追加；工具卡参数可查；数据依据折叠可开
 *    ④ ★ P0 竞态：工具结果已到、回答未结束时输入保持禁用（F02）
 *    ⑤ 取消：中性终态、输入解锁
 *    ⑥ 无匹配 / 能力外 / F10 非法日期 / F18 非当天 nextLesson / F23 历史恢复（刷新）
 *    ⑦ 无写操作占位入口；无横向溢出；区块互不重叠；composer 不悬浮遮挡
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(HERE, '..', '.screenshots');
const BASE = process.argv[2] ?? process.env['LABOPS_BASE'] ?? 'http://127.0.0.1:8787';

const CSP_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}`);
  console.log(`      ${detail}`);
}

function findBrowser(): string {
  for (const p of CSP_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到本机 Chrome / Edge，请在 CSP_CANDIDATES 里补一个路径');
}

async function attachDiagnostics(page: Page): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('/api/conversations/')) {
      errors.push(`http ${res.status()}: ${res.url()}`);
    }
  });
  page.on('requestfailed', (req) => {
    // 用户取消任务时 abort fetch 是预期行为
    if (/\/api\//.test(req.url()) && !/ERR_ABORTED/.test(req.failure()?.errorText ?? '')) {
      errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ''}`);
    }
  });
  return { errors };
}

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/** 兄弟级区块两两重叠检测（hero / nav / chat） */
async function overlappingBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = ['.hero', '.nav', '.chat', '.side'].join(',');
    const els = Array.from(document.querySelectorAll(sel));
    const boxes = els.map((e) => ({
      cls: e.className.split(' ')[0] ?? e.tagName,
      r: e.getBoundingClientRect(),
      collapsed: e.classList.contains('side--collapsed')
    }));
    const bad: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.r.width === 0 || b.r.width === 0) continue;
        // 收起态的房间窄轨是有意悬浮的切换控件（正文已让位），不算布局事故
        if (a.collapsed || b.collapsed) continue;
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 2 && oy > 2) bad.push(`${a.cls} ∩ ${b.cls} = ${ox.toFixed(0)}×${oy.toFixed(0)}px`);
      }
    }
    return bad;
  });
}

/** 等待最后一条助手消息到达终态（completed/failed/cancelled/interrupted） */
async function waitForRunDone(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const list = document.querySelectorAll('.msg--assistant[data-status]');
      const last = list[list.length - 1];
      return last && last.getAttribute('data-status') !== 'streaming';
    },
    null,
    { timeout: 30000 }
  );
}

async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const list = document.querySelectorAll('.msg--assistant');
    const last = list[list.length - 1];
    return last ? (last.querySelector('.msg__text')?.textContent ?? '') : '';
  });
}

async function lastResText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const list = document.querySelectorAll('.res');
    const last = list[list.length - 1];
    return last ? last.textContent ?? '' : '';
  });
}

interface RunPageState {
  lessons: number;
  streaming: boolean;
  cmdDisabled: boolean;
}

async function readState(page: Page): Promise<RunPageState> {
  return page.evaluate(() => ({
    lessons: document.querySelectorAll('.lesson').length,
    streaming: Boolean(document.querySelector('.msg--assistant[data-status="streaming"]')),
    cmdDisabled: (document.querySelector('#cmd') as HTMLTextAreaElement | null)?.disabled ?? false
  }));
}

/** 登录门面（本地演示模式）：任意账号 + 4 位以上密码即可进入 */
async function loginIfNeeded(page: Page): Promise<void> {
  if ((await page.locator('.login').count()) === 0) return;
  await page.fill('#username', 'demo@labops');
  await page.fill('#password', 'demo1234');
  await page.locator('.login-btn').click();
  await page.waitForSelector('.nav', { timeout: 15000 });
}

async function runFlow(page: Page, label: string, shotPrefix: string): Promise<void> {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await loginIfNeeded(page);
  await page.waitForSelector('.nav', { timeout: 15000 });
  await page.waitForSelector('.hero', { timeout: 15000 });
  await page.waitForSelector('.bar--hero', { timeout: 15000 });
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-1-初始.png`), fullPage: true });

  const heroInput = await page.locator('#cmd').boundingBox();
  const viewport = page.viewportSize();
  check(
    `${label}：空态首屏直接可见任务输入框（hero）`,
    heroInput !== null && viewport !== null && heroInput.y + heroInput.height / 2 < viewport.height,
    heroInput ? `输入框位于首屏 y=${Math.round(heroInput.y)}px` : '未找到输入框'
  );

  // 房间清单在右侧（可展开/收起）：窄屏默认收起 → 先展开验证再收起，避免抽屉挡住后续操作
  let roomCount = await page.locator('.room').count();
  if (roomCount === 0) {
    await page.getByRole('button', { name: '房间清单' }).click();
    await page.waitForTimeout(250);
    roomCount = await page.locator('.room').count();
    await page.getByRole('button', { name: '收起房间清单' }).click();
  }
  check(`${label}：房间清单可通过右侧面板展开`, roomCount > 0, `${roomCount} 行房间`);

  // 示例点击即发起 → 会话创建 + 消息流
  await page.locator('.chip').first().click();
  await page.waitForSelector('.msg--user', { timeout: 15000 });
  const question = await page.locator('.msg--user .msg__userbubble').first().innerText();
  check(`${label}：示例点击即发起（user 消息入流）`, question.length > 0, `"${question}"`);

  // ★ P0 竞态（F02）：工具结果已到（课程卡出现）、回答未结束（仍在 streaming）时输入必须禁用
  {
    let sawWindow = false;
    let unlockedEarly = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const s = await readState(page);
      if (s.lessons > 0 && s.streaming) {
        sawWindow = true;
        if (!s.cmdDisabled) unlockedEarly = true;
        break;
      }
      if (!s.streaming && s.lessons > 0) break;
      await page.waitForTimeout(20);
    }
    check(
      `${label}：P0 竞态 —— 工具结果已到、回答未结束时输入保持禁用`,
      sawWindow && !unlockedEarly,
      sawWindow ? (unlockedEarly ? '竞态窗口内输入被提前解锁！' : '竞态窗口内输入保持禁用 ✓') : '未观测到竞态窗口（任务太快）'
    );
  }

  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-2-查询中.png`), fullPage: true });
  await waitForRunDone(page);
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-3-结果.png`), fullPage: true });

  const lessonCount = await page.locator('.lesson').count();
  check(`${label}：课程结果以结构化卡片呈现`, lessonCount > 0, `${lessonCount} 条课程卡片`);

  const toolCards = await page.locator('.msg__tools').count();
  check(`${label}：助手消息带工具调用卡（参数可查，F34）`, toolCards > 0, `${toolCards} 张工具卡`);

  // 数据依据默认折叠，展开后有完整取证
  const provCount = await page.locator('.prov').count();
  let provOk = false;
  let provDetail = '本消息无结构化结果（无可折叠依据）';
  if (provCount > 0) {
    await page.locator('.prov__sum').last().click();
    const provText = await page.locator('.prov').last().innerText();
    provOk = /查询时间/.test(provText) && /脱敏快照/.test(provText);
    provDetail = provText.split('\n').filter((l) => /数据|查询时间/.test(l)).slice(0, 2).join(' | ');
  }
  check(`${label}：数据依据（默认折叠，展开后）含来源与查询时间`, provOk, provDetail);

  // 结果区来源标识（textContent 无换行，用精确词判断：live 来源才会出现"实时数据："）
  const resText = await lastResText(page);
  check(`${label}：结果区标出数据来源（脱敏快照，非实时）`, resText.includes('脱敏快照') && !resText.includes('实时数据'), resText.slice(0, 60));

  const answerText = await lastAssistantText(page);
  const bookTicks = (answerText.match(/《/g) ?? []).length;
  check(
    `${label}：回答为结论式（不在正文里逐条复述课程明细）`,
    bookTicks <= 2 && answerText.includes('条排课'),
    `回答 ${answerText.length} 字，课程名出现 ${bookTicks} 次`
  );

  const dockCount = await page.locator('.dock').count();
  check(`${label}：无写操作占位卡`, dockCount === 0, `.dock 元素数 = ${dockCount}`);

  const of = await overflowPx(page);
  check(`${label}：无横向溢出`, of <= 2, `scrollWidth - clientWidth = ${of}px`);
  const overlaps = await overlappingBlocks(page);
  check(`${label}：主要区块互不重叠`, overlaps.length === 0, overlaps.length ? overlaps.join('；') : '主要区块两两无交叠');

  // composer 在布局流内，不悬浮遮挡消息区（F26）
  const overlapComposer = await page.evaluate(() => {
    const msgs = document.querySelector('.chat__msgs');
    const composer = document.querySelector('.chat__composer');
    if (!msgs || !composer) return -999;
    return Math.round(msgs.getBoundingClientRect().bottom - composer.getBoundingClientRect().top);
  });
  check(`${label}：输入区不悬浮遮挡消息区`, overlapComposer <= 2, `消息区底边 - 输入区顶边 = ${overlapComposer}px`);

  const cmdEnabled = await page.locator('#cmd').isEnabled();
  check(`${label}：任务结束后命令栏可用`, cmdEnabled, `enabled=${cmdEnabled}`);
  const bodyText = await page.evaluate(() => document.body.innerText);
  check(`${label}：任务结束后无"生成中"残留`, !bodyText.includes('生成中'), bodyText.includes('生成中') ? '仍有"生成中"标签' : '无残留 ✓');
}

async function main(): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const exe = findBrowser();
  console.log(`LabOps Agent 浏览器验收（会话工作台版）—— ${BASE}`);
  console.log(`浏览器：${exe}\n`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: exe, headless: true });
  } catch (e) {
    console.error('浏览器启动失败：', (e as Error).message);
    process.exit(1);
  }

  // ============================================================ 桌面
  console.log('[桌面 1440×900]');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const diag = await attachDiagnostics(page);
    await runFlow(page, '桌面', 'desktop');

    const submit = async (q: string): Promise<void> => {
      await page.fill('#cmd', q);
      await page.getByRole('button', { name: '发起任务' }).click();
      await waitForRunDone(page);
    };

    // 无匹配
    await submit('E999 2026-09-30 有哪些课？');
    const emptyRes = await lastResText(page);
    check('桌面：房间不存在时给出"无匹配 + 可选房间号"', /没有收录|可选房间号/.test(emptyRes), emptyRes.match(/[^\n]*没有[^\n]*/)?.[0] ?? '');
    const lastLessons = await page.locator('.res').last().locator('.lesson').count();
    check('桌面：无匹配时不渲染课程卡片（不编造）', lastLessons === 0, `最后一条结果卡 lesson 数 = ${lastLessons}`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-4-无匹配.png'), fullPage: true });

    // F10：非法日期
    await submit('E310 2026-02-30 有哪些课？');
    const invalidText = await lastAssistantText(page);
    check('桌面：非法日期显式报错（F10）', /不是真实存在的日期/.test(invalidText), invalidText.slice(0, 80));

    // 空闲房间（F11/F12）
    await submit('明天下午第二大节哪些实验室空着？');
    const freeRes = await lastResText(page);
    const freeAnswer = await lastAssistantText(page);
    check('桌面：空闲名单只含档案开放房间并给出排除理由（F11）', freeRes.includes('已排除') || /只统计档案状态为「开放」/.test(freeAnswer), freeRes.slice(0, 120));
    check('桌面：空闲口径如实声明（不代表室内无人）', freeAnswer.includes('不代表室内无人'), freeAnswer.split('\n').slice(-1)[0] ?? '');
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-5-空闲房间.png'), fullPage: true });

    // 房间状态 + F18 非当天 nextLesson
    await submit('E310 明天开放吗？');
    const statusRes = await lastResText(page);
    check('桌面：房间状态卡如实标注在室人数未知', statusRes.includes('在室人数') && /未知|无法提供/.test(statusRes), statusRes.match(/在室人数[^\n]*/)?.[0] ?? '');
    const tomorrowAnswer = await lastAssistantText(page);
    const tomorrowDate = tomorrowAnswer.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
    check('桌面：非当天查询不冒充"当天无更多排课"（F18）', tomorrowAnswer.includes('仅对当天提供'), tomorrowAnswer.match(/[^\n]*仅对当天[^\n]*/)?.[0] ?? '');
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-6-房间状态.png'), fullPage: true });
    // B16/N08：查过未来日期后问"现在" —— 当前日期覆盖继承的未来日期
    await submit('E310 现在开放吗？');
    const nowAnswer = await lastAssistantText(page);
    const nowDate = nowAnswer.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
    check('桌面："现在"覆盖上下文中的未来日期（B16/N08）', Boolean(nowDate) && nowDate !== tomorrowDate, `明天=${tomorrowDate} 现在=${nowDate}`);

    // 能力外 + 寒暄（F13）
    await submit('D526 现在几个人？');
    const oosText = await lastAssistantText(page);
    check('桌面：能力外问题明确说明未接入', /未接入|做不到/.test(oosText), oosText.slice(0, 80));
    await submit('谢谢');
    const thanksText = await lastAssistantText(page);
    const thanksTools = await page.evaluate(() => {
      const list = document.querySelectorAll('.msg--assistant');
      const last = list[list.length - 1];
      return last ? last.querySelectorAll('.msg__tools').length : -1;
    });
    check('桌面：寒暄不调工具、不继承条件（F13）', thanksTools === 0 && /不客气|随时/.test(thanksText), thanksText.slice(0, 60));

    // 取消
    await page.fill('#cmd', 'E310 2026-09-30 有哪些课？');
    await page.getByRole('button', { name: '发起任务' }).click();
    await page.waitForTimeout(100);
    await page.getByRole('button', { name: '取消' }).click();
    await page.waitForSelector('.msg--assistant[data-status="cancelled"]', { timeout: 10000 });
    const afterCancel = await page.locator('#cmd').isEnabled();
    check('桌面：取消为中性终态且输入解锁', afterCancel, `enabled=${afterCancel}`);

    // 会话承接
    await submit('E310 2026-09-30 有哪些课？');
    await submit('那 E312 呢？');
    const followRes = await lastResText(page);
    check('桌面：「那 E312 呢？」承接上一问日期', followRes.includes('E312') && followRes.includes('2026-09-30'), `E312=${followRes.includes('E312')} 2026-09-30=${followRes.includes('2026-09-30')}`);

    // F23/历史恢复：刷新 → 左侧会话列表 → 点开恢复
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.nav', { timeout: 15000 });
    const convCount = await page.locator('.conv').count();
    check('桌面：刷新后左侧会话列表保留（F23）', convCount > 0, `${convCount} 个会话`);
    await page.locator('.conv').first().click();
    await page.waitForSelector('.msg--user', { timeout: 15000 });
    const restoredMsgs = await page.locator('.msg').count();
    const restoredText = await lastAssistantText(page);
    check('桌面：点开会话恢复全部消息与回答（A03）', restoredMsgs >= 6 && restoredText.length > 0, `${restoredMsgs} 条消息，最后回答 ${restoredText.length} 字`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-7-历史恢复.png'), fullPage: true });

    check('桌面：控制台无错误 / 无失败请求', diag.errors.length === 0, diag.errors.length ? diag.errors.slice(0, 3).join(' | ') : '0 条错误');
    await ctx.close();
  }

  // ============================================================ 手机
  console.log('\n[手机 390×844]');
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    });
    const page = await ctx.newPage();
    const diag = await attachDiagnostics(page);
    await runFlow(page, '手机', 'mobile');
    check('手机：控制台无错误 / 无失败请求', diag.errors.length === 0, diag.errors.length ? diag.errors.slice(0, 3).join(' | ') : '0 条错误');
    await ctx.close();
  }

  await browser.close();
  const pass = results.filter((r) => r.pass).length;
  console.log('\n────────────────────────────────────────────');
  console.log(`浏览器验收：${pass}/${results.length} PASS`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('未通过：');
    for (const f of failed) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  }
  console.log(`截图目录：${SHOT_DIR}`);
  console.log('────────────────────────────────────────────');
  process.exit(failed.length ? 1 : 0);
}

void main();
