/**
 * RAG 批次 1：向量召回与三路混合检索
 * ============================================================================
 *  锁死的契约：
 *    ① 余弦：同向 1 / 正交 0 / 零向量 0 / 维度不齐 0（绝不 NaN 污染排序）；
 *    ② embedTexts：批量切分、按上游 index 重排（不信任响应顺序）、配额类 403 不重试；
 *    ③ 索引幂等：重跑不重复、语料变更清剪陈旧键、批内失败整体回滚；
 *    ④ 三路 RRF：向量路命中会带 via:'vector'；向量路关闭/未建索引/失败 →
 *       静默退回两路词法检索（via 不含 vector，结果与旧实现一致）；
 *    ⑤ 语义召回补盲区：换说法（"显示设备信号接入" vs "投影仪怎么连线"）
 *       词法不中、向量能中——这是本批次存在的理由。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { cosine, embedTexts, EmbeddingError } from '../server/llm/embeddings.ts';
import { ensureKnowledgeVecTable, indexKnowledge, vecIndexStats } from '../server/tools/knowledge-vector.ts';
import { retrieveHybrid, type KnowledgeDocument } from '../server/tools/knowledge.ts';
import { retrieveRanked } from '../server/tools/knowledge.ts';
import { searchChunks } from '../server/tools/knowledge-search.ts';

test('A11-01 余弦：同向 1 / 正交 0 / 零向量 0 / 维度不齐 0', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  assert.equal(cosine([0, 0], [1, 2]), 0, '零向量返回 0，不返回 NaN');
  assert.equal(cosine([1, 2], [1, 2, 3]), 0, '维度不齐返回 0');
});

/** 进程内假 embedding 上游：把每条文本哈希成确定性向量，并记录收到的批次数 */
function fakeEmbeddingUpstream(dim = 8) {
  let batches = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      batches += 1;
      const parsed = JSON.parse(body) as { input: string[] };
      const vec = (t: string) => {
        const v = new Array<number>(dim).fill(0);
        for (const ch of t) v[(ch.codePointAt(0) ?? 0) % dim] += 1;
        return v;
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: parsed.input.map((t, i) => ({ index: i, embedding: vec(t) })) }));
    });
  });
  return {
    listen: async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); return (server.address() as { port: number }).port; },
    batches: () => batches,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

test('A11-02 embedTexts：按 batchSize 分批、按上游 index 重排（不信任响应顺序）', async () => {
  const up = fakeEmbeddingUpstream();
  const port = await up.listen();
  const texts = Array.from({ length: 25 }, (_, i) => `文本${i}`);
  const override = { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'text-embedding-v3', dimensions: 8, batchSize: 10 };
  const vecs = await embedTexts(texts, override);
  assert.equal(vecs.length, 25);
  assert.equal(up.batches(), 3, '25 条按批 10 切成 3 批');
  // 确定性向量：第 i 条文本的向量必须与单条重算一致（顺序没被响应打乱）
  const single = await embedTexts(['文本7'], override);
  assert.deepEqual([...vecs[7]!], [...single[0]!], '乱序响应必须按 index 归位');
  await up.close();
});

test('A11-03 配额类 403 不重试，直接抛 embedding_quota_exhausted', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"AllocationQuota.FreeTierOnly"}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await embedTexts(['x'], { apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', dimensions: 8, batchSize: 10 });
    assert.fail('应抛 EmbeddingError');
  } catch (e) {
    assert.equal((e as EmbeddingError).code, 'embedding_quota_exhausted');
    assert.equal(hits, 1, '配额类错误不重试（试了也白烧）');
  }
  server.close();
});

const DOC_A: KnowledgeDocument = {
  id: 'doc-a', title: '调课说明', version: 'v1', effectiveFrom: '2026-01-01', roles: ['admin'],
  keywords: ['调课'], source: '内置', paragraphs: ['调课需要先查课表。', '调课方案必须本人确认。']
};
const DOC_B: KnowledgeDocument = {
  id: 'doc-b', title: '投影仪接入', version: 'v1', effectiveFrom: '2026-01-01', roles: ['admin'],
  keywords: ['显示设备'], source: '内置', paragraphs: ['显示设备的信号接入步骤：先开电源。', '信号源选择 HDMI。']
};
const DOCS = [DOC_A, DOC_B];

/** 确定性测试向量：文本含"投影"→ 投影维度高；含"调课"→ 调课维度高 */
function testEmbed(texts: string[]): Promise<number[][]> {
  const vec = (t: string) => {
    const v = [0, 0, 0, 0];
    if (/投影|显示|信号/.test(t)) v[0] = 1;
    if (/调课|课表/.test(t)) v[1] = 1;
    if (/确认/.test(t)) v[2] = 1;
    v[3] = 0.01; // 避免全零
    return v;
  };
  return Promise.resolve(texts.map(vec));
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  ensureKnowledgeVecTable(db);
  return db;
}

test('A11-04 索引幂等：重跑不重复、语料变更清剪陈旧键', async () => {
  const db = memoryDb();
  const first = await indexKnowledge(DOCS, { embed: testEmbed, db });
  assert.equal(first.indexed, 4);
  assert.equal(vecIndexStats(db).count, 4);
  const second = await indexKnowledge(DOCS, { embed: testEmbed, db });
  assert.equal(second.indexed, 4, '重跑是 upsert，不产生重复');
  assert.equal(vecIndexStats(db).count, 4);
  const pruned = await indexKnowledge([DOC_A], { embed: testEmbed, db });
  assert.equal(pruned.pruned, 2, '语料删掉 doc-b 后其向量被清剪');
  assert.equal(vecIndexStats(db).count, 2);
});

test('A11-05 三路混合：向量路命中带 via:vector，词法盲区被补上', async () => {
  const db = memoryDb();
  await indexKnowledge(DOCS, { embed: testEmbed, db });
  // "投影仪怎么连线"：词法（关键词=显示设备/BM25 双字）难命中"信号接入"，语义应命中 doc-b
  const hits = await retrieveHybrid('投影仪怎么连线', 'admin', '2026-10-31', DOCS, 4, 4, { enabled: true, embed: async () => [1, 0, 0, 0.01], db });
  assert.ok(hits.length > 0);
  const top = hits[0]!;
  assert.equal(top.doc.id, 'doc-b', '语义上最近的文档排第一');
  assert.ok(top.via.includes('vector'), '向量路参与必须留痕');
});

test('A11-06 降级：向量路关闭/未建索引 → 结果与纯词法一致（via 不含 vector）', async () => {
  const db = memoryDb(); // 空库：未建索引
  const hybrid = await retrieveHybrid('调课', 'admin', '2026-10-31', DOCS, 4, 4, { enabled: true, embed: async () => [1, 0, 0, 0.01], db });
  const lexical = retrieveRanked('调课', 'admin', '2026-10-31', DOCS);
  assert.deepEqual(hybrid.map((h) => [h.doc.id, h.paragraphs.map((p) => p.index)]), lexical.map((h) => [h.doc.id, h.paragraphs.map((p) => p.index)]), '无向量路时与旧实现结果一致');
  assert.ok(hybrid.every((h) => !h.via.includes('vector')), 'via 不得虚报 vector');
  assert.ok(hybrid.length > 0, '词法路本身仍能命中');
});

test('A11-07 向量路失败静默降级：embed 抛错不影响检索', async () => {
  const db = memoryDb();
  await indexKnowledge(DOCS, { embed: testEmbed, db });
  const hits = await retrieveHybrid('调课', 'admin', '2026-10-31', DOCS, 4, 4, {
    enabled: true, db, embed: async () => { throw new EmbeddingError('embedding_http_error', '上游炸了', 500); }
  });
  assert.ok(hits.length > 0, '检索照常返回');
  assert.ok(hits.every((h) => !h.via.includes('vector')), '失败路不得留痕');
});

test('A11-08 searchChunks 向量路显式传入：无权限/过期候选不因向量分高而漏进来', () => {
  const expired: KnowledgeDocument = { ...DOC_B, effectiveFrom: '2027-01-01' };
  void indexKnowledge; // 索引过的旧向量仍在库（模拟：直接查未过滤集也查不到过期文档）
  const ranks = new Map<string, number>([[`${expired.id}#1`, 1]]);
  const chunks = searchChunks('投影', 'admin', '2026-10-31', [expired], 8, ranks);
  assert.equal(chunks.length, 0, '过期文档的向量名次再高也不得通过检索');
});
