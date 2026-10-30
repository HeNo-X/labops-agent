/**
 * 「长按说话」浏览器验收探针
 * ============================================================================
 *  验的是交互链路，不是识别准确率：
 *    按下 → 真的开始录音（状态条出现「正在聆听」、按钮文案变「松手结束并识别」）
 *    松手 → 结束录音并发起转写（无 ASR Key 时应报「语音识别未配置」而不是静默失败）
 *    短按（< 350ms）→ 视为误触，取消且**不发请求**
 *
 *  用 Chrome 的假麦克风设备，否则 getUserMedia 直接 NotFoundError，验不到录音态。
 *  用法：node tests/_probe-voice-hold.ts
 *  前置：npm run demo（Agent 18878）
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
const SHOT = path.join(ROOT, '.screenshots', 'voice-hold');

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

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['microphone']
});
const page: Page = await ctx.newPage();
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[autocomplete="username"], input[name="username"]', { timeout: 20000 });
await page.fill('input[autocomplete="username"], input[name="username"]', admin.account);
await page.fill('input[type="password"]', admin.password);
await page.keyboard.press('Enter');
await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

console.log('\n[PC 长按说话]');
const mic = page.locator('.bar__mic').first();
check('输入区出现麦克风按钮', (await mic.count()) > 0, '');

const box = await mic.boundingBox();
if (!box) throw new Error('麦克风按钮不可见，无法定位');
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// ---------------- 长按：按下 → 录音中 ----------------
await page.mouse.move(cx, cy);
await page.mouse.down();

// ① 事件有没有真的进到 handler：按下瞬间就该有 is-holding（不依赖录音是否成功）
let wired = true;
try {
  await page.waitForSelector('.bar__mic.is-holding', { timeout: 4000 });
} catch {
  wired = false;
}
check('按下后 handler 被触发（按钮进入 is-holding）', wired, wired ? '' : '未出现 .bar__mic.is-holding —— 事件没绑上');

// ② 是否真的开始录音：按住期间「正在聆听」与「松手结束」应同时可见
//    （用正文文本判定，不猜具体类名 —— 类名我改过几版，文本是稳定契约）
let recording = true;
try {
  await page.waitForFunction(
    () => document.body.innerText.includes('正在聆听') && document.body.innerText.includes('松手结束'),
    null,
    { timeout: 8000 }
  );
} catch {
  recording = false;
}
const bodyWhileHolding = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
const labelWhileHolding = await mic.getAttribute('aria-label');
check(
  '按住期间显示「正在聆听 / 松手结束」',
  recording,
  recording ? '已出现' : `未出现；按钮 aria-label="${labelWhileHolding}"; 正文片段="${bodyWhileHolding.slice(0, 120)}"`
);

check('按住期间按钮文案变为「松手结束并识别」', (labelWhileHolding ?? '').includes('松手结束'), `aria-label=${labelWhileHolding}`);

await page.screenshot({ path: path.join(SHOT, 'holding.png'), fullPage: false });

// ---------------- 松手 → 结束并转写 ----------------
await page.mouse.up();
let released = true;
try {
  await page.waitForFunction(
    () => !(document.querySelector('.bar__voice-bar')?.textContent ?? '').includes('正在聆听'),
    null,
    { timeout: 15000 }
  );
} catch {
  released = false;
}
check('松手后离开录音状态', released, released ? '' : '仍在「正在聆听」');

// 无 ASR Key 时应给出「未配置」而不是静默失败；有 Key 则应把文本填进输入框
await page.waitForTimeout(4000);
const hint = (await page.locator('.bar__voice-hint').innerText().catch(() => '')).trim();
const draft = await page.locator('#cmd').inputValue().catch(() => '');
const filledOrExplained = /未配置|配额|没有听清|失败|暂不可用/.test(hint) || draft.trim().length > 0;
check('松手后有明确结果（回填文本 或 说明为何没识别）', filledOrExplained, `提示="${hint}" 草稿长度=${draft.trim().length}`);

// ---------------- 短按：应视为误触，不发请求、不回填 ----------------
await page.waitForTimeout(800);
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(120);
await page.mouse.up();
await page.waitForTimeout(2500);
const draftAfterShort = await page.locator('#cmd').inputValue().catch(() => '');
check(
  '短按（120ms）视为误触：不回填任何内容',
  draftAfterShort === draft,
  `草稿 ${draft.length}→${draftAfterShort.length}（清掉陈旧提示属正常，只看草稿是否被污染）`
);

await page.screenshot({ path: path.join(SHOT, 'after.png'), fullPage: false });
// 无 ASR Key 时 /api/agent/transcribe 返回 503 是**预期**行为，不算错误
const realErrors = errors.filter((e) => !/503 \(Service Unavailable\)/.test(e));
check('无 console 错误（503 转写未配置属预期，已排除）', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '0 条');

await browser.close();

const pass = results.filter((r) => r.pass).length;
console.log('\n────────────────────────────────────────────');
console.log(`长按说话验收：${pass}/${results.length} PASS`);
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
console.log(`截图：${SHOT}`);
console.log('────────────────────────────────────────────');
process.exit(pass === results.length ? 0 : 1);
