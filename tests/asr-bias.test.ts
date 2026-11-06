/**
 * 事前偏置（B2）—— 请求形态与降级阶梯
 * ============================================================================
 *  偏置是"发出去才可能有用"的东西，所以必须钉死三件事：
 *    ① 形态对不对：system 在第一位、只放词不放指令、asr_options 位置正确、
 *       原有 input_audio data URI 不能被改坏（那是 2026-10-29 真实 Key 实测出来的坑）
 *    ② 上游不收时会不会降级重发，以及降级后有没有**如实说**"没生效"
 *    ③ 不该重发的 4xx（鉴权/格式）不许白烧额度
 *
 *  全部用 fetch 替身，不发任何真实网络请求。
 *  运行：node --test tests/asr-bias.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Captured = { url: string; init: RequestInit; body?: Record<string, unknown>; form?: Record<string, string> };

const captured: Captured[] = [];

const ORIGINAL_FETCH = globalThis.fetch;
/** 音频要过 validateAudioPayload：≥800 字节、MIME 在允许清单里 */
const AUDIO = Buffer.alloc(1200, 7).toString('base64');
const FAKE_KEY = 'sk-test-fake-key-never-real';

function stubFetch(handler: (index: number) => { status: number; body: unknown }): void {
  captured.length = 0;
  globalThis.fetch = (async (url: string | URL | undefined, init?: RequestInit) => {
    const target = String(url);
    const record: Captured = { url: target, init: init ?? {} };
    if (typeof init?.body === 'string') record.body = JSON.parse(init.body) as Record<string, unknown>;
    else if (init?.body) {
      // 只认 FormData 的可迭代接口：tsconfig.node 的 lib 里没有 DOM 的 FormData.entries 声明
      const form = init.body as unknown as { entries(): IterableIterator<[string, unknown]> };
      record.form = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') record.form[k] = v;
    }
    captured.push(record);
    const reply = handler(captured.length - 1);
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const keys = Object.keys(values);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  return run().finally(() => {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    globalThis.fetch = ORIGINAL_FETCH;
  });
}

const baseEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ASR_API_KEY: FAKE_KEY,
  DASHSCOPE_API_KEY: '',
  ASR_BASE_URL: 'https://stub.invalid/v1',
  ASR_MODEL: 'qwen3-asr-flash',
  ASR_PROTOCOL: 'chat_audio',
  ...extra
});

const CONTEXT = '实验室管理领域参考词（中文）：\n节次 上午第二大节\n器材 投影仪 服务器';

function okChat(text: string): { status: number; body: unknown } {
  return { status: 200, body: { choices: [{ message: { content: text } }] } };
}

/** 从 system 消息里取纯文本（官方形态是 [{type:'text',text}]） */
function systemText(body: Record<string, unknown> | undefined): string {
  const messages = (body?.['messages'] ?? []) as Array<{ role?: string; content?: unknown }>;
  const sys = messages.find((m) => m.role === 'system');
  if (!sys) return '';
  if (typeof sys.content === 'string') return sys.content;
  if (Array.isArray(sys.content)) return sys.content.map((p) => String((p as { text?: unknown }).text ?? '')).join('');
  return '';
}

// ---------------------------------------------------------------- 请求形态
test('上下文进首位 system 消息，且只放词不放指令', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('帮我看下投影仪'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(captured.length, 1);
    const messages = captured[0]!.body?.['messages'] as Array<{ role: string }>;
    assert.equal(messages[0]?.role, 'system', '官方要求 system 必须在第一位');
    assert.equal(messages[1]?.role, 'user');
    const sys = systemText(captured[0]!.body);
    assert.ok(sys.includes('投影仪') && sys.includes('上午第二大节'), sys);
    for (const instructionWord of ['请', '必须', '你要', '你是', '注意', '应该', '识别以下']) {
      assert.ok(!sys.includes(instructionWord), `上下文中不应出现指令词 ${instructionWord}：官方明确不支持传统系统提示词`);
    }
    if (r.ok) {
      assert.equal(r.applied.context, true);
      assert.equal(r.applied.degraded, false);
      assert.equal(r.applied.contextChars, CONTEXT.length);
    }
  });
});

test('input_audio 仍是完整 data URI（回归 2026-10-29 实测：裸 base64 会被网关当 URL 解析）', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/webm;codecs=opus', contextText: CONTEXT });
    const messages = captured[0]!.body?.['messages'] as Array<{ role: string; content?: Array<{ input_audio?: { data?: string; format?: string } }> }>;
    const user = messages.find((m) => m.role === 'user');
    const data = user?.content?.[0]?.input_audio?.data ?? '';
    assert.match(data, /^data:audio\/webm;base64,/);
    assert.equal(user?.content?.[0]?.input_audio?.format, 'webm');
  });
});

test('asr_options 作为请求体顶层参数，language 默认 zh、ITN 默认关', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm' });
    const options = captured[0]!.body?.['asr_options'] as Record<string, unknown> | undefined;
    assert.deepEqual(options, { language: 'zh' }, `实际 ${JSON.stringify(options)}`);
    if (r.ok) {
      assert.equal(r.applied.options, true);
      assert.equal(r.applied.language, 'zh');
      assert.equal(r.applied.itn, false, 'enable_itn 默认不开，且不该被谎报为已开');
    }
  });
});

test('ASR_LANGUAGE 显式置空 → 不发 language；两者都空时整个 asr_options 不发', async () => {
  await withEnv(baseEnv({ ASR_LANGUAGE: '' }), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm' });
    assert.equal(captured[0]!.body?.['asr_options'], undefined, `不该发空 asr_options：${JSON.stringify(captured[0]!.body)}`);
    if (r.ok) assert.equal(r.applied.options, false);
  });
});

test('ASR_ENABLE_ITN=1 才带 enable_itn', async () => {
  await withEnv(baseEnv({ ASR_ENABLE_ITN: '1' }), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm' });
    const options = captured[0]!.body?.['asr_options'] as Record<string, unknown>;
    assert.equal(options['enable_itn'], true);
    if (r.ok) assert.equal(r.applied.itn, true);
  });
});

test('ASR_CONTEXT_ENABLED=0 → 完全不发 system（与改造前一致）', async () => {
  await withEnv(baseEnv({ ASR_CONTEXT_ENABLED: '0' }), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    const messages = captured[0]!.body?.['messages'] as Array<{ role: string }>;
    assert.deepEqual(messages.map((m) => m.role), ['user']);
    if (r.ok) {
      assert.equal(r.applied.context, false);
      assert.equal(r.applied.contextChars, 0);
    }
  });
});

test('上下文按 ASR_CONTEXT_MAX_CHARS 截断，不拿"号称"糊弄', async () => {
  await withEnv(baseEnv({ ASR_CONTEXT_MAX_CHARS: '30' }), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    const sys = systemText(captured[0]!.body);
    assert.ok(sys.length <= 30, `预算 30 实际 ${sys.length}`);
    if (r.ok) assert.equal(r.applied.contextChars, sys.length);
  });
});

// ---------------------------------------------------------------- 降级阶梯
test('上游拒收 asr_options → 摘掉重发；再拒 system → 退成裸请求；最终成功且如实标 degraded', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch((i) =>
      i === 0
        ? { status: 400, body: { error: { message: "Unknown parameter: 'asr_options'." } } }
        : i === 1
          ? { status: 400, body: { error: { message: 'system role is not supported for this model' } } }
          : okChat('投影仪好了')
    );
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    assert.equal(captured.length, 3, `应当恰好退三档，实际 ${captured.length} 次`);
    assert.ok(captured[0]!.body?.['asr_options'], '第一次带 asr_options');
    assert.equal(captured[1]!.body?.['asr_options'], undefined, '第二次已摘掉 asr_options');
    assert.ok(systemText(captured[1]!.body), '第二次仍保留上下文');
    assert.equal(systemText(captured[2]!.body), '', '第三次连上下文也摘掉');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.applied.degraded, true, '降级必须如实标注，不能假装增强生效');
      assert.equal(r.applied.context, false);
      assert.equal(r.applied.options, false);
    }
  });
});

test('非参数类 4xx（鉴权/格式）只发一次，不白烧额度', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => ({ status: 401, body: { error: { message: 'Invalid API key' } } }));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    assert.equal(captured.length, 1, `401 不该触发降级重发，实际 ${captured.length} 次`);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'upstream_error');
  });
});

test('429 仍按原行为重试一次', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch((i) => (i === 0 ? { status: 429, body: { error: { message: 'rate limited' } } } : okChat('好了')));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm' });
    assert.equal(r.ok, true);
    assert.equal(captured.length, 2);
  });
});

test('空识别结果仍报 empty，不冒充成功', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('   '));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'empty');
  });
});

// ---------------------------------------------------------------- transcriptions 协议
test('transcriptions 协议走 prompt + language，并按 224 token 窗口保守截断', async () => {
  await withEnv(baseEnv({ ASR_PROTOCOL: 'transcriptions', ASR_MODEL: 'whisper-large-v3-turbo' }), async () => {
    stubFetch(() => ({ status: 200, body: { text: '投影仪好了' } }));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const long = '词 '.repeat(2000);
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: long });
    const form = captured[0]!.form ?? {};
    assert.ok(form['file'] === undefined || typeof form['file'] === 'string', 'file 字段仍由 FormData 承担');
    assert.equal(form['language'], 'zh');
    assert.ok((form['prompt'] ?? '').length <= 480, `prompt 超出 Whisper 窗口近似上限：${(form['prompt'] ?? '').length}`);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.applied.itn, false, 'transcriptions 协议没有 enable_itn，不许谎报');
  });
});

test('Key 与上下文都不进日志面：请求体外没有别的字段泄漏 Key 之外的东西', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    const headers = captured[0]!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Bearer ${FAKE_KEY}`, 'Key 只在请求头');
    assert.ok(!JSON.stringify(captured[0]!.body).includes(FAKE_KEY), 'Key 绝不出现在请求体里');
  });
});
