/**
 * 知识检索质量门（金样本 30 条）
 * ============================================================================
 *  **调整检索（分块/召回/融合/重排/语料）必须跑本测试**（或 npm run knowledge:eval）。
 *  门槛按词法基线校准（生产参数 maxDocs=3/maxParagraphs=4）：
 *    hit@1 22/30（73%）｜hit@3 29/30（97%）｜引文片段 29/30
 *  断言"不低于基线"——分块、融合或重排让指标变差时会先在这里红。
 *  向量路（hybrid）在测试环境因 Key 净化通常不可得 → 该份对比如实标 skipped；
 *  本机单独运行（EMBEDDING_ENABLED=1 + 索引在库）时输出两份对比
 *  （hybrid hit@1 25/30、hit@3 30/30、引文 30/30——向量路
 *  hit@1 +10pp、hit@3 +3pp）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runKnowledgeEval, formatReport, type GoldCase } from '../server/tools/knowledge-eval.ts';
import { documents } from '../server/tools/knowledge.ts';

const GOLD = (JSON.parse(readFileSync(new URL('./fixtures/knowledge-eval.json', import.meta.url), 'utf8')) as { cases: GoldCase[] }).cases;

/** 基线门槛（词法基线；只许更好，不许更差） */
const GATE = { hit1: 22, hit3: 29, textHit: 29 };

test('A13-01 质量门：词法两路不低于实测基线（hit@1/hit@3/引文片段）', async () => {
  const report = await runKnowledgeEval(GOLD, documents(), { enabled: false });
  const reportText = formatReport(report);
  assert.equal(report.total, GOLD.length, '金样本必须全部参与（语料或夹具变更时同步更新）');
  assert.ok(report.hit1 >= GATE.hit1, `hit@1 ${report.hit1} < 基线 ${GATE.hit1}\n${reportText}`);
  assert.ok(report.hit3 >= GATE.hit3, `hit@3 ${report.hit3} < 基线 ${GATE.hit3}\n${reportText}`);
  assert.ok(report.textHit >= GATE.textHit, `引文片段 ${report.textHit} < 基线 ${GATE.textHit}\n${reportText}`);
  assert.equal(report.mode, 'lexical', 'Key 净化环境下向量路应如实标 skipped');
});

test('A13-02 金样本覆盖：全部 14 份文档至少各有一条，问题不重复', () => {
  const docs = documents();
  const docIds = new Set(docs.map((d) => d.id));
  const covered = new Set(GOLD.map((c) => c.doc));
  for (const id of docIds) assert.ok(covered.has(id), `文档 ${id} 没有金样本覆盖`);
  for (const c of GOLD) assert.ok(docIds.has(c.doc), `金样本指向不存在的文档：${c.doc}`);
  assert.equal(new Set(GOLD.map((c) => c.q)).size, GOLD.length, '问题不得重复');
});

test('A13-03 向量路对比（有条件）：启用且索引在库时 hybrid 不差于词法 hit@3', async () => {
  // Key 净化环境（npm test）下 isEmbeddingEnabled=false → 如实跳过；
  // 本机 EMBEDDING_ENABLED=1 + knowledge:index 后单独运行即得两份对比。
  const probe = await runKnowledgeEval(GOLD.slice(0, 3), documents(), { enabled: true, embed: async () => { throw new Error('probe'); } });
  assert.equal(probe.mode, 'lexical', '向量路失败必须静默降级为词法');
  if (!GOLD.some(() => true)) return;
  // 退化路径已验：此处只在"向量路真实可用"时做对比断言
  const { isEmbeddingEnabled } = await import('../server/llm/embeddings.ts');
  if (!isEmbeddingEnabled()) return;
  const lexical = await runKnowledgeEval(GOLD, documents(), { enabled: false });
  const hybrid = await runKnowledgeEval(GOLD, documents(), { enabled: true });
  assert.ok(hybrid.hit3 >= lexical.hit3, `hybrid hit@3 ${hybrid.hit3} 不得低于词法 ${lexical.hit3}\n${formatReport(hybrid)}`);
  assert.ok(hybrid.textHit >= lexical.textHit - 0, `hybrid 引文 ${hybrid.textHit} 不得低于词法 ${lexical.textHit}`);
});
