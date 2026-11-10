/**
 * 批次2 端到端验证：答案生成权回交（ANSWER_GENERATION=model 显式开启——默认 render，核对层实体校验就绪前不开）
 * ============================================================================
 *  用假 agnes SSE 服务驱动真工具链（query_knowledge 离线可跑）：
 *    · T1 模型终稿忠实（无越界数字）→ 采纳模型话术，不用渲染模板；
 *    · T2 模型终稿出现越界数字（999/500）→ 核对层打回一次（禁工具重写）→ 采纳重写稿；
 *    · T3 重写仍越界 → 降级渲染稿并如实标注「未通过数字核对」。
 *  假服务按「最后一条用户消息」选择场景脚本；按 body.tools 是否存在区分
 *  「首轮（带工具，第 1 次回 tool_calls、第 2 次回该场景的终稿文本）」与
 *  「核对重写轮（禁工具）」。
 *  ⚠️ stub 必须 unref()：否则 node --test 的进程永远等不到退出。
 */
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) { if (s.startsWith('@shared/')) return next(new URL('../shared/' + s.slice(8) + '.ts', import.meta.url).href, c); return next(s, c); } });
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.LABOPS_AUTH_MODE = 'demo';
for (const k of ['AGNES_API_KEY', 'DASHSCOPE_API_KEY', 'VISION_API_KEY']) delete process.env[k];
process.env.LABOPS_SKIP_ENV_FILE = '1';
process.env.ANSWER_GENERATION = 'model';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-batch2-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'agent.sqlite');

const sse = (chunks: Array<Record<string, unknown>>): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const textChunks = (text: string): Array<Record<string, unknown>> => [
  { choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }
];
const toolCallChunks = (args: Record<string, unknown>): Array<Record<string, unknown>> => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'query_knowledge', arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
];

const FAITHFUL = '根据知识库：一学年分为两个学期，每个学期含 20 个教学周，以校历为准。';
const HALLUCINATED = '一学期要修满 999 学分，并缴纳 500 元手续费。';
const CORRECTED = '根据知识库：一学年两个学期，每学期 20 个教学周，以校历为准，未提供学分或费用要求。';

/** 场景脚本：final=第 2 次带工具请求返回的「模型终稿」；retry=禁工具重写轮返回的文本 */
const SCRIPTS: Record<string, { final: string; retry: string }> = {
  faithful: { final: FAITHFUL, retry: CORRECTED },
  hallucinated: { final: HALLUCINATED, retry: CORRECTED },
  stillbad: { final: HALLUCINATED, retry: HALLUCINATED }
};
let toolsReqCount = 0;
const toolsReqPerKey: Record<string, number> = {};
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body) as { tools?: unknown[]; messages: Array<{ role: string; content: string }> };
    const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const key = lastUser.includes('stillbad') ? 'stillbad' : lastUser.includes('hallucinated') ? 'hallucinated' : 'faithful';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (Array.isArray(parsed.tools) && parsed.tools.length) {
      toolsReqCount += 1;
      toolsReqPerKey[key] = (toolsReqPerKey[key] ?? 0) + 1;
      // 第 1 次带工具请求 → tool_calls（模型选工具）；第 2 次 → 该场景的模型终稿文本
      res.end(sse(toolsReqPerKey[key] === 1 ? toolCallChunks({ query: '学期 教学周' }) : textChunks(SCRIPTS[key].final)));
      return;
    }
    res.end(sse(textChunks(SCRIPTS[key].retry)));
  });
});
const stubPort = await new Promise<number>((r) => {
  const s = stub.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port));
});
stub.unref();
// 假 agnes 服务接入模型链：AGNES 主模型 = stub（批次2 只改答案组装，链路语义不变）
process.env.AGNES_BASE_URL = `http://127.0.0.1:${stubPort}`;
process.env.AGNES_API_KEY = 'stub-key';
process.env.AGNES_MODEL = 'stub-model';

const { runAgent } = await import('../server/agent/run.ts');
const actor = { id: 'batch2-owner', role: 'admin' as const, label: '批2' };

async function run(q: string, s: string) {
  const key = q.includes('stillbad') ? 'stillbad' : q.includes('hallucinated') ? 'hallucinated' : 'faithful';
  toolsReqPerKey[key] = 0;
  const ev = [];
  for await (const e of runAgent({ question: q, sessionId: s, actor, mode: 'task' })) ev.push(e);
  const done = ev.find((e) => e.type === 'run_completed')?.payload as { answer: string } | undefined;
  const failed = ev.find((e) => e.type === 'run_failed')?.payload as { code: string; message: string } | undefined;
  fs.writeFileSync(path.join(os.tmpdir(), 'b2ev-' + s + '.json'), JSON.stringify(ev.map((e) => ({ type: e.type, payload: (e.payload ?? {}) as object })), null, 1));
  const toolCalls = ev.filter((e) => e.type === 'tool_started').map((e) => (e.payload as { tool?: string }).tool);
  return { answer: done?.answer ?? `FAILED:${failed?.code}:${failed?.message}`, toolCalls, toolsReqCount: toolsReqPerKey[key] ?? 0 };
}

test('T1 模型终稿忠实：采纳模型话术（不是渲染模板）', async () => {
  const r1 = await run('学校的学期与教学周是怎么规定的', 'b2-t1');
  console.log('B2DBG:', JSON.stringify({ answer: r1.answer.slice(0, 120), toolCalls: r1.toolCalls, toolsReqCount: r1.toolsReqCount }));
  const { answer, toolCalls, toolsReqCount } = r1;
  assert.deepEqual(toolCalls, ['query_knowledge'], '工具链路真实执行');
  assert.equal(toolsReqCount, 2, '首轮工具调用 + 第二轮模型终稿');
  assert.equal(answer, FAITHFUL, `终稿=模型话术：${answer.slice(0, 80)}`);
  assert.doesNotMatch(answer, /未通过数字核对/);
});

test('T2 模型终稿越界（999/500）：打回重写一次，采纳重写稿', async () => {
  const { answer, toolCalls } = await run('学校的学期与教学周是怎么规定的 hallucinated', 'b2-t2');
  assert.deepEqual(toolCalls, ['query_knowledge']);
  if (/999|500 元/.test(answer)) console.log('T2DBG:', JSON.stringify(answer.slice(0, 200)));
  assert.doesNotMatch(answer, /999|500 元/, '越界数字必须被打回清除');
  assert.match(answer, /知识库/, '重写稿仍是模型话术');
  assert.doesNotMatch(answer, /未通过数字核对/, '重写通过则不降级');
});

test('T3 重写仍越界：降级渲染稿并如实标注', async () => {
  const { answer, toolCalls } = await run('学校的学期与教学周是怎么规定的 stillbad', 'b2-t3');
  assert.deepEqual(toolCalls, ['query_knowledge']);
  if (!/未通过数字核对/.test(answer)) console.log('T3DBG:', JSON.stringify(answer.slice(0, 200)));
  assert.match(answer, /未通过数字核对/, '必须如实标注降级');
  assert.doesNotMatch(answer, /999 学分/, '越界数字不得进入最终答案');
  assert.ok(answer.length > 20, '降级稿是渲染器产出（含依据说明）');
});
