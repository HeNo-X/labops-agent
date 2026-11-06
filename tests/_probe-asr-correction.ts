/**
 * 「语音术语纠正可见可还原」浏览器验收探针（B3）
 * ============================================================================
 *  验的是**前端链路**，不是识别准确率：
 *    ① 服务端回传 corrections/originalText 后，提示条是否真的出现并写明改了哪几处
 *    ② 「还原原文」是否把草稿里的这一段换回上游原文
 *    ③ 「本轮不要调整术语」是否真的让下一次请求带上 skipTermCorrect
 *    ④ 用户已经手改过草稿时，还原按钮必须是禁用态（不能把用户的修改覆盖掉）
 *
 *  ⚠ /api/agent/transcribe 由 page.route **桩替代**：本探针只证明契约与交互接通，
 *    纠错本身的质量由 `npm run eval:asr` 与 tests/asr-syllable.test.ts 负责，
 *    两者不能互相顶替，也不要在报告里把这里说成"真实识别验收"。
 *
 *  用法：先 `npm run demo`（Agent 18878），再 `node tests/_probe-asr-correction.ts`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Page, Route } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ACCESS = path.resolve(ROOT, '..', '.review-data', 'review-access.json');
const BASE = process.env['LABOPS_BASE'] ?? 'http://127.0.0.1:18878';
const SHOT = path.join(ROOT, '.screenshots', 'asr-correction');

const CHROME = [
  process.env['LABOPS_BROWSER_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((p) => p && fs.existsSync(p));
if (!CHROME) throw new Error('找不到本机 Chrome/Edge，可设 LABOPS_BROWSER_PATH');
if (!fs.existsSync(ACCESS)) throw new Error('缺少演示账号文件（先跑 npm run demo）');

const access = JSON.parse(fs.readFileSync(ACCESS, 'utf8')) as { accounts?: Array<{ account: string; password: string; identity: string }> };
const admin = (access.accounts ?? []).find((a) => a.identity === 'admin');
if (!admin) throw new Error('演示账号里没有 admin');
fs.mkdirSync(SHOT, { recursive: true });

const MISWRITTEN = '帮我看下明天一叶枪还在不在D五一七';
const CORRECTED = '帮我看下明天移液枪还在不在D517';

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page: Page = await ctx.newPage();
const errors: string[] = [];
const transcribeBodies: Array<Record<string, unknown>> = [];

// 桩：带 skipTermCorrect 就原样返回，否则返回"已纠正 + 改动清单"
await page.route('**/api/agent/transcribe', async (route: Route) => {
  const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
  transcribeBodies.push(body);
  const skipped = body['skipTermCorrect'] === true;
  const text = skipped ? MISWRITTEN : CORRECTED;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      text,
      ...(skipped ? { termCorrectSkipped: true } : { originalText: MISWRITTEN, corrections: [
        { from: '一叶枪', to: '移液枪', kind: 'term', at: 6 },
        { from: 'D五一七', to: 'D517', kind: 'room', at: 14 }
      ] }),
      model: 'stub-asr',
      protocol: 'chat_audio',
      elapsedMs: 120
    })
  });
});

page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

async function holdToTalk(ms: number): Promise<void> {
  const mic = page.locator('.bar__mic').first();
  const box = await mic.boundingBox();
  if (!box) throw new Error('麦克风按钮不可定位');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.bar__mic.is-holding', { timeout: 6000 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(2500);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('input[autocomplete="username"], input[name="username"]', { timeout: 20000 });
await page.fill('input[autocomplete="username"], input[name="username"]', admin.account);
await page.fill('input[type="password"]', admin.password);
await page.keyboard.press('Enter');
await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 30000 });
await page.waitForTimeout(1500);

console.log('\n[语音术语纠正 · PC 命令栏]');
check('桩已注册且未提前触发', transcribeBodies.length === 0, `已收到 ${transcribeBodies.length} 次请求`);

await holdToTalk(900);

const draft1 = await page.locator('#cmd').inputValue();
check('识别结果（已纠正版）进入草稿', draft1.includes('移液枪') && draft1.includes('D517'), `草稿="${draft1}"`);

const barText = (await page.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('提示条出现并写明改了哪几处', /一叶枪\s*→\s*移液枪/.test(barText) && /D五一七\s*→\s*D517/.test(barText), `提示条="${barText}"`);
check('提示条是 live region（读屏能收到）', (await page.locator('.vcb').getAttribute('role').catch(() => '')) === 'status', '');
await page.screenshot({ path: path.join(SHOT, 'shown.png') });

// ---- 情况 A：用户在纠错段**之外**追加 —— 段仍完整，还原应当可用且只动那一段 ----
const draftAppended = draft1 + '（我自己补的）';
await page.locator('#cmd').fill(draftAppended);
const restoreEnabledA = await page.locator('.vcb__btn').first().isEnabled().catch(() => false);
check('段外追加时「还原原文」仍可用（同一段完整存在，还原不涉及用户内容）', restoreEnabledA, `enabled=${restoreEnabledA}`);
await page.locator('.vcb__btn').first().click();
await page.waitForTimeout(500);
const draftAfterA = await page.locator('#cmd').inputValue();
check('段外追加后还原：只换那一段，用户补的内容一个字不少',
  draftAfterA === MISWRITTEN + '（我自己补的）',
  `草稿="${draftAfterA}"`);

// ---- 情况 B：用户改了段**之内** —— 无法安全定位原段，还原必须禁用而不是覆盖用户修改 ----
await page.locator('#cmd').fill('');
await holdToTalk(900);
const editedInPlace = await page.locator('#cmd').inputValue();
await page.locator('#cmd').fill(editedInPlace.replace('移液枪', '移液器和枪头'));
const restoreDisabledB = await page.locator('.vcb__btn').first().isDisabled().catch(() => true);
check('段内被改写后「还原原文」禁用（不把用户的修改覆盖掉）', restoreDisabledB, `disabled=${restoreDisabledB}`);

// ---- 还原：重演一次，不改动草稿 ----
await page.locator('#cmd').fill('');
await holdToTalk(900);
const draft2 = await page.locator('#cmd').inputValue();
check('第二次录音结果正常回填', draft2.includes('移液枪'), `草稿="${draft2}"`);
await page.locator('.vcb__btn').first().click();
await page.waitForTimeout(600);
const draft3 = await page.locator('#cmd').inputValue();
check('「还原原文」把这段换回上游原文', draft3.includes('一叶枪') && draft3.includes('D五一七'), `草稿="${draft3}"`);
const barGone = await page.locator('.vcb').count();
check('还原后提示条收起，不重复纠缠', barGone === 0, `剩余 .vcb=${barGone}`);
await page.screenshot({ path: path.join(SHOT, 'restored.png') });

// ---- 叫停：本轮不要调整术语 ----
await page.locator('#cmd').fill('');
await holdToTalk(900);
const beforeSuppress = (await page.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('叫停前照旧给出提示', /→/.test(beforeSuppress), beforeSuppress);
await page.locator('.vcb__btn--ghost').click();
await page.waitForTimeout(400);
await page.locator('#cmd').fill('');
await holdToTalk(900);
const skipSent = transcribeBodies.some((b) => b['skipTermCorrect'] === true);
check('「本轮不要调整术语」后的请求真的带上 skipTermCorrect', skipSent, JSON.stringify(transcribeBodies.map((b) => ({ skip: b['skipTermCorrect'] === true }))));
const draft4 = await page.locator('#cmd').inputValue();
check('叫停后草稿用的就是上游原文（逐字相等，没有半纠正的中间态）', draft4 === MISWRITTEN, `草稿="${draft4}"`);
check('叫停后不再出现提示条', (await page.locator('.vcb').count()) === 0, '');
await page.screenshot({ path: path.join(SHOT, 'suppressed.png') });

const realErrors = errors.filter((e) => !/503 \(Service Unavailable\)|favicon/.test(e));
check('无 console 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || '0 条');

// ---------------------------------------------------------------- 移动端同一条链路
// 两端共用 ChatMessage/VoiceCorrectionBar，但入口与状态回填各写一遍的风险一直存在，
// 所以这里用同一套桩在 390×844 上再验一次：提示条出现、能还原、能叫停。
console.log('\n[语音术语纠正 · 移动端 390×844]');
const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['microphone']
});
await mctx.route('**/api/agent/transcribe', async (route: Route) => {
  const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
  const skipped = body['skipTermCorrect'] === true;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      text: skipped ? MISWRITTEN : CORRECTED,
      ...(skipped ? { termCorrectSkipped: true } : { originalText: MISWRITTEN, corrections: [{ from: '一叶枪', to: '移液枪', kind: 'term', at: 6 }] }),
      model: 'stub-asr', protocol: 'chat_audio', elapsedMs: 120
    })
  });
});
const mpage = await mctx.newPage();
const merrors: string[] = [];
mpage.on('pageerror', (e) => merrors.push(e.message));
await mpage.goto(`${BASE}/mobile.html`, { waitUntil: 'networkidle' });
await mpage.waitForSelector('input[autocomplete="username"], input[name="username"]', { timeout: 20000 });
await mpage.fill('input[autocomplete="username"], input[name="username"]', admin.account);
await mpage.fill('input[type="password"]', admin.password);
await mpage.keyboard.press('Enter');
await mpage.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 30000 });
await mpage.waitForTimeout(1500);

const mmic = mpage.locator('.mobile-mic').first();
// 移动端默认落在工作台（没有输入框），要先走到带长按说话入口的页面才算验收到位
let mmicCount = await mmic.count();
if (mmicCount === 0) {
  // 移动端是 query 路由（navigation.ts 用 history + ?view=），直接进"会话"页比猜文案可靠
  await mpage.goto(`${BASE}/mobile.html?view=assistant`, { waitUntil: 'networkidle' });
  await mpage.waitForTimeout(1500);
  mmicCount = await mmic.count();
  if (mmicCount === 0) {
    // 会话页要先有一个会话才会出现输入框，点"新建"再试一次
    const create = mpage.locator('button', { hasText: '新建' }).first();
    if (await create.count()) {
      try {
        await create.click({ timeout: 4000 });
      } catch {
        /* 点不动就如实报验不到 */
      }
      await mpage.waitForTimeout(1500);
      mmicCount = await mmic.count();
    }
  }
}
check('移动端语音入口可达（长按麦克风按钮存在）', mmicCount > 0, `count=${mmicCount}${mmicCount ? '' : '；正文片段=' + (await mpage.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 140)}`);
if (mmicCount > 0) {
  // 不同入口的输入框 id 不同（MobileConversation 是 #mobile-question，起始页另有），按可用性挑
  const hasQuestion = (await mpage.locator('#mobile-question').count()) > 0;
  const mdraftBox = hasQuestion ? mpage.locator('#mobile-question').first() : mpage.locator('textarea').last();
  const readDraft = async (): Promise<string> => (await mdraftBox.inputValue().catch(() => '')) || '';
  const mbox = await mmic.boundingBox();
  if (mbox) {
    await mpage.mouse.move(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
    await mpage.mouse.down();
    await mpage.waitForTimeout(900);
    await mpage.mouse.up();
    await mpage.waitForTimeout(2500);
    const mdraft = await readDraft();
    check('移动端识别结果进入输入框', mdraft.includes('移液枪'), `草稿="${mdraft}"`);
    const mbar = (await mpage.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    check('移动端出现同一条纠正提示（共用组件，未各写一遍）', /一叶枪\s*→\s*移液枪/.test(mbar), mbar);
    await mpage.screenshot({ path: path.join(SHOT, 'mobile-shown.png') });
    const mrestore = mpage.locator('.vcb__btn').first();
    if (await mrestore.count()) {
      await mrestore.click();
      await mpage.waitForTimeout(600);
      const mdraft2 = await readDraft();
      check('移动端「还原原文」同样生效', mdraft2.includes('一叶枪'), `草稿="${mdraft2}"`);
    } else {
      check('移动端「还原原文」同样生效', false, '没找到还原按钮');
    }
  }
  check('移动端无页面错误', merrors.length === 0, merrors.slice(0, 2).join(' | ') || '0 条');
}

await browser.close();

const pass = results.filter((r) => r.pass).length;
console.log('\n────────────────────────────────────────────');
console.log(`语音纠正可见可还原验收：${pass}/${results.length} PASS`);
for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
console.log(`截图：${SHOT}`);
console.log('────────────────────────────────────────────');
process.exit(pass === results.length ? 0 : 1);
