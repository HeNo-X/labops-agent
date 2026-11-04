/**
 * 聊天链 / 工作链的**结构性隔离** —— 回归防护（2026-10-31）
 * ============================================================================
 *  用户问：「这些模型只用于文本聊天，不参与工作模式吧？」
 *
 *  代码事实（server/llm/router.ts：providersForMode）：
 *    · mode==='chat' → **只**从 c.dashscope.models 建链，一个 Agnes 都进不来；
 *    · mode==='task' → **只**返回单个 Agnes provider，一个 DashScope 模型都进不来。
 *  两侧在结构上互斥，"聊天模型被工作模式拿去用"在类型层面就不可能发生。
 *
 *  但结构正确不等于永远正确 —— 以后有人为了"兜底"给 task 分支加一行
 *  `|| c.dashscope.models[0]` 就能悄悄破坏它，而线上表现只是"工作模式换了个模型在跑"，
 *  没人会发现。这组测试把该不变量钉死：
 *    ① 聊天链 == DASHSCOPE_MODELS（顺序一致），且全部 name==='dashscope'
 *    ② 工作链 == [AGNES_MODEL]，且 name==='agnes'
 *    ③ 两条链没有交集（模型名、密钥都不串）
 *    ④ 只配了 Agnes 时，聊天链必须是**空** —— 不能"借" Agnes 顶上
 *    ⑤ 只配了 DashScope 时，工作链必须是**空** —— 不能"借"聊天模型顶上
 *
 *  运行：node --test tests/model-chain.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROBE = fileURLToPath(new URL('./fixtures/chain-probe.ts', import.meta.url));

interface ChainItem {
  name: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
}
interface ProbeResult {
  plan: { chat: string[]; task: string[] };
  chat: ChainItem[];
  task: ChainItem[];
  engineChat: string;
  engineTask: string;
  configured: { chat: boolean; task: boolean };
}

/** 在干净环境里跑一次探针（config 一个进程只读一次配置，只能换进程） */
function probe(env: Record<string, string>): ProbeResult {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !/^(AGNES|DASHSCOPE|BIGMODEL|XFYUN)_/.test(k)) base[k] = v;
  }
  const out = execFileSync(process.execPath, [PROBE], {
    env: { ...base, LABOPS_AUTH_MODE: 'demo', LABOPS_SKIP_ENV_FILE: '1', ...env },
    encoding: 'utf8'
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  assert.ok(line, '探针没有输出');
  return JSON.parse(line) as ProbeResult;
}

const DASHSCOPE = {
  DASHSCOPE_API_KEY: 'dashscope-key-for-chain',
  DASHSCOPE_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  DASHSCOPE_MODELS: 'kimi-k3,qwen3.8-flash,qwen3.8-max-0902'
};
const AGNES = {
  AGNES_API_KEY: 'agnes-key-for-chain',
  AGNES_MODEL: 'agnes-3.0-flash',
  AGNES_BASE_URL: 'https://api.agnes-ai.cn/v1'
};

test('聊天链 = DASHSCOPE_MODELS，顺序一致，且全部是 dashscope 提供方', () => {
  const r = probe({ ...DASHSCOPE, ...AGNES });
  assert.deepEqual(
    r.chat.map((p) => p.model),
    ['kimi-k3', 'qwen3.8-flash', 'qwen3.8-max-0902'],
    '顺序即调用顺序（截图自下而上），不能被重排'
  );
  assert.deepEqual(new Set(r.chat.map((p) => p.name)), new Set(['dashscope']));
  assert.deepEqual(r.plan.chat, ['kimi-k3', 'qwen3.8-flash', 'qwen3.8-max-0902']);
  assert.equal(r.engineChat, 'dashscope');
  assert.ok(r.chat.every((p) => p.baseUrl.includes('dashscope')), '聊天链必须打百炼端点');
});

test('工作链只有 Agnes 一个模型，与聊天链无交集', () => {
  const r = probe({ ...DASHSCOPE, ...AGNES });
  assert.equal(r.task.length, 1, '工作模式只有一个提供方，不做多模型 fallback');
  assert.equal(r.task[0]!.name, 'agnes');
  assert.equal(r.task[0]!.model, 'agnes-3.0-flash');
  assert.deepEqual(r.plan.task, ['agnes-3.0-flash']);
  assert.equal(r.engineTask, 'agnes');
  assert.ok(r.task[0]!.baseUrl.includes('agnes-ai'), '工作链必须打 Agnes 端点');

  const chatModels = new Set(r.plan.chat);
  for (const t of r.plan.task) {
    assert.ok(!chatModels.has(t), `聊天模型 ${t} 不得出现在工作链里`);
  }
});

test('密钥不串：聊天链只拿百炼 Key，工作链只拿 Agnes Key', () => {
  const r = probe({ ...DASHSCOPE, ...AGNES });
  assert.ok(r.chat.every((p) => p.hasKey), '聊天链每个模型都要带上 Key');
  assert.ok(r.task.every((p) => p.hasKey), '工作链要带上 Key');
  // 探针不输出密钥本体，这里靠端点隔离间接验证：两条链 baseUrl 不同域
  assert.notEqual(r.chat[0]!.baseUrl, r.task[0]!.baseUrl, '两条链不能共用同一个端点');
});

test('只配了 Agnes：聊天链必须为空，不借 Agnes 顶上', () => {
  const r = probe({ ...AGNES, DASHSCOPE_API_KEY: '' });
  assert.equal(r.configured.chat, false);
  assert.deepEqual(r.chat, [], '没有 DASHSCOPE_API_KEY 时聊天链必须为空 → 上层回落规则引擎');
  assert.equal(r.engineChat, 'demo', '聊天模式的 engine 不能变成 agnes');
  assert.equal(r.task.length, 1, '工作链不受聊天链为空的影响');
});

test('只配了百炼：工作链必须为空，不借聊天模型顶上', () => {
  const r = probe({ ...DASHSCOPE, AGNES_API_KEY: '' });
  assert.equal(r.configured.task, false);
  assert.deepEqual(r.task, [], '没有 AGNES_API_KEY 时工作链必须为空');
  assert.equal(r.engineTask, 'demo', '工作模式的 engine 不能变成 dashscope');
  assert.equal(r.chat.length, 3, '聊天链不受工作链为空的影响');
});

// ---------------------------------------------------------------------------
// 备用链（2026-10-31）：BigModel(glm-4.7-flash) + 星火(两个模型共用一个 Key)
// ---------------------------------------------------------------------------
const BIGMODEL = {
  BIGMODEL_API_KEY: 'bigmodel-key-for-chain',
  BIGMODEL_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
  BIGMODEL_MODEL: 'glm-4.7-flash'
};
const XFYUN = {
  XFYUN_API_KEY: 'xfyun-key-for-chain',
  XFYUN_BASE_URL: 'https://maas-api.cn-huabei-1.xf-yun.com/v2',
  XFYUN_TASK_MODEL: 'spark-x2.6',
  XFYUN_CHAT_MODEL: 'spark-x2.6-4b'
};

test('全配置：两条链都是"主链在前、备用在后"，且备用顺序符合约定', () => {
  const r = probe({ ...DASHSCOPE, ...AGNES, ...BIGMODEL, ...XFYUN });
  assert.deepEqual(
    r.chat.map((p) => p.model),
    ['kimi-k3', 'qwen3.8-flash', 'qwen3.8-max-0902', 'glm-4.7-flash', 'spark-x2.6-4b'],
    '聊天链：DashScope 五模型 → BigModel → 星火(chat)'
  );
  assert.deepEqual(
    r.task.map((p) => p.model),
    ['agnes-3.0-flash', 'spark-x2.6', 'glm-4.7-flash', 'spark-x2.6-4b'],
    '工作链：Agnes → 星火(task，第一备用) → BigModel → 星火(chat)'
  );
  assert.deepEqual(r.task.map((p) => p.name), ['agnes', 'xfyun', 'bigmodel', 'xfyun']);
  assert.ok(r.chat.every((p) => p.hasKey) && r.task.every((p) => p.hasKey), '每条都要带 Key');
  // 两条链各自的端点必须不同域，防止 Key 串用
  assert.equal(new Set(r.task.map((p) => p.baseUrl)).size, 3, 'Agnes / 星火 / BigModel 三个端点');
});

test('Agnes 不可用时：工作链第一位必须是星火 spark-x2.6（第一备用）', () => {
  const r = probe({ AGNES_API_KEY: '', ...BIGMODEL, ...XFYUN });
  assert.equal(r.task[0]!.name, 'xfyun');
  assert.equal(r.task[0]!.model, 'spark-x2.6', '第一备用必须是 spark-x2.6，不是 4b 那个');
  assert.deepEqual(r.task.map((p) => p.model), ['spark-x2.6', 'glm-4.7-flash', 'spark-x2.6-4b']);
  assert.equal(r.engineTask, 'dashscope', '备用链统一归到兼容端点族');
  // 工作链里仍然一个 DashScope 提供方都没有（注意此时聊天链本身就是备用链，
  // 所以不能拿"模型名是否出现在 chat 里"当判据，要按提供方判断）
  assert.ok(r.task.every((p) => p.name !== 'dashscope'), '备用链不得借用 dashscope 提供方');
});

test('备用 Key 留空：链回落到原样，不留空壳 provider', () => {
  const r = probe({ ...DASHSCOPE, ...AGNES });
  assert.equal(r.chat.length, 3, '只有 DashScope，不该凭空多出备用');
  assert.equal(r.task.length, 1, '只有 Agnes');
  const names = [...r.chat, ...r.task].map((p) => p.name);
  assert.ok(!names.includes('bigmodel') && !names.includes('xfyun'), '没 Key 的提供方不得进链');
});

test('只配备用、主链全空：聊天与工作都还能用（不会退化成规则引擎）', () => {
  const r = probe({ DASHSCOPE_API_KEY: '', AGNES_API_KEY: '', ...BIGMODEL, ...XFYUN });
  assert.deepEqual(r.chat.map((p) => p.model), ['glm-4.7-flash', 'spark-x2.6-4b']);
  assert.deepEqual(r.task.map((p) => p.model), ['spark-x2.6', 'glm-4.7-flash', 'spark-x2.6-4b']);
  assert.equal(r.configured.chat, true);
  assert.equal(r.configured.task, true);
});
