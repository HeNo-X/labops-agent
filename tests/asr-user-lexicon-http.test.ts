/**
 * U1 + U2 的服务端 HTTP 端到端 —— 真起服务、真走 handleTranscribe，只把最外层上游替换为替身
 * ============================================================================
 *  覆盖范围：浏览器探针（桩掉 /api/agent/transcribe，验前端契约）与纯函数单测（验纠正层）
 *  之间存在一段空白 —— **"请求体里的 termPairs / extraTerms 到底走没走到
 *  handleTranscribe 的两条通道"** 没有真 HTTP 覆盖。这条文件补的就是这段：
 *    ① termPairs 经 HTTP 生效，且与词典改动共存（第零遍先占位，后面的规则不再二次改）；
 *    ② skipTermCorrect 停的是词典自动改动，**不停用户自己登记的词对**（U1 的语义声明）；
 *    ③ extraTerms 经 HTTP 进了首位 system 上下文，并且开关关着时整个字段不出现（U2 的语义声明）。
 *
 *  上游 fetch 换替身是有意的：真实模型输出不可复现，而这里要验的是**我们自己的接线**，
 *  不是模型的准确率（后者仍欠 51 段录音，见 npm run eval:asr -- --mode=live）。
 *
 *  运行：node --test tests/asr-user-lexicon-http.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-lexicon-http-'));
process.env.LABOPS_AUTH_MODE = 'demo';
process.env.LABOPS_DB_PATH = path.join(temp, 'lexicon.sqlite');
process.env.AGNES_API_KEY = '';
// 有 Key 才会真的走到上游调用（我们用替身接住），否则端点直接 503
process.env.DASHSCOPE_API_KEY = 'test-fake-key-never-real-42';
delete process.env.ASR_API_KEY;
delete process.env.ASR_PROTOCOL;
delete process.env.ASR_CONTEXT_ENABLED;

const MISWRITTEN = '帮我看下明天一叶枪还在不在D五一七';
const AUDIO = Buffer.alloc(1200, 7).toString('base64');

/** 上游替身：记下发出去的请求体，回一段固定的 chat_audio 结果 */
const upstream: Array<Record<string, unknown>> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const target = String(url);
  // 只截外部上游；本机测试服务（127.0.0.1）必须原样放行，否则连 set-cookie 都拿不到
  if (!target.includes('dashscope.aliyuncs.com')) return realFetch(url as string, init);
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  upstream.push(body);
  return new Response(JSON.stringify({ choices: [{ message: { content: MISWRITTEN } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    console.log(`[teardown] 临时目录未清理（被占用，不影响结论）：${temp}`);
  }
});

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
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const boot = await fetch(`${base}/api/conversations`);
const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;

async function transcribe(payload: Record<string, unknown>) {
  upstream.length = 0;
  const res = await fetch(`${base}/api/agent/transcribe`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: AUDIO, mime: 'audio/wav', ...payload })
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return { data: JSON.parse(text) as Record<string, any>, sent: upstream[0] ?? {} };
}

const systemText = (sent: Record<string, unknown>): string => {
  const messages = (sent['messages'] ?? []) as Array<{ role?: string; content?: unknown }>;
  const sys = messages.find((m) => m.role === 'system');
  if (!sys) return '';
  if (typeof sys.content === 'string') return sys.content;
  if (Array.isArray(sys.content)) return sys.content.map((p) => String((p as { text?: unknown }).text ?? '')).join('');
  return '';
};

// ---------------------------------------------------------------- U1 词对经 HTTP 生效
test('termPairs 经 HTTP 生效，并与词典改动共存（第零遍先占位，同一处不被二次改）', async () => {
  const { data } = await transcribe({ termPairs: [{ from: '一叶枪', to: '移液枪' }] });
  assert.equal(data.ok, true);
  // 用户词对改了「一叶枪」，词典仍然改了「D五一七」→ 房间号
  assert.ok(String(data.text).includes('移液枪'), `词对没生效：${data.text}`);
  assert.ok(String(data.text).includes('D517'), `词典改动被顺手带丢了：${data.text}`);
  const via = (data.corrections as Array<{ from: string; via: string }>).map((c) => `${c.from}:${c.via}`);
  assert.ok(via.includes('一叶枪:user'), `词对必须标 via=user：${JSON.stringify(via)}`);
  assert.ok(via.some((x) => x.startsWith('D五一七:')), `词典通道照旧工作：${JSON.stringify(via)}`);
  assert.equal(data.termCorrectSkipped, undefined, '没叫停就不该标 skipped');
});

test('畸形 termPairs 不会被照单全收：单字、相同、非数组一律丢掉', async () => {
  const { data } = await transcribe({
    termPairs: [{ from: '枪', to: '枪头' }, { from: '一叶枪', to: '一叶枪' }, '不是对象', null]
  });
  const userHits = ((data.corrections ?? []) as Array<{ via: string }>).filter((c) => c.via === 'user');
  assert.deepEqual(userHits, [], `脏数据不该产生任何 user 改动：${JSON.stringify(userHits)}`);
  assert.notEqual(data.text, MISWRITTEN, '词典改动仍应正常发生（证明不是整段报错兜底）');
});

test('叫停只停词典自动改动：skipTermCorrect 时用户登记的词对照样生效', async () => {
  const { data } = await transcribe({ termPairs: [{ from: '一叶枪', to: '移液枪' }], skipTermCorrect: true });
  assert.equal(data.termCorrectSkipped, true);
  assert.ok(String(data.text).includes('移液枪'), `叫停把用户自己的决定也停了：${data.text}`);
  assert.ok(String(data.text).includes('D五一七'), '叫停后房间号不该再被自动改（这是它该停的部分）');
  const via = ((data.corrections ?? []) as Array<{ via: string }>).map((c) => c.via);
  assert.deepEqual([...new Set(via)], ['user'], `只该剩用户那一条：${JSON.stringify(data.corrections)}`);
});

// ---------------------------------------------------------------- U2 常用词经 HTTP 生效
test('偏置关着时（现网默认）extraTerms 不会凭空造出一条 system 消息', async () => {
  const { sent, data } = await transcribe({ extraTerms: ['门禁电源板'] });
  assert.equal(data.bias.context, false, '默认关着就必须报 false');
  assert.equal(data.bias.userKeywordsRegistered, 1, '登记数照实回报');
  assert.equal(data.bias.termsInContext, 0, '没发出去就不许报"在上下文里的词数"');
  assert.equal(systemText(sent), '', '关着时首位 system 消息根本不该存在');
});

test('打开偏置后，用户常用词真的出现在发给模型的上下文里', async () => {
  process.env.ASR_CONTEXT_ENABLED = '1';
  try {
    const { sent, data } = await transcribe({ extraTerms: ['门禁电源板', '投影仪'] });
    const sys = systemText(sent);
    assert.ok(sys.includes('门禁电源板'), `常用词没进上下文：${sys.slice(0, 80)}`);
    assert.equal(data.bias.context, true);
    assert.ok(Number(data.bias.contextChars) > 0);
    // 上下文必须是**纯词表**：官方明确不支持传统系统提示词，混进指令句就是自作主张
    for (const bad of ['请把', '请你', '必须识别', '你是']) {
      assert.ok(!sys.includes(bad), `上下文里出现了指令句片段 ${bad}：${sys.slice(0, 60)}`);
    }
  } finally {
    delete process.env.ASR_CONTEXT_ENABLED;
  }
});

test('叫停时偏置一起停：既不发上下文，也照实说"常用词这次没发"', async () => {
  process.env.ASR_CONTEXT_ENABLED = '1';
  try {
    const { sent, data } = await transcribe({ extraTerms: ['门禁电源板'], skipTermCorrect: true });
    assert.equal(systemText(sent), '', '叫停后不该再发上下文');
    assert.equal(data.bias.context, false);
    assert.equal(data.bias.suppressedByUser, true);
    assert.equal(data.bias.userKeywordsRegistered, 0, '被叫停的词不该算成"已登记进本次请求"');
  } finally {
    delete process.env.ASR_CONTEXT_ENABLED;
  }
});
