/**
 * PC 端「实验室监控」验收探针（新形态）
 * ============================================================================
 *  覆盖两件事：
 *  ① 内场摄像头未接入时，**只显示"尚未接入实验室场内摄像头"**，
 *     不得出现任何房间卡 / 人数 / 告警 —— 这是本轮用户明确要求。
 *  ② 内置摄像头：用 Chrome 的假摄像头设备验证「开启成功」这条真实路径
 *     （--use-fake-device-for-media-stream），并验证关闭后视频真的停了。
 *
 *  用法：node tests/_probe-vision-pc.ts
 *  前置：npm run demo（Agent 18878），且**不要**设置 VISION_INGEST_SECRET
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
  await page.waitForSelector(accountSel, { timeout: 20000 });
  await page.fill(accountSel, admin!.account);
  await page.fill('input[type="password"]', admin!.password);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  // 假摄像头：让 getUserMedia 真的返回一条合成视频流，而不是走"设备不存在"的降级分支
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  permissions: ['camera']
});
const page = await ctx.newPage();
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

console.log('\n[PC 1440×900 · 实验室监控]');
await page.goto(BASE, { waitUntil: 'networkidle' });
await login(page);

check('侧栏出现「实验室监控」入口', (await page.locator('.vision-entry button').count()) > 0, '');
await page.locator('.vision-entry button').first().click();
await page.waitForSelector('.vision-panel', { timeout: 15000 });
await page.waitForTimeout(1500);

// ---------------- ① 内场：必须是"尚未接入"，且没有任何假数据 ----------------
const notConnected = (await page.locator('.vision-notconnected').innerText().catch(() => '')).trim();
check('内场显示「尚未接入实验室场内摄像头」', notConnected.includes('尚未接入实验室场内摄像头'), `文案="${notConnected}"`);
check('未接入时不渲染房间卡（不拿假数据充数）', (await page.locator('.vision-card').count()) === 0, '');
check('未接入时不渲染事件流水', (await page.locator('.vision-events').count()) === 0, '');
check('未接入时不出现"告警"徽标', (await page.locator('.vision-badge--danger').count()) === 0, '');
const headText = (await page.locator('.vision-head').innerText()).replace(/\s+/g, ' ');
check('顶栏不宣称有摄像头在线/告警', !/告警|个在线/.test(headText), `顶栏="${headText.slice(0, 90)}"`);

// ---------------- ② 内置摄像头：真开一次 ----------------
await page.locator('.builtin__actions button.builtin__primary').first().click();
let opened = true;
try {
  await page.waitForFunction(() => document.querySelector('.builtin__stage')?.classList.contains('is-live'), null, {
    timeout: 20000
  });
} catch {
  opened = false;
}
const failText = (await page.locator('.builtin__error').innerText().catch(() => '')).trim();
check('点「开启内置摄像头」后画面进入 live 状态', opened, opened ? '' : `失败提示="${failText}"`);

if (opened) {
  const playing = await page.evaluate(() => {
    const video = document.querySelector('.builtin__stage video') as HTMLVideoElement | null;
    if (!video) return { ok: false, w: 0, h: 0, paused: true };
    return { ok: true, w: video.videoWidth, h: video.videoHeight, paused: video.paused };
  });
  check('video 元素真的有画面（videoWidth > 0 且未暂停）', playing.ok && playing.w > 0 && !playing.paused, `宽高 ${playing.w}×${playing.h} paused=${playing.paused}`);

  const meta = (await page.locator('.builtin__meta').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('显示朝向与分辨率等信息', /朝向/.test(meta) && /分辨率/.test(meta), meta.slice(0, 90));

  // ---- 镜像显示：默认勾选 + 真的翻转 + 取消后复原 ----
  const mirrorBox = page.locator('.builtin__mirror input[type="checkbox"]');
  const hasMirrorBox = (await mirrorBox.count()) > 0;
  check('前置摄像头出现「镜像显示」开关', hasMirrorBox, hasMirrorBox ? '' : '未找到 .builtin__mirror');
  if (hasMirrorBox) {
    check('镜像显示默认勾选', await mirrorBox.first().isChecked(), `checked=${await mirrorBox.first().isChecked()}`);

    const readTransform = () =>
      page.evaluate(() => {
        const v = document.querySelector('.builtin__stage video') as HTMLVideoElement | null;
        return v ? getComputedStyle(v).transform : 'none';
      });

    const onTransform = await readTransform();
    check('默认已镜像（transform 为负缩放）', /matrix\(-1/.test(onTransform), `transform=${onTransform}`);

    await mirrorBox.first().uncheck();
    await page.waitForTimeout(300);
    const offTransform = await readTransform();
    check('取消勾选后恢复非镜像', !/matrix\(-1/.test(offTransform), `transform=${offTransform}`);

    await mirrorBox.first().check();
    await page.waitForTimeout(300);
    const backTransform = await readTransform();
    check('重新勾选后再次镜像（开关可逆）', /matrix\(-1/.test(backTransform), `transform=${backTransform}`);
  }

  const hasFlip = await page.locator('.builtin__actions button', { hasText: /切换为/ }).count();
  // 假设备只有 1 个摄像头 → 按设计**不该**出现切换按钮（多一个按不动的按钮是负体验）。
  // 多摄像头设备才会出现，那条分支由 cameraCount > 1 守卫。
  check('单摄像头环境下不显示切换按钮（不做无效按钮）', hasFlip === 0, `按钮 ${hasFlip} 个`);

  await page.screenshot({ path: path.join(SHOT, 'device-camera-on.png'), fullPage: false });

  await page.locator('.builtin__actions button', { hasText: '关闭摄像头' }).first().click();
  await page.waitForTimeout(800);
  const stopped = await page.evaluate(() => {
    const video = document.querySelector('.builtin__stage video') as HTMLVideoElement | null;
    const stage = document.querySelector('.builtin__stage');
    return { live: stage?.classList.contains('is-live') ?? false, hasStream: Boolean(video?.srcObject) };
  });
  check('点「关闭摄像头」后停止采集（不残留流）', !stopped.live && !stopped.hasStream, `live=${stopped.live} srcObject=${stopped.hasStream}`);
} else {
  await page.screenshot({ path: path.join(SHOT, 'device-camera-failed.png'), fullPage: false });
}

check('无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | ') || '0 条');

await page.screenshot({ path: path.join(SHOT, 'panel-overview.png'), fullPage: false });
await browser.close();

const pass = results.filter((r) => r.pass).length;
console.log('\n────────────────────────────────────────────');
console.log(`PC 实验室监控验收：${pass}/${results.length} PASS`);
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
console.log(`截图：${SHOT}`);
console.log('────────────────────────────────────────────');
process.exit(pass === results.length ? 0 : 1);
