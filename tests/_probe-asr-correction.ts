/**
 * 「语音术语纠正可见可还原」浏览器验收探针（B3）
 * ============================================================================
 *  验的是**前端链路**，不是识别准确率：
 *    ① 服务端回传 corrections/originalText 后，提示条是否真的出现并写明改了哪几处
 *    ② 「还原原文」是否把草稿里的这一段换回上游原文
 *    ③ 「本页不再自动调整术语」是否真的让后续请求带上 skipTermCorrect，
 *       并且这个状态看得见、点一下就能撤回（只给开关不给回头路不算交付）
 *    ④ 用户已经手改过草稿时，还原按钮必须是禁用态（不能把用户的修改覆盖掉）
 *    ⑤ U1 用户登记：词对存在本机、随请求带上、来源在提示条里说得清、
 *       叫停只停词典自动规则、删掉登记能真正回到改造前的请求形态
 *    ⑥ U2 常用词：只进事前偏置（不改写文本），并且面板说法跟着服务端开关变 ——
 *       关着说"未发给模型"，开着给出字数/词数，叫停说"这次没发"，删光就不再带字段
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

const USER_FROM = '投映仪';
const USER_TO = '投影仪';
const USER_RAW = '投映仪已修好';
const USER_FIXED = '投影仪已修好';

/**
 * 桩服务端的偏置开关，模拟现网 `.env` 的 ASR_CONTEXT_ENABLED：
 * 默认关 —— 这正是 U2 面板最容易骗人的地方（词保存了≠发给模型了），
 * 所以两种状态都要跑一遍，看界面说法是否跟着服务端事实变。
 */
let stubContextEnabled = false;

/** 按请求体算出服务端会回报的 bias（照实反映"发没发"，不给默认值糊弄） */
function stubBias(body: Record<string, unknown>): Record<string, unknown> {
  const skipped = body['skipTermCorrect'] === true;
  const keywords = Array.isArray(body['extraTerms']) ? (body['extraTerms'] as unknown[]).length : 0;
  const sent = stubContextEnabled && !skipped;
  return {
    context: sent,
    options: true,
    hotwords: false, // 桩按现网协议 chat_audio 说话：这条路没有热词通道
    hotwordCount: 0,
    format: false,
    language: 'zh',
    itn: false,
    degraded: false,
    contextChars: sent ? 26 + keywords * 4 : 0,
    termsInContext: sent ? 8 + keywords : 0,
    omittedFromBudget: 0,
    hotwordsAvailable: 0,
    userKeywordsRegistered: keywords,
    suppressedByUser: skipped
  };
}

// 桩：带 termPairs 优先走"用户登记"分支；否则带 skipTermCorrect 原样返回，再否则返回"词典已纠正 + 改动清单"
await page.route('**/api/agent/transcribe', async (route: Route) => {
  const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
  transcribeBodies.push(body);
  const skipped = body['skipTermCorrect'] === true;
  const bias = stubBias(body);
  if (Array.isArray(body['termPairs']) && (body['termPairs'] as unknown[]).length) {
    // 服务端第零遍的形状：只回用户登记的那一条改动，且 via='user'；叫停时也照样生效
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        text: USER_FIXED,
        originalText: USER_RAW,
        corrections: [{ from: USER_FROM, to: USER_TO, kind: 'term', at: 0, via: 'user' }],
        ...(skipped ? { termCorrectSkipped: true } : {}),
        bias,
        model: 'stub-asr',
        protocol: 'chat_audio',
        elapsedMs: 120
      })
    });
    return;
  }
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
      bias,
      model: 'stub-asr',
      protocol: 'chat_audio',
      elapsedMs: 120
    })
  });
});

page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

/**
 * PC 长按说话。命令栏在 6e6bce3 之后改成微信式两段交互（点麦克风→整行「按住说话」长条，
 * 识别完自动退回输入框），所以这里两种形态都认：认不出长条就退回旧的 `.bar__mic.is-holding`。
 * 探针跟着现网形态走，而不是让产品为了迁就探针保持不变 —— 但认哪种都要真的把录音按住，
 * 拿不到"正在录"的证据就直接失败，不许静默跳过。
 */
async function holdToTalk(ms: number): Promise<void> {
  const speak = page.locator('.bar__speak');
  if ((await speak.count()) === 0) {
    const micBtn = page.locator('.bar__mic').first();
    const mbox = await micBtn.boundingBox();
    if (!mbox) throw new Error('麦克风按钮不可定位');
    await page.mouse.click(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
    await speak.first().waitFor({ state: 'visible', timeout: 6000 });
  }
  const box = await speak.first().boundingBox();
  if (!box) throw new Error('「按住说话」长条不可定位');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.bar__speak.is-active', { timeout: 6000 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
  // 识别完成后 voiceMode 会退回输入框，等到 #cmd 可用再断言草稿
  await page.waitForSelector('#cmd', { state: 'visible', timeout: 12000 });
  await page.waitForTimeout(600);
}


/**
 * 词汇面板已迁到 设置 → 个性化（它是一份长期生效的个人配置，不该贴在输入条下面）。
 * 设置是模态层，语音长按必须在关掉它之后做，所以这里成对提供 open/close，
 * 并在 close 后等输入框回来 —— 探针要是拿着打开中的设置去点麦克风，只会测到一个假失败。
 */
async function openVocabulary(): Promise<void> {
  await page.getByRole('button', { name: '账户与设置', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForSelector('.settings-dialog', { state: 'visible', timeout: 12000 });
  const tab = page.getByRole('tab', { name: '个性化', exact: true });
  if ((await tab.count()) > 0) await tab.click();
  await page.waitForSelector('.settings-voice', { state: 'visible', timeout: 8000 });
}

async function closeVocabulary(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.settings-dialog', { state: 'hidden', timeout: 8000 }).catch(() => {});
  await page.waitForSelector('#cmd', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
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

// ---- 叫停：本页不再自动调整术语（含恢复） ----
await page.locator('#cmd').fill('');
await holdToTalk(900);
const beforeSuppress = (await page.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('叫停前照旧给出提示', /→/.test(beforeSuppress), beforeSuppress);
await page.locator('.vcb__btn--ghost').click();
await page.waitForTimeout(400);
await page.locator('#cmd').fill('');
await holdToTalk(900);
const skipSent = transcribeBodies.some((b) => b['skipTermCorrect'] === true);
check('「本页不再自动调整术语」后的请求真的带上 skipTermCorrect', skipSent, JSON.stringify(transcribeBodies.map((b) => ({ skip: b['skipTermCorrect'] === true }))));
const draft4 = await page.locator('#cmd').inputValue();
check('叫停后草稿用的就是上游原文（逐字相等，没有半纠正的中间态）', draft4 === MISWRITTEN, `草稿="${draft4}"`);
// 抑制状态必须**看得见**并且能撤回：只给开关不给回头路，不算"决定权在用户"
const suppressedLine = (await page.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('叫停后仍留一行可见状态（不静默改变行为）', /已停止自动调整术语/.test(suppressedLine), suppressedLine);
const resume = page.locator('.vcb__btn--ghost');
check('叫停后给出「恢复术语调整」入口', (await resume.count()) > 0, `count=${await resume.count()}`);
await page.locator('#cmd').fill('');
await resume.click();
await page.waitForTimeout(400);
await holdToTalk(900);
const draft5 = await page.locator('#cmd').inputValue();
check('恢复后下一次请求不再带 skipTermCorrect，草稿重新是纠正版',
  transcribeBodies.at(-1)?.['skipTermCorrect'] !== true && draft5.includes('移液枪'),
  `最后一条请求 skip=${transcribeBodies.at(-1)?.['skipTermCorrect'] === true}；草稿="${draft5}"`);
await page.screenshot({ path: path.join(SHOT, 'suppressed.png') });

// ---------------------------------------------------------------- U1：用户自己登记的「识别成 → 应该是」
console.log('\n[U1 · 登记常见误写]');
const beforeU1 = transcribeBodies.length;
await openVocabulary();
check('入口已迁到 设置 → 个性化（面板在 .settings-voice 里，不再压在输入条下）',
  (await page.locator('.settings-voice .vtp').count()) > 0,
  `count=${await page.locator('.settings-voice .vtp').count()}`);
check('嵌入态不再自己叠一层折叠头（避免"设置里又有个收起"）',
  (await page.locator('.settings-voice .vtp__toggle').count()) === 0, '');
check('顶部有一句作用解释，且说清两份词的差别',
  /一份确定改写识别结果/.test((await page.locator('.settings-voice .vtp__intro').innerText().catch(() => '')).replace(/\s+/g, ' ')), '');
check('没登记时请求体一个 termPairs 字段都不带（与改造前逐字一致）',
  transcribeBodies.slice(0, beforeU1).every((b) => b['termPairs'] === undefined),
  JSON.stringify(transcribeBodies.slice(0, beforeU1).map((b) => Object.keys(b))));

await page.fill('#vtp-from', USER_FROM);
await page.fill('#vtp-to', USER_TO);
await page.getByRole('button', { name: '保存', exact: true }).click();
await page.waitForTimeout(250);
await closeVocabulary();
await openVocabulary();
const storedRaw = await page.evaluate(() => localStorage.getItem('labops.asr.term-pairs'));
const stored = (() => { try { return JSON.parse(String(storedRaw)) as unknown; } catch { return null; } })();
check('登记存在本机浏览器（服务端不落盘、不影响别人）',
  Array.isArray(stored) && (stored[0] as { to?: string })?.to === USER_TO, String(storedRaw));
check('列表里能看到并管理刚登记的那条', (await page.locator('.vtp__list li').count()) === 1, String(await page.locator('.vtp__list').innerText().catch(() => '')));

await closeVocabulary();
await page.locator('#cmd').fill('');
await holdToTalk(900);
const u1Body = transcribeBodies.at(-1) ?? {};
check('下一次语音请求真的把词对带上去',
  JSON.stringify(u1Body['termPairs']) === JSON.stringify([{ from: USER_FROM, to: USER_TO }]),
  JSON.stringify(u1Body['termPairs']));
const draft6 = await page.locator('#cmd').inputValue();
check('登记生效：草稿用的就是你写的那个词', draft6.includes(USER_FIXED), `草稿="${draft6}"`);
const bar6 = (await page.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('提示条把来源说清：改动来自你登记的写法，不是系统自己猜的',
  /按你登记的写法替换了 1 处/.test(bar6) && !/按实验室术语表调整/.test(bar6), bar6);
await page.screenshot({ path: path.join(SHOT, 'user-pair.png') });

// 单字为什么不让登记：一次手滑就能把整句的某个字全换掉，界面必须当场拒绝并说明理由
await openVocabulary();
await page.fill('#vtp-from', '枪');
await page.fill('#vtp-to', '枪头');
await page.getByRole('button', { name: '保存', exact: true }).click();
await page.waitForTimeout(200);
const shortNotice = (await page.locator('.vtp__body > .vtp__notice').innerText().catch(() => '')).trim();
check('单字登记被当场拦下，并且新字段名出现在提示里', /错误词/.test(shortNotice) && /至少 2 个字/.test(shortNotice), shortNotice);
check('拦下之后没有多出脏数据', (await page.locator('.vtp__list li').count()) === 1, String(await page.locator('.vtp__list li').count()));

// 叫停只该停"自动"：用户自己写下的规则不该被一个临时开关顺带否决
await closeVocabulary();
await page.locator('#cmd').fill('');
await holdToTalk(900);
await page.locator('.vcb__btn--ghost').click();
await page.waitForTimeout(300);
await page.locator('#cmd').fill('');
await holdToTalk(900);
const suppressedBody = transcribeBodies.at(-1) ?? {};
check('叫停后请求同时带 skipTermCorrect 与 termPairs（两件事各说各的）',
  suppressedBody['skipTermCorrect'] === true && Array.isArray(suppressedBody['termPairs']),
  JSON.stringify({ skip: suppressedBody['skipTermCorrect'], pairs: suppressedBody['termPairs'] }));
const bar7 = (await page.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('界面说法与行为一致：已停止自动调整，但仍按你登记的写法替换',
  /本页已停止自动调整，只按你登记的写法替换了 1 处/.test(bar7), bar7);

// 收回：删掉登记后必须回到"不带词对"的形态，否则用户没法真正反悔
await openVocabulary();
await page.locator('.vtp__list .vtp__del').first().click();
await closeVocabulary();
await page.waitForTimeout(250);
await page.locator('#cmd').fill('');
await holdToTalk(900);
check('删除登记后请求不再带 termPairs（可逆，且当场生效）',
  transcribeBodies.at(-1)?.['termPairs'] === undefined,
  JSON.stringify(transcribeBodies.at(-1)?.['termPairs']));
check('列表清空后 localStorage 里也没留脏数据',
  (await page.evaluate(() => localStorage.getItem('labops.asr.term-pairs'))) === '[]',
  String(await page.evaluate(() => localStorage.getItem('labops.asr.term-pairs'))));

// ---------------------------------------------------------------- U2：常用词进事前偏置 + "到底发没发"要看得见
console.log('\n[U2 · 常用词与偏置真实状态]');
// U1 段末留在"叫停"态，先恢复，否则后面每一步都会被 suppressedByUser 干扰
const resume2 = page.locator('.vcb__btn--ghost');
if ((await resume2.count()) > 0) {
  await resume2.click();
  await page.waitForTimeout(300);
}
const KW = '稳压器';
await openVocabulary();
await page.fill('#vtp-word', KW);
await page.press('#vtp-word', 'Enter');
await page.waitForTimeout(250);
const kwStored = await page.evaluate(() => localStorage.getItem('labops.asr.keywords'));
check('常用词写进本机浏览器（与词对分开存，互不影响）', String(kwStored).includes(KW), String(kwStored));
check('列表里出现这枚词条', (await page.locator('.vtp__chips li').count()) === 1, String(await page.locator('.vtp__chips').innerText().catch(() => '')));

await closeVocabulary();
await page.locator('#cmd').fill('');
await holdToTalk(900);
const kwBody = transcribeBodies.at(-1) ?? {};
await openVocabulary();
check('下一次请求把常用词带上（extraTerms）',
  JSON.stringify(kwBody['extraTerms']) === JSON.stringify([KW]), JSON.stringify(kwBody['extraTerms']));
const statusOff = (await page.locator('.settings-voice .vtp__status').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('偏置关着时不许说成"已生效"：状态行明确写未发给模型',
  /未发给模型/.test(statusOff) && !/已把常用词/.test(statusOff), statusOff);

// 单字为什么当场拦：它只能进偏置通道，而单字提示的收益说不清
await page.fill('#vtp-word', '枪');
await page.press('#vtp-word', 'Enter');
await page.waitForTimeout(250);
const kwNotice = (await page.locator('.vtp__section .vtp__notice').innerText().catch(() => '')).trim();
check('单字常用词被拦下并指出去哪条路才确定生效', /错误纠正示例/.test(kwNotice), kwNotice);
check('拦下后列表没被塞进脏数据', (await page.locator('.vtp__chips li').count()) === 1, String(await page.locator('.vtp__chips li').count()));

// 把服务端"开关打开"（模拟 .env 改 ASR_CONTEXT_ENABLED=1），界面说法必须跟着变
stubContextEnabled = true;
await closeVocabulary();
await page.locator('#cmd').fill('');
await holdToTalk(900);
await openVocabulary();
const statusOn = (await page.locator('.settings-voice .vtp__status').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('开关打开后状态行改口：已随请求发出，并给出字数/词数',
  /已把常用词连同内置词表发给模型/.test(statusOn) && /当前协议没有热词通道/.test(statusOn), statusOn);
const barOn = (await page.locator('.vcb').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('常用词只进偏置、不改写文本：改动清单仍是词典那两处，没多出"按常用词替换"',
  /一叶枪/.test(barOn) && /D五一七/.test(barOn) && !/稳压器/.test(barOn), barOn);
await page.screenshot({ path: path.join(SHOT, 'keywords-on.png') });

// 叫停：偏置属于"系统在影响这句话怎么被听出来"，叫停就得一起停，并且要说清停的是它
await closeVocabulary();
await page.locator('#cmd').fill('');
await holdToTalk(900);
await page.locator('.vcb__btn--ghost').click();
await page.waitForTimeout(300);
await page.locator('#cmd').fill('');
await holdToTalk(900);
await openVocabulary();
const supBody = transcribeBodies.at(-1) ?? {};
const statusSup = (await page.locator('.settings-voice .vtp__status').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('叫停后请求带上 skipTermCorrect，状态行说"这次没有发给模型"（不谎报）',
  supBody['skipTermCorrect'] === true && /没有发给模型/.test(statusSup), statusSup);
// 恢复按钮在输入条上，设置是模态层 —— 不先关掉就是点不到，报出来的错还像是功能坏了
await closeVocabulary();
await page.locator('.vcb__btn--ghost').click();
await page.waitForTimeout(300);

// 收回：删掉常用词后不该再往请求里塞字段
await openVocabulary();
await page.locator('.vtp__chip-del').first().click();
await page.waitForTimeout(250);
await closeVocabulary();
await page.locator('#cmd').fill('');
await holdToTalk(900);
await openVocabulary();
check('删除后请求不再带 extraTerms（可逆，且当场生效）',
  transcribeBodies.at(-1)?.['extraTerms'] === undefined, JSON.stringify(transcribeBodies.at(-1)?.['extraTerms']));
const statusEmpty = (await page.locator('.settings-voice .vtp__status').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
check('列表空了，状态行也不再声称发过', /还没有登记常用词/.test(statusEmpty), statusEmpty);
stubContextEnabled = false;
await closeVocabulary();

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
  // 不同入口的输入框 id 不同（MobileConversation 是 #mobile-question，起始页另有），而且语音模式
  // 会先把输入框换成整行长按条，所以每次都重新查，不缓存句柄
  const readDraft = async (): Promise<string> => {
    const box = (await mpage.locator('#mobile-question').count()) ? mpage.locator('#mobile-question').first() : mpage.locator('textarea').last();
    return (await box.inputValue().catch(() => '')) || '';
  };
  const mHold = async (): Promise<void> => {
    const speak = mpage.locator('.mobile-speak');
    if ((await speak.count()) === 0) {
      // 新版移动端也是"点麦克风→切语音模式"，旧的长按麦克风图标形态仍可用，两种都认
      const mbox = await mmic.boundingBox();
      if (!mbox) throw new Error('移动端麦克风不可定位');
      await mpage.mouse.click(mbox.x + mbox.width / 2, mbox.y + mbox.height / 2);
      await speak.first().waitFor({ state: 'visible', timeout: 6000 });
    }
    const sbox = await speak.first().boundingBox();
    if (!sbox) throw new Error('移动端长按条不可定位');
    await mpage.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
    await mpage.mouse.down();
    await mpage.waitForTimeout(900);
    await mpage.mouse.up();
    await mpage.waitForTimeout(2500);
  };
  await mHold();
  {
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
  // 热词面板：同一份组件两端共用，移动端也要能从 设置 → 个性化 进入并登记常用词
  await mpage.goto(`${BASE}/mobile.html?view=settings&category=personalization`, { waitUntil: 'networkidle' });
  await mpage.waitForTimeout(1500);
  const mPanel = mpage.locator('.settings-voice');
  if ((await mPanel.count()) > 0) {
    await mpage.fill('#vtp-word', '门禁电源板');
    await mpage.press('#vtp-word', 'Enter');
    await mpage.waitForTimeout(250);
    const mChips = await mPanel.locator('.vtp__chips').innerText().catch(() => '');
    check('移动端在设置-个性化里有同一份热词面板，登记常用词生效',
      mChips.includes('门禁电源板'), mChips.slice(0, 80));
    await mpage.screenshot({ path: path.join(SHOT, 'mobile-voice-terms.png') });
  } else {
    check('移动端在设置-个性化里有同一份热词面板，登记常用词生效', false, '没找到 .settings-voice');
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
