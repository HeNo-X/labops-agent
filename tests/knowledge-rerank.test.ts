/**
 * LLM 重排 + 引用脚注
 * ============================================================================
 *  锁死的契约：
 *    ① 重排缺省关（RERANK_LLM）；开启且模型给出合法 JSON → 按分数重排；
 *    ② 响应不合法（坏 JSON/越界编号/非 JSON）→ **静默回原序**，绝不抛给用户；
 *    ③ 模型链失败 → 静默回原序；
 *    ④ 重排只动顺序，不增删内容（段落集合与文本逐字不变）；
 *    ⑤ 渲染层：知识答案是 [n] 引用脚注列表（编号=最终顺序），加粗标题+§定位。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerankHits, parseScores } from '../server/tools/knowledge-rerank.ts';
import { renderDemoAnswer } from '../server/agent/demo-engine.ts';
import type { RankedHit } from '../server/tools/knowledge.ts';
import type { KnowledgeResult } from '../shared/types.ts';
import type { AgnesStreamEvent } from '../server/llm/agnes.ts';

const HIT_A: RankedHit = {
  doc: { id: 'doc-a', title: '调课规程', version: '1', effectiveFrom: '2026-01-01', roles: ['admin'], keywords: [], source: '内置', paragraphs: [] },
  paragraphs: [{ index: 2, text: '调课方案必须本人确认。' }],
  via: ['keyword'], score: 0.02
};
const HIT_B: RankedHit = {
  doc: { id: 'doc-b', title: '投影仪接入', version: '1', effectiveFrom: '2026-01-01', roles: ['admin'], keywords: [], source: '内置', paragraphs: [] },
  paragraphs: [{ index: 1, text: '显示设备的信号接入步骤：先开电源。' }],
  via: ['vector', 'bm25'], score: 0.03
};

/** 模型链替身：按脚本吐文本事件 */
function fakeChat(script: string) {
  return async function* (): AsyncGenerator<AgnesStreamEvent> {
    yield { type: 'text', text: script } as AgnesStreamEvent;
  };
}

test('A12-01 合法 JSON：按分数重排（高分段落所属文档提前）', async () => {
  const chat = fakeChat('{"scores":[{"i":1,"s":2},{"i":2,"s":9}]}');
  const out = await rerankHits('投影仪怎么连线', [HIT_A, HIT_B], 'chat', undefined, { enabled: true, chat });
  assert.equal(out[0]!.doc.id, 'doc-b', '段落 [2]（投影）得 9 分 → doc-b 排第一');
  assert.equal(out[0]!.paragraphs[0]!.text, '显示设备的信号接入步骤：先开电源。');
});

test('A12-02 坏 JSON / 非纯 JSON / 越界编号：静默回原序，不抛错', async () => {
  for (const script of ['我觉得都不错', '```json\n{"scores":[{"i":1,"s":5}]}\n```', '{"scores":[{"i":99,"s":1}]}', '{"scores":"好"}']) {
    const out = await rerankHits('q', [HIT_A, HIT_B], 'chat', undefined, { enabled: true, chat: fakeChat(script) });
    assert.deepEqual(out.map((h) => h.doc.id), ['doc-a', 'doc-b'], `脚本「${script.slice(0, 20)}」应回原序`);
  }
});

test('A12-03 模型链抛错：静默回原序', async () => {
  const chat = async function* (): AsyncGenerator<AgnesStreamEvent> { throw new Error('quota dead'); };
  const out = await rerankHits('q', [HIT_A, HIT_B], 'chat', undefined, { enabled: true, chat });
  assert.deepEqual(out.map((h) => h.doc.id), ['doc-a', 'doc-b']);
});

test('A12-04 缺省关 / 单结果：完全不动', async () => {
  const out1 = await rerankHits('q', [HIT_A, HIT_B], 'chat', undefined, { enabled: false, chat: fakeChat('{"scores":[{"i":1,"s":0},{"i":2,"s":10}]}') });
  assert.deepEqual(out1.map((h) => h.doc.id), ['doc-a', 'doc-b'], '缺省关时即使脚本想重排也不动');
  const out2 = await rerankHits('q', [HIT_A], 'chat', undefined, { enabled: true, chat: fakeChat('{"scores":[{"i":1,"s":0}]}') });
  assert.deepEqual(out2.map((h) => h.doc.id), ['doc-a'], '单结果无重排意义');
});

test('A12-05 parseScores：截取首个 JSON、夹紧分数到 0-10、非法编号拒绝', () => {
  const ok = parseScores('前置文字 {"scores":[{"i":1,"s":12},{"i":2,"s":-3}]} 后置', 2);
  assert.ok(ok);
  assert.equal(ok.get(1), 10, '分数夹紧到 10');
  assert.equal(ok.get(2), 0, '负分夹紧到 0');
  assert.equal(parseScores('{"scores":[{"i":5,"s":1}]}', 2), null, '越界编号整包拒绝（不部分采信）');
  assert.equal(parseScores('没有 JSON', 2), null);
});

test('A12-06 渲染：知识答案是 [n] 引用脚注列表（编号=最终顺序，加粗+§定位）', () => {
  const result: KnowledgeResult = {
    summary: '检索到 2 份当前有效的系统操作说明。',
    scope: '本库仅含当前软件操作说明。',
    hits: [
      { id: 'doc-b', title: '投影仪接入', version: '1', effectiveFrom: '2026-01-01', source: '内置', url: '/api/knowledge/doc-b', paragraphs: [{ locator: '§1', text: '显示设备的信号接入步骤：先开电源。' }] },
      { id: 'doc-a', title: '调课规程', version: '1', effectiveFrom: '2026-01-01', source: '内置', url: '/api/knowledge/doc-a', paragraphs: [{ locator: '§2', text: '调课方案必须本人确认。' }] }
    ]
  };
  const answer = renderDemoAnswer({ kind: 'knowledge', payload: result }, { dateWasDefaulted: false, periodFiltered: false });
  const n1 = answer.indexOf('[1]');
  const n2 = answer.indexOf('[2]');
  assert.ok(n1 >= 0 && n2 > n1, '编号按最终顺序递增');
  assert.match(answer, /\*\*\[1\] 投影仪接入（v1）· §1\*\*：显示设备的信号接入步骤/, '[n] 加粗标题+§定位+引文一体');
  assert.match(answer, /\*\*\[2\] 调课规程（v1）· §2\*\*：调课方案必须本人确认/);
  assert.match(answer, /本库仅含当前软件操作说明/, '能力边界（scope）保留');
  assert.ok(!answer.includes('没有可引用的段落'));
});

test('A12-07 渲染：零命中时如实说明，不编引用', () => {
  const result: KnowledgeResult = { summary: '知识库未命中有效依据。', scope: '本库仅含当前软件操作说明。', hits: [] };
  const answer = renderDemoAnswer({ kind: 'knowledge', payload: result }, { dateWasDefaulted: false, periodFiltered: false });
  assert.match(answer, /没有可引用的段落/);
  assert.ok(!/\[1\]/.test(answer));
});
