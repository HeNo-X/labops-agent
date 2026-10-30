/**
 * 模型分流探针（供 tests/model-chain.test.ts 在独立子进程里调用）
 * ============================================================================
 *  config.ts 会在首次 getConfig() 时缓存整份配置，同一进程内改环境变量不生效；
 *  因此"换个环境再看一遍链"只能靠新进程。本文件只做一件事：把两条链原样打出来。
 *
 *  输出：一行 JSON（最后一行），字段不含密钥本体，只有"有没有 Key"。
 */
export {}; // 让本文件成为模块：顶层 await 只在模块里合法

const { providersForMode, modelPlan, engineForMode, isLlmConfigured } = await import(
  '../../server/llm/router.ts'
);

const slim = (list: ReturnType<typeof providersForMode>) =>
  list.map((p) => ({ name: p.name, model: p.model, baseUrl: p.baseUrl, hasKey: Boolean(p.apiKey) }));

console.log(
  JSON.stringify({
    plan: modelPlan(),
    chat: slim(providersForMode('chat')),
    task: slim(providersForMode('task')),
    engineChat: engineForMode('chat'),
    engineTask: engineForMode('task'),
    configured: { chat: isLlmConfigured('chat'), task: isLlmConfigured('task') }
  })
);
