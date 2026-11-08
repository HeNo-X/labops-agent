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
const FAKE_KEY = 'test-fake-key-never-real-42';

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
  // 本文件测的是"偏置发出去以后对不对"，所以显式打开产品侧默认关着的那个开关
  ASR_CONTEXT_ENABLED: '1',
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

test('产品默认不发上下文：收益未量化 + 实测到词表回显，就不该替用户打开', async () => {
  await withEnv(baseEnv({ ASR_CONTEXT_ENABLED: undefined }), async () => {
    stubFetch(() => okChat('投影仪好了'));
    const { getAsrConfig, transcribeAudio } = await import('../server/llm/asr.ts');
    assert.equal(getAsrConfig().contextEnabled, false, '默认必须是关');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    const messages = captured[0]!.body?.['messages'] as Array<{ role: string }>;
    assert.deepEqual(messages.map((m) => m.role), ['user'], '没打开就不该有 system 消息');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.applied.context, false);
      assert.equal(r.applied.contextChars, 0);
    }
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

// ---- 上下文偏置的反噬防护（2026-11-06 真实 Key 实测：静音样本下模型把词表原样念回来）
test('模型回显参考词表 → 判未识别，绝不把词表灌进草稿', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat(CONTEXT));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    assert.equal(r.ok, false, `回显必须拦下：${JSON.stringify(r)}`);
    if (!r.ok) {
      assert.equal(r.code, 'empty');
      assert.match(r.message, /参考词表/, '要让人看出是被词表回显拦的，不是"真的没说话"');
    }
  });
});

test('回显防护认标题不认单词：正常句子里出现投影仪/服务器照旧通过', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('投影仪搬到文渊了，服务器要重启'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.equal(r.text, '投影仪搬到文渊了，服务器要重启');
  });
});

test('没发上下文时不启用这条判断（标题本身也可能是用户要说的话）', async () => {
  await withEnv(baseEnv({ ASR_CONTEXT_ENABLED: '0' }), async () => {
    stubFetch(() => okChat(CONTEXT));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT });
    assert.equal(r.ok, true, '本条请求根本没带上下文，不该拿上下文去判回显');
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

// ---------------------------------------------------------------- B4：DashScope 原生协议 + 即时热词
/** 原生协议的响应体（output.choices[].message.content 是 [{text}]） */
function okNative(text: string): { status: number; body: unknown } {
  return { status: 200, body: { output: { choices: [{ message: { content: [{ text }] } }] }, usage: { seconds: 3 } } };
}

const nativeEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> =>
  baseEnv({ ASR_PROTOCOL: 'dashscope_native', ASR_MODEL: 'qwen-audio-3.1-asr-flash', ...extra });

test('原生协议：地址、头、body 形态与 vocabulary 都按官方示例发', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch(() => okNative('投影仪好了'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({
      base64: AUDIO,
      mime: 'audio/wav',
      contextText: CONTEXT,
      hotwords: { 投影仪: 5, 文渊: 5, 服务器: 5 }
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(captured[0]!.url.endsWith('/api/v1/services/aigc/multimodal-generation/generation'), captured[0]!.url);
    const headers = captured[0]!.init.headers as Record<string, string>;
    assert.equal(headers['X-DashScope-SSE'], 'disable', '官方示例带这个头');
    const body = captured[0]!.body!;
    const input = body['input'] as { messages: Array<{ role: string }> };
    assert.equal(input.messages[0]!.role, 'system', '上下文仍须在第一位');
    assert.equal(input.messages[1]!.role, 'user');
    const parameters = body['parameters'] as Record<string, unknown>;
    assert.equal(parameters['format'], 'wav');
    assert.deepEqual(parameters['vocabulary'], { 投影仪: 5, 文渊: 5, 服务器: 5 });
    if (r.ok) {
      assert.equal(r.applied.hotwords, true);
      assert.equal(r.applied.hotwordCount, 3);
      assert.equal(r.protocol, 'dashscope_native');
    }
  });
});

test('原生协议不猜采样率：默认不发 sample_rate，显式配置才发', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/webm' });
    const parameters = (captured[0]!.body!['parameters'] ?? {}) as Record<string, unknown>;
    assert.equal(parameters['sample_rate'], undefined, '我们不做重采样，照抄文档示例的 16000 等于谎报');
  });
  await withEnv(nativeEnv({ ASR_NATIVE_SAMPLE_RATE: '16000' }), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/wav' });
    const parameters = (captured[0]!.body!['parameters'] ?? {}) as Record<string, unknown>;
    assert.equal(parameters['sample_rate'], 16000);
  });
});

test('热词按 ASR_HOTWORDS_MAX 截断、权重夹到 1～5，顺序可复现', async () => {
  await withEnv(nativeEnv({ ASR_HOTWORDS_MAX: '3' }), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({
      base64: AUDIO,
      mime: 'audio/wav',
      hotwords: { 甲: 9, 乙: 4, 丙: 0, 丁: 3, 戊: 5 }
    });
    const vocabulary = ((captured[0]!.body!['parameters'] as Record<string, unknown>)['vocabulary']) as Record<string, number>;
    assert.equal(Object.keys(vocabulary).length, 3, JSON.stringify(vocabulary));
    for (const w of Object.values(vocabulary)) assert.ok(w >= 1 && w <= 5, `权重越界：${JSON.stringify(vocabulary)}`);
    if (r.ok) assert.equal(r.applied.hotwordCount, 3);
  });
});

test('ASR_HOTWORDS=0 时一条热词都不发', async () => {
  await withEnv(nativeEnv({ ASR_HOTWORDS: '0' }), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav', hotwords: { 投影仪: 5 } });
    const parameters = (captured[0]!.body!['parameters'] ?? {}) as Record<string, unknown>;
    assert.equal(parameters['vocabulary'], undefined);
    if (r.ok) assert.equal(r.applied.hotwords, false);
  });
});

test('上游拒收 vocabulary → 先摘热词、保留上下文重发', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch((i) => (i === 0 ? { status: 400, body: { message: "Unknown parameter: 'vocabulary'." } } : okNative('好了')));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav', contextText: CONTEXT, hotwords: { 投影仪: 5 } });
    assert.equal(captured.length, 2);
    const second = (captured[1]!.body!['parameters'] ?? {}) as Record<string, unknown>;
    assert.equal(second['vocabulary'], undefined, '第二次应已摘掉 vocabulary');
    const messages = (captured[1]!.body!['input'] as { messages: Array<{ role: string }> }).messages;
    assert.equal(messages[0]!.role, 'system', '上下文这一步不该跟着丢');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.applied.degraded, true);
      assert.equal(r.applied.hotwords, false);
    }
  });
});

test('原生地址可显式覆盖为 WorkspaceId 形态，不靠猜租户号', async () => {
  await withEnv(nativeEnv({ ASR_NATIVE_BASE_URL: 'https://ws123.cn-beijing.maas.aliyuncs.com/api/v1' }), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/wav' });
    assert.equal(captured[0]!.url, 'https://ws123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  });
});

test('三种 base 写法都收敛到 /api/v1（派生错会得到"看着像对、实际 404"的地址）', async () => {
  const cases: Array<[string, string]> = [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/api/v1'],
    ['https://stub.invalid/v1', 'https://stub.invalid/api/v1'],
    ['https://host.example/api/v1', 'https://host.example/api/v1'],
    ['https://host.example/api/v1/', 'https://host.example/api/v1']
  ];
  for (const [base, want] of cases) {
    await withEnv(nativeEnv({ ASR_BASE_URL: base }), async () => {
      stubFetch(() => okNative('x'));
      const { getAsrConfig } = await import('../server/llm/asr.ts');
      assert.equal(getAsrConfig().nativeBaseUrl, want, `base=${base}`);
    });
  }
});

test('热词表为空时不发送 vocabulary 字段（而不是发一个空对象）', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav', hotwords: {} });
    const parameters = (captured[0]!.body!['parameters'] ?? {}) as Record<string, unknown>;
    assert.equal(parameters['vocabulary'], undefined);
    if (r.ok) assert.equal(r.applied.hotwords, false);
  });
});

// ---- 原生请求形态逐条对着官方《Qwen-ASR API 参考》钉死（这三点写错都是"200 但没结果"的形状）
test('原生协议音频走 content 的 audio 键（不是兼容模式的 input_audio），且仍是完整 data URI', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/wav' });
    const messages = (captured[0]!.body!['input'] as { messages: Array<{ role: string; content?: Array<Record<string, unknown>> }> }).messages;
    const user = messages.find((m) => m.role === 'user');
    const part = (user?.content ?? [])[0] ?? {};
    assert.equal(typeof part['audio'], 'string', `audio 键缺失：${JSON.stringify(user?.content)}`);
    assert.match(String(part['audio']), /^data:audio\/wav;base64,/);
    assert.equal(part['input_audio'], undefined, '原生形态不该出现 input_audio');
    assert.equal(part['type'], undefined, '原生 content 用裸键名，不带 type');
  });
});

test('原生协议 asr_options 在 parameters 里，请求体顶层没有它', async () => {
  await withEnv(nativeEnv({ ASR_ENABLE_ITN: '1' }), async () => {
    stubFetch(() => okNative('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav' });
    const body = captured[0]!.body!;
    assert.equal(body['asr_options'], undefined, '顶层 asr_options 是兼容协议的写法');
    const parameters = body['parameters'] as Record<string, unknown>;
    assert.deepEqual(parameters['asr_options'], { language: 'zh', enable_itn: true }, JSON.stringify(parameters));
    if (r.ok) {
      assert.equal(r.applied.options, true);
      assert.equal(r.applied.itn, true);
    }
  });
});

test('上游拒收 format → 只摘 format，热词与上下文都留着（format 不在文档参数表里，必须可摘）', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch((i) => (i === 0 ? { status: 400, body: { message: "Unknown parameter: 'format'." } } : okNative('好了')));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav', contextText: CONTEXT, hotwords: { 投影仪: 4 } });
    assert.equal(captured.length, 2);
    const first = captured[0]!.body!['parameters'] as Record<string, unknown>;
    const second = captured[1]!.body!['parameters'] as Record<string, unknown>;
    assert.equal(first['format'], 'wav');
    assert.equal(second['format'], undefined, '第二次应已摘掉 format');
    assert.deepEqual(second['vocabulary'], { 投影仪: 4 }, '这一步不该跟着丢热词');
    assert.ok(second['asr_options'], '这一步也不该跟着丢 asr_options');
    assert.equal(second['sample_rate'], undefined, '没发 format 时单发 sample_rate 没有意义');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.applied.degraded, true);
      assert.equal(r.applied.format, false, '摘掉了就必须说没发');
      assert.equal(r.applied.hotwords, true);
    }
  });
});

test('摘参数一次只摘一个，且没开的开关不占档位：三次形态必须各不相同', async () => {
  await withEnv(nativeEnv({ ASR_HOTWORDS: '0', ASR_CONTEXT_ENABLED: '0' }), async () => {
    stubFetch(() => ({ status: 400, body: { message: "Unsupported parameter: 'asr_options'." } }));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav' });
    assert.equal(r.ok, false);
    // 全开档（format+options）→ 摘 options（只剩 format）→ 裸请求；vocabulary/context 两档本就为空，不该出现
    const shapes = captured.map((c) => JSON.stringify(Object.keys((c.body?.['parameters'] ?? {}) as object).sort()));
    assert.equal(new Set(shapes).size, shapes.length, `形态重复：${shapes.join(' / ')}`);
    assert.equal(captured.length, 3, `期望 3 档，实际 ${captured.length}：${shapes.join(' / ')}`);
  });
});

test('原生 usage 按官方字段解析：input_tokens_details + seconds，没有 prompt_tokens 也不硬凑', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        output: { choices: [{ message: { content: [{ text: '投影仪好了' }] } }] },
        usage: { input_tokens_details: { text_tokens: 210 }, output_tokens_details: { text_tokens: 6 }, seconds: 4 }
      }
    }));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav', contextText: CONTEXT });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.usage.textTokens, 210, JSON.stringify(r.usage));
      assert.equal(r.usage.seconds, 4);
      assert.equal(r.usage.promptTokens, undefined, '官方原生没有这个字段，不许拿别的数冒充');
    }
  });
});

test('原生协议同样拦词表回显（实测两种协议都会犯这个毛病）', async () => {
  await withEnv(nativeEnv(), async () => {
    stubFetch(() => okNative(CONTEXT));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/wav', contextText: CONTEXT });
    assert.equal(r.ok, false, JSON.stringify(r));
    if (!r.ok) assert.match(r.message, /参考词表/);
  });
});

test('超长热词不进 vocabulary（官方：非 ASCII ≤15 字符、纯 ASCII ≤7 段），短词一个不因此丢失', async () => {
  await withEnv(nativeEnv(), async () => {
    const { loadGlossaryData, hotwordVocabulary } = await import('../server/llm/asr-glossary.ts');
    const terms = loadGlossaryData().terms;
    const long = [...terms.slice(0, 3), { ...terms[0]!, canonical: '这是一条长得超出官方十五个字符限制的热词用来验证过滤' }];
    const table = hotwordVocabulary(long, 500);
    assert.equal(Object.keys(table).length, 3, JSON.stringify(table));
    for (const word of Object.keys(table)) assert.ok([...word].length <= 15, `超出长度限制：${word}`);
    // 真表里确实都合规：否则这条过滤就是为不存在的形状写的
    const real = hotwordVocabulary(terms, 500);
    assert.equal(Object.keys(real).length, terms.length, `真表有条目被过滤掉：${terms.length - Object.keys(real).length} 条`);
  });
});

test('非原生协议绝不声称发了热词（chat_audio 的 applied.hotwords 必须为 false）', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    const r = await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', hotwords: { 投影仪: 5 } } as never);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.applied.hotwords, false);
      assert.equal(r.applied.hotwordCount, 0);
    }
    assert.ok(!JSON.stringify(captured[0]!.body).includes('vocabulary'), '兼容协议 body 里不该出现 vocabulary');
  });
});

test('未知 ASR_PROTOCOL 值仍按 chat_audio 走，不会掉进原生分支', async () => {
  await withEnv(baseEnv({ ASR_PROTOCOL: 'typo-value' }), async () => {
    stubFetch(() => okChat('x'));
    const { getAsrConfig, transcribeAudio } = await import('../server/llm/asr.ts');
    assert.equal(getAsrConfig().protocol, 'chat_audio');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/webm' });
    assert.ok(captured[0]!.url.endsWith('/chat/completions'));
  });
});

test('Key 只在请求头：上下文与热词都不含密钥，请求体里也不该出现密钥', async () => {
  await withEnv(baseEnv(), async () => {
    stubFetch(() => okChat('x'));
    const { transcribeAudio } = await import('../server/llm/asr.ts');
    await transcribeAudio({ base64: AUDIO, mime: 'audio/webm', contextText: CONTEXT, hotwords: { 投影仪: 5 } });
    const headers = captured[0]!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Bearer ${FAKE_KEY}`, 'Key 只在请求头');
    assert.ok(!JSON.stringify(captured[0]!.body).includes(FAKE_KEY), 'Key 绝不出现在请求体里');
  });
});
