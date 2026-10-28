/**
 * 多模态证据理解验收（WS1.1）
 * ============================================================================
 *  这一组测试锁的是本项目最容易"名不副实"的一件事：照片到底有没有进模型。
 *  以前它只做到"上传并登记编号"，模型从未看过图像内容 —— 若改成"看起来支持了"
 *  但实际没入模，比不做更糟。所以第一条断言就是**请求体里必须有 image_url**。
 *
 *  同时锁死三条纪律：
 *   · 视觉未配置 / 未连接原系统时如实说拿不到，不伪造观察；
 *   · 结果标注"非人工验收"，且不推进任何业务状态；
 *   · VISION_BASE_URL 可配 ⇒ 必须挡掉非 HTTPS 出口（否则是带 Key 的 SSRF）。
 *
 *  运行：node --test tests/multimodal-evidence.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-vision-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'agent.sqlite');
process.env.AGNES_API_KEY = '';
process.env.LABOPS_AUTH_MODE = 'demo';
// 真 Key 一律不用：只指向本机替身
process.env.VISION_API_KEY = 'test-vision-key-never-leaves-localhost';

interface Captured {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}
const captured: Captured[] = [];
/** 由测试逐个塞入；取完即消费，保证每个用例拿到自己那份剧本 */
let replies: Array<{ status?: number; json?: unknown; text?: string }> = [];

const visionSrv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    captured.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers });
    const next = replies.shift() ?? { json: { choices: [{ message: { content: '{}' } }] } };
    res.writeHead(next.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(next.text ?? JSON.stringify(next.json ?? {}));
  });
});
await new Promise<void>((r) => visionSrv.listen(0, '127.0.0.1', r));
const visionPort = (visionSrv.address() as { port: number }).port;
process.env.VISION_BASE_URL = `http://127.0.0.1:${visionPort}/v1`;

const { analyzeImages, isVisionConfigured, assertSafeEndpoint } = await import('../server/llm/vision.ts');
const { runAnalyzeEvidenceImage } = await import('../server/tools/analyze-evidence-image.ts');

// 1×1 的合法 PNG，够小且签名真实
/**
 * 断言抛错形状。VisionError 经动态 import 只是值不是类型，
 * 且跨模块 instanceof 在替身场景下不如直接查 code 稳定。
 */
function expectVisionError(code: string, retryable?: boolean) {
  return (e: unknown): boolean => {
    const err = e as { name?: string; code?: string; retryable?: boolean };
    assert.equal(err.name, 'VisionError', `应抛 VisionError，实际 ${String(err.name)}：${String((e as Error).message)}`);
    assert.equal(err.code, code);
    if (retryable !== undefined) assert.equal(err.retryable, retryable);
    return true;
  };
}

/** 从 ToolExecution 联合里取失败分支的 code（ok:false 才有） */
function failureCode(r: Awaited<ReturnType<typeof runAnalyzeEvidenceImage>>): string {
  assert.equal(r.ok, false, '本用例期望失败结果');
  return (r as { code: string }).code;
}
// 1×1 的合法 PNG，够小且签名真实
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const observationJson = {
  deviceType: '投影仪',
  visibleSymptoms: ['镜头罩有灰尘堆积', '机身指示灯不亮'],
  nameplateText: 'EP-8270',
  severityGuess: 'moderate',
  confidence: 0.62,
  whatNotVisible: ['看不到电源线连接状态', '看不到投影画面']
};

after(() => {
  visionSrv.close();
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    /* Windows 下可能被占用，泄漏临时目录不影响结论 */
  }
});

test('照片真的进入模型：请求体含 image_url data URL，且带 Authorization', async () => {
  assert.equal(isVisionConfigured(), true);
  captured.length = 0;
  replies = [{ json: { choices: [{ message: { content: JSON.stringify(observationJson) } }] } }];
  const out = await analyzeImages([{ mimeType: 'image/png', dataBase64: PNG_1PX }], '指示灯状态');
  assert.equal(captured.length, 1, '应当恰好发起一次视觉调用');
  const body = captured[0]!.body;
  const messages = body['messages'] as Array<{ role: string; content: unknown }>;
  const userContent = messages.find((m) => m.role === 'user')!.content as Array<Record<string, unknown>>;
  assert.ok(
    Array.isArray(userContent) && userContent.some((p) => (p['type'] as string) === 'image_url'),
    '用户消息必须包含 image_url 内容块，否则图没有入模'
  );
  const imageUrl = userContent.find((p) => p['type'] === 'image_url')!['image_url'] as { url: string };
  assert.match(imageUrl.url, /^data:image\/png;base64,/, '应为内联 data URL，不回源外链');
  assert.ok(imageUrl.url.includes(PNG_1PX.slice(0, 24)), '图片字节应原样送达');
  assert.match(String(captured[0]!.headers.authorization ?? ''), /^Bearer test-vision-key/, 'Key 只走服务端请求头');
  assert.equal(body['model'], 'qwen-vl-max-latest');
  assert.equal(out.observation.deviceType, '投影仪');
});

test('结构化归一：越界置信度与非法严重度被收敛，缺字段回落 unknown/未识别', async () => {
  captured.length = 0;
  replies = [{ json: { choices: [{ message: { content: JSON.stringify({ confidence: 9, severityGuess: 'catastrophic' }) } }] } }];
  const out = await analyzeImages([{ mimeType: 'image/jpeg', dataBase64: '/9j/4AAQSkZJRg==' }], '');
  assert.equal(out.observation.confidence, 1, '置信度必须夹在 0—1');
  assert.equal(out.observation.severityGuess, 'unknown', '非法严重度不得原样透出');
  assert.equal(out.observation.nameplateText, '未识别', '铭牌缺失时明说未识别，不留空冒充"没有铭牌"');
  assert.deepEqual(out.observation.visibleSymptoms, []);
});

test('模型返回非 JSON 时报错而非硬编一份观察', async () => {
  replies = [{ json: { choices: [{ message: { content: '抱歉，我无法分析这张图片。' } }] } }];
  await assert.rejects(
    () => analyzeImages([{ mimeType: 'image/png', dataBase64: PNG_1PX }], ''),
    expectVisionError('vision_bad_json')
  );
});

test('上游 5xx 归类为可重试错误，4xx 不重试', async () => {
  replies = [{ status: 503, json: { error: 'busy' } }];
  await assert.rejects(
    () => analyzeImages([{ mimeType: 'image/png', dataBase64: PNG_1PX }], ''),
    expectVisionError('vision_upstream', true)
  );
  replies = [{ status: 401, json: { error: 'bad key' } }];
  await assert.rejects(
    () => analyzeImages([{ mimeType: 'image/png', dataBase64: PNG_1PX }], ''),
    expectVisionError('vision_upstream', false)
  );
});

test('未配置视觉 Key：抛错而非伪造一份观察', async () => {
  await assert.rejects(
    () => analyzeImages([{ mimeType: 'image/png', dataBase64: PNG_1PX }], '', undefined, { apiKey: '' }),
    expectVisionError('vision_not_configured', false)
  );
});

test('SSRF 闸门：非 HTTPS 且非回环的地址一律拒绝（Key 不能往外发）', async () => {
  assert.throws(() => assertSafeEndpoint(new URL('http://evil.example.com/v1')), expectVisionError('vision_endpoint_unsafe'));
  assert.throws(() => assertSafeEndpoint(new URL('http://169.254.169.254/latest/meta-data/')), expectVisionError('vision_endpoint_unsafe'));
  assert.throws(() => assertSafeEndpoint(new URL('https://target.example.com/v1?token=x')), expectVisionError('vision_endpoint_unsafe'));
  assert.throws(() => assertSafeEndpoint(new URL('https://user:pw@target.example.com/v1')), expectVisionError('vision_endpoint_unsafe'));
  assertSafeEndpoint(new URL('https://dashscope.aliyuncs.com/compatible-mode/v1')); // 正规 HTTPS 出口放行
  assertSafeEndpoint(new URL('http://127.0.0.1:9999/v1')); // 本地回环例外（本测试替身即走此路）
});

test('未连接原系统：工具如实说取不到照片，不声称分析过', async () => {
  const r = await runAnalyzeEvidenceImage(
    { attachmentIds: ['attachment-00000000-0000-4000-8000-000000000000'] },
    { dataset: {} as never, now: { date: '2026-10-29' } as never }
  );
  assert.equal(r.ok, false, '未连接原系统时不得声称分析过照片');
  assert.equal(failureCode(r), 'business_not_connected');
  assert.match(r.summary, /未连接|取不回/);
});

test('照片编号格式非法：直接拒绝，不去打上游', async () => {
  captured.length = 0;
  const bad = await runAnalyzeEvidenceImage({ attachmentIds: ['../../etc/passwd'] }, { dataset: {} as never, now: { date: '2026-10-29' } as never });
  assert.equal(bad.ok, false);
  assert.equal(failureCode(bad), 'attachment_ids_required');
  const empty = await runAnalyzeEvidenceImage({ attachmentIds: [] }, { dataset: {} as never, now: { date: '2026-10-29' } as never });
  assert.equal(failureCode(empty), 'attachment_ids_required');
  assert.equal(captured.length, 0, '非法入参不应产生任何模型调用');
});
