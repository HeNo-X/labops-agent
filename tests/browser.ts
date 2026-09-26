/// <reference lib="dom" />
/**
 * 浏览器端验收（真实渲染，不是 jsdom 近似）
 * ============================================================================
 *  用法：node tests/browser.ts [baseUrl]
 *  依赖：playwright-core（不下载浏览器，直接复用本机 Chrome / Edge）
 *
 *  这里的 DOM 类型来自文件级 `/// <reference lib="dom" />`，
 *  而不是把 DOM 加进 tsconfig.node.json 的全局 lib —— 那样会让服务端代码
 *  也能"合法"引用 document，把真正的错误藏起来。
 *
 *  为什么必须有这一层：验收表最后一行是「桌面和手机宽度查看任务画布 →
 *  内容不重叠，主要操作可使用」。这件事**无法**靠类型检查或接口断言证明，
 *  只能真的把页面渲染出来量一遍。
 *
 *  检查项：
 *    ① 页面无 console error / pageerror
 *    ② 桌面 1440×900：发起任务 → 出现课程卡片 → 数据来源标识正确 → 轨迹有步骤
 *    ③ 手机 390×844：同一流程可用；命令栏可点；无横向溢出
 *    ④ 横向溢出（scrollWidth ≤ clientWidth）—— "内容不重叠"的可量化代理指标
 *    ⑤ 关键操作元素的可见性与可点击性
 *    ⑥ 无匹配与越界两种状态的界面表现
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
  // 把 4xx/5xx 响应的 URL 也记下来 —— 只报"404 (Not Found)"是没法定位的
  page.on('response', (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    if (/\/api\//.test(req.url())) errors.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ''}`);
  });
  return { errors };
}

/** 横向溢出量：> 2px 说明有内容顶破了视口（"不重叠"的可量化代理） */
async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

/**
 * 主要区块两两重叠检测。
 * ⚠️ 排除 `.bar`（吸底命令栏）：`position: sticky; bottom: 0` 的元素在滚动过程中
 * 本来就会浮在内容之上，这是**设计意图**，不是缺陷。它是否真的挡住内容，
 * 由 obscuredAtBottom() 单独验证。
 */
async function overlappingBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = ['.matrix', '.trace', '.res', '.dock'].join(',');
    const els = Array.from(document.querySelectorAll(sel));
    const boxes = els.map((e) => ({ cls: e.className.split(' ')[0] ?? e.tagName, r: e.getBoundingClientRect() }));
    const bad: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.r.width === 0 || b.r.width === 0) continue;
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 2 && oy > 2) bad.push(`${a.cls} ∩ ${b.cls} = ${ox.toFixed(0)}×${oy.toFixed(0)}px`);
      }
    }
    return bad;
  });
}

/**
 * 滚到底部时，主内容区是否被吸底命令栏遮挡。
 * 返回「.grid 底边 - .foot 顶边」：≤0 表示主内容完全在命令栏之上，没有被永久遮挡。
 */
async function obscuredAtBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const grid = document.querySelector('.grid');
    const foot = document.querySelector('.foot');
    if (!grid || !foot) return -999;
    return Math.round(grid.getBoundingClientRect().bottom - foot.getBoundingClientRect().top);
  });
}

/**
 * 等待一次任务真正结束。
 * ⚠️ 不能用「.trace__timer 消失」当信号：phase 在 tool_result 时就会离开 'running'，
 *    而回答还在流式输出。必须等 run_completed 对应的「任务完成」步骤出现。
 */
async function waitForRunDone(page: Page): Promise<void> {
  await page.waitForSelector('.answer__text', { timeout: 30000 });
  await page.waitForFunction(
    () => (document.querySelector('.trace')?.textContent ?? '').includes('任务完成'),
    null,
    { timeout: 30000 }
  );
}

async function runFlow(page: Page, label: string, shotPrefix: string): Promise<void> {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.matrix', { timeout: 15000 });
  await page.waitForSelector('.bar', { timeout: 15000 });
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-1-初始.png`), fullPage: true });

  const roomCount = await page.locator('.room').count();
  check(`${label}：实验室矩阵渲染出房间卡片`, roomCount > 0, `${roomCount} 张房间卡片`);

  // 用第一个示例问题（来自真实房间号）发起任务
  await page.locator('.chip').first().click();
  const question = await page.locator('#cmd').inputValue();
  check(`${label}：示例问题已填入命令栏`, question.length > 0, `"${question}"`);

  await page.getByRole('button', { name: '发起任务' }).click();
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-2-查询中.png`), fullPage: true });

  // 等待最终回答与任务收尾
  await waitForRunDone(page);
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-3-结果.png`), fullPage: true });

  const lessonCount = await page.locator('.lesson').count();
  check(`${label}：课程结果以卡片呈现`, lessonCount > 0, `${lessonCount} 条课程卡片`);

  const resultText = (await page.locator('.res').innerText()) || '';
  check(`${label}：结果区标出数据来源（脱敏快照）`, resultText.includes('脱敏快照'), resultText.match(/数据类型[^\n]*/)?.[0] ?? '未找到"数据类型"行');
  check(
    `${label}：结果区未把快照说成实时数据`,
    !/数据类型[^\n]*实时/.test(resultText),
    resultText.match(/数据类型[^\n]*/)?.[0] ?? ''
  );

  const traceSteps = await page.locator('.step').count();
  check(`${label}：任务轨迹有可观察步骤`, traceSteps >= 4, `${traceSteps} 个步骤`);

  const traceText = (await page.locator('.trace').innerText()) || '';
  check(
    `${label}：轨迹出现"正在查询课表 / 已获得结果"层级的信息`,
    /正在查询课表|已获得结果|任务完成/.test(traceText),
    traceText.split('\n').filter((l) => /查询|结果|完成/.test(l)).slice(0, 3).join(' / ')
  );

  const provText = (await page.locator('.prov').innerText()) || '';
  check(
    `${label}：依据区给出查询时间与数据覆盖说明`,
    /查询时间/.test(provText) && /脱敏快照/.test(provText),
    provText.split('\n').slice(0, 6).join(' | ')
  );

  // 溢出与重叠
  const of = await overflowPx(page);
  check(`${label}：无横向溢出（内容不顶破视口）`, of <= 2, `scrollWidth - clientWidth = ${of}px`);

  const overlaps = await overlappingBlocks(page);
  check(`${label}：主要区块互不重叠`, overlaps.length === 0, overlaps.length ? overlaps.join('；') : '4 个主要区块两两无交叠');

  const obscured = await obscuredAtBottom(page);
  check(
    `${label}：滚到底部时主内容不被吸底命令栏遮挡`,
    obscured <= 2,
    `主内容底边 - 命令栏顶边 = ${obscured}px（≤0 表示无遮挡）`
  );
  await page.evaluate(() => window.scrollTo(0, 0));

  // 命令栏可用（键盘可达 + 可点击）
  const cmdVisible = await page.locator('#cmd').isVisible();
  const cmdEnabled = await page.locator('#cmd').isEnabled();
  check(`${label}：命令栏可见且可用`, cmdVisible && cmdEnabled, `visible=${cmdVisible} enabled=${cmdEnabled}`);

  // 确认位：必须是"明确禁用"而不是"看起来能用"
  const confirmDisabled = await page.locator('.dock .btn--primary').isDisabled();
  check(`${label}：确认位按钮明确禁用（第一阶段无写操作）`, confirmDisabled === true, `确认发布按钮 disabled=${confirmDisabled}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const exe = findBrowser();
  console.log(`LabOps Agent 浏览器验收 —— ${BASE}`);
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

    // 无匹配状态
    await page.fill('#cmd', 'E999 2026-09-30 有哪些课？');
    await page.getByRole('button', { name: '发起任务' }).click();
    await waitForRunDone(page);
    const emptyText = (await page.locator('.res').innerText()) || '';
    check('桌面：房间不存在时给出"无匹配 + 可选房间号"', /无匹配|没有收录|没有这个房间号/.test(emptyText) && emptyText.includes('E310'), emptyText.match(/[^\n]*没有[^\n]*/)?.[0] ?? '');
    const emptyLessons = await page.locator('.lesson').count();
    check('桌面：无匹配时不渲染任何课程卡片（不编造）', emptyLessons === 0, `.lesson 数量 = ${emptyLessons}`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'desktop-4-无匹配.png'), fullPage: true });

    // 越界问题
    await page.fill('#cmd', 'D526 现在几个人？');
    await page.getByRole('button', { name: '发起任务' }).click();
    await waitForRunDone(page);
    const oosText = (await page.locator('.res').innerText()) || '';
    check('桌面：能力外问题明确说明未接入', /未接入|做不到/.test(oosText), oosText.match(/[^\n]*未接入[^\n]*/)?.[0] ?? oosText.slice(0, 80));
    // 回归断言：不调工具的路径也必须离开"查询中"，否则界面会一直转圈（曾真实出现）
    const stillRunning = await page.locator('.trace__timer').count();
    check('桌面：不调工具的任务也能正常收尾（不残留"查询中"）', stillRunning === 0, `.trace__timer 元素数 = ${stillRunning}`);

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

  // ============================================================ 汇总
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
