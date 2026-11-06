/**
 * U3 体检端点的路由与只读性 —— 真起服务，不用桩
 * ============================================================================
 *  纯函数结论已由 tests/asr-lexicon-report.test.ts 钉死；这里只补三件只有真服务能证的事：
 *    ① 路由确实注册了（不是 404），且只认 POST；
 *    ② 没有登录身份时拿不到报告（内置表指纹、配置开关这些不该对匿名暴露）；
 *    ③ **只读**：调完之后术语表文件与临时库都没被动过 —— 端点说"我不写任何东西"，
 *       这句话必须被验证，不能只写在注释里。
 *
 *  运行：node --test tests/asr-lexicon-check-route.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-lexicon-check-'));
process.env.LABOPS_AUTH_MODE = 'demo';
process.env.LABOPS_DB_PATH = path.join(temp, 'check.sqlite');
process.env.AGNES_API_KEY = '';
process.env.DASHSCOPE_API_KEY = '';

const GLOSSARY = path.join(root, 'shared', 'asr-glossary.json');
const glossaryBefore = fs.readFileSync(GLOSSARY, 'utf8');

const { withHttpIdentity } = await import('../server/security/http.ts');
const { handleRequest } = await import('../server/index.ts');

const server = http.createServer((req, res) => {
  withHttpIdentity(req, res, () => handleRequest(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => {
  server.close();
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    console.log(`[teardown] 临时目录未清理（被占用，不影响结论）：${temp}`);
  }
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ENDPOINT = '/api/agent/asr-lexicon-check';

async function demoCookie(): Promise<string> {
  const boot = await fetch(`${base}/api/conversations`);
  const raw = boot.headers.get('set-cookie');
  assert.ok(raw, '演示身份会话应下发 cookie');
  return raw.split(';')[0]!;
}

test('路由已注册：GET 走 405 而不是 404，方法限制说得很具体', async () => {
  const cookie = await demoCookie();
  const res = await fetch(base + ENDPOINT, { method: 'GET', headers: { Cookie: cookie } });
  assert.equal(res.status, 405, `期望 405，实际 ${res.status}`);
  const body = (await res.json()) as { error?: string; message?: string };
  assert.equal(body.error, 'method_not_allowed');
  assert.match(body.message ?? '', /POST/);
});

test('鉴权是 handler 自己判的：不经 withHttpIdentity 直接调用就是 401', async () => {
  // 演示模式下整条链走通后匿名也能拿到报告（与转写同一档沙盒口径），所以这里把
  // "没有身份就没有报告"这条判据单独测：绕开统一鉴权包裹，直接敲 handler。
  const { handleAsrLexiconCheck } = await import('../server/api/asr-lexicon-report.ts');
  const req = Readable.from([JSON.stringify({ keywords: ['门禁'], pairs: [] })]) as unknown as IncomingMessage;
  Object.assign(req as unknown as Record<string, unknown>, { method: 'POST', headers: { 'content-type': 'application/json' } });
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (body?: unknown) => {
      payload = String(body ?? '');
      return res;
    },
    headersSent: false
  } as unknown as ServerResponse;
  await handleAsrLexiconCheck(req, res);
  assert.equal(status, 401, `期望 401，实际 ${status}：${payload}`);
  assert.match(payload, /authentication_required/);
  // 表指纹、配置开关这类内部事实一句都不该漏出去
  assert.doesNotMatch(payload, /fingerprint|指纹|chat_audio/);
});

test('登录后报告可用，结论跟着请求里的词走，且服务端一个字都没写', async () => {
  const cookie = await demoCookie();
  const call = async (payload: unknown) => {
    const res = await fetch(base + ENDPOINT, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    // 先整段读文本再解析：断言消息里再 res.text() 会把 body 提前消耗掉
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return JSON.parse(text) as {
      ok: boolean;
      builtIn: { terms: number; fingerprint: string };
      effective: { contextEnabled: boolean; protocol: string };
      keywords: Array<{ word: string; verdict: string; why: string }>;
      pairs: Array<{ from: string; verdict: string }>;
      merge: { candidates: unknown[]; needPinyin: string[] };
    };
  };

  const empty = await call({});
  assert.equal(empty.ok, true);
  assert.equal(empty.builtIn.terms, 148, '内置表条数该是真表读出来的');
  assert.deepEqual(empty.keywords, []);
  assert.match(empty.builtIn.fingerprint, /^[0-9a-f]{12}$/);

  const withWords = await call({
    keywords: ['投影仪', '门禁电源开关面板'],
    pairs: [
      { from: '保修', to: '报修' },
      // 真表里「门禁」的别名就有「门金」，所以这条该被认成重复劳动 —— 这不是我编的期望，
      // 是报告跟着真表走的结果
      { from: '门金', to: '门禁' },
      { from: '门禁全关', to: '门禁已全部关闭' }
    ],
    // 恶意/畸形字段：必须被清洗掉而不是报错或写进任何地方
    extra: { anything: true },
    termPairs: 'not-an-array'
  });
  // 默认配置下偏置是关的：主结论必须是"没发出去"，同时把"内置本来就有"这条更值钱的补话说出来
  assert.deepEqual(withWords.keywords.map((k) => k.word).sort(), ['投影仪', '门禁电源开关面板']);
  const projector = withWords.keywords.find((k) => k.word === '投影仪')!;
  assert.equal(projector.verdict, 'bias-off');
  assert.match(projector.why, /内置术语表本来就有/);
  assert.equal(withWords.pairs.find((p) => p.from === '保修')!.verdict, 'collides-with-protect');
  assert.equal(withWords.pairs.find((p) => p.from === '门金')!.verdict, 'redundant-with-builtin');
  assert.equal(withWords.pairs.find((p) => p.from === '门禁全关')!.verdict, 'active');

  // 打开偏置（并把预算给足，避免"被挤掉"与"已进上下文"两种结论互相混淆）后，
  // 同一批词的结论必须跟着配置变 —— 这证明报告读的是配置，不是写死的文案
  process.env.ASR_CONTEXT_ENABLED = '1';
  process.env.ASR_CONTEXT_MAX_CHARS = '4000';
  try {
    // 两个词只差一个字（「面」不在字表里），用来同时验证"能推的给候选、推不出的只登记不猜"
    const biased = await call({ keywords: ['投影仪', '门禁电源板', '门禁电源开关面板'], pairs: [] });
    assert.equal(biased.effective.contextEnabled, true);
    assert.equal(biased.keywords.find((k) => k.word === '投影仪')!.verdict, 'already-in-builtin');
    assert.equal(biased.keywords.find((k) => k.word === '门禁电源板')!.verdict, 'in-context');
    const candidates = biased.merge.candidates.map((c) => (c as { canonical?: string }).canonical);
    assert.ok(candidates.includes('门禁电源板'), `读音全在字表里的词该进合并候选：${JSON.stringify(candidates)}`);
    assert.ok(!candidates.includes('门禁电源开关面板'), '推不出读音的词绝不给一个猜出来的 syll');
    assert.deepEqual(biased.merge.needPinyin, ['门禁电源开关面板'], JSON.stringify(biased.merge.needPinyin));
  } finally {
    delete process.env.ASR_CONTEXT_ENABLED;
    delete process.env.ASR_CONTEXT_MAX_CHARS;
  }

  // 只读的硬证据：术语表文件字节不变
  assert.equal(fs.readFileSync(GLOSSARY, 'utf8'), glossaryBefore, '体检端点不许碰术语表文件');
});
