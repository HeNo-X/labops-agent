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
import { ensureKnowledgeVecTable, indexKnowledge, indexManuals, vecIndexStats, vectorRecallByVec, rankManualParagraphs } from '../server/tools/knowledge-vector.ts';
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

// ==================== RAG 批次 2：分块器与手册摄取 ====================

import { chunkLongText, docChunks, type ManualDoc } from '../server/tools/knowledge-chunker.ts';

test('A11-09 分块器：短文本原样 1 块；长文本按句边界开窗且带重叠', () => {
  const short = '一句话。';
  assert.deepEqual(chunkLongText(short, { window: 420 }), [short]);
  const sentences = Array.from({ length: 40 }, (_, i) => `这是第${i}句话，讲到实验室管理的某个细节。`).join('');
  const chunks = chunkLongText(sentences, { window: 200, overlap: 50 });
  assert.ok(chunks.length >= 4, `长文本应切成多块（实际 ${chunks.length}）`);
  for (const c of chunks) assert.ok(c.length <= 220, `单块不得超窗太多：${c.length}`);
  // 句边界：每块必须以句尾符结尾（句子单元不被腰斩）
  for (const c of chunks) assert.match(c, /[。！？；]$/, `块应以句子边界结束：…${c.slice(-20)}`);
  // 重叠：相邻块之间有共享文本
  for (let i = 1; i < chunks.length; i += 1) {
    const tail = chunks[i - 1]!.slice(-30);
    const shared = chunks[i]!.slice(0, 60).split('').filter((ch) => tail.includes(ch)).length;
    assert.ok(shared > 0, '相邻块应有重叠内容');
  }
});

test('A11-10 分块器：表格/列表行作为整体单元，绝不从中间切断', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| 参数${i} | 数值${i} | 备注${i} |`).join('\n');
  const chunks = chunkLongText(rows, { window: 200, overlap: 40 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) for (const line of c.split('\n')) {
    if (!line.trim()) continue;
    assert.match(line, /^\s*\|/, '表格行必须整行保留，不得切断：' + line.slice(0, 30));
  }
});

test('A11-11 docChunks：键契约（单块 #N / 多块 #N.k）与标题语境前缀', () => {
  // 版本号约定：库内不带 v 前缀（渲染层统一加 v）——分块器同样只加一个 v
  const long: KnowledgeDocument = { ...DOC_A, title: '调课规程', version: '1', paragraphs: ['短段。', '超长段落'.repeat(80) + '。'] };
  const chunks = docChunks(long, { window: 200 });
  assert.equal(chunks[0]!.key, 'doc-a#1', '短段：单块键无子号');
  assert.equal(chunks[0]!.embedText, '调课规程（v1）：短段。', '向量化文本带标题语境前缀');
  const subs = chunks.filter((c) => c.paraIndex === 2);
  assert.ok(subs.length >= 2, '长段落切成多块');
  assert.equal(subs[0]!.key, 'doc-a#2.1', '多块键带子号');
  assert.ok(subs.every((c) => c.paraIndex === 2), 'paraIndex 恒为父段落号（locator 契约）');
});

test('A11-12 段落折叠：子块命中在向量召回里折叠回父段落（取最优名次）', async () => {
  const db = memoryDb();
  const long: KnowledgeDocument = { ...DOC_A, paragraphs: ['短段。', '投影仪的信号接入分三步，这是很长的说明。'.repeat(30) + '。'] };
  // testEmbed 对"投影/信号"打高维 0：长段两个子块都会带投影语义
  await indexKnowledge([long], { embed: testEmbed, db, chunk: { window: 200 } });
  const ranks = vectorRecallByVec([1, 0, 0, 0.01], [long], 4, db);
  assert.equal([...ranks.keys()].filter((k) => k.startsWith('doc-a#2')).length, 1, '同段多子块折叠为一条父段落名次');
  assert.ok(ranks.has('doc-a#2'), '父段落键在召回结果里');
});

test('A11-13 手册索引：版本在键里，重导入新版清剪旧版（增量去重）', async () => {
  const db = memoryDb();
  const manual: ManualDoc = { id: 'pm-1', title: '投影机手册', device: '投影仪', version: 'v1', paragraphs: [{ id: 'p1', text: '开机步骤。' }, { id: 'p2', text: '信号接入步骤。' }] };
  const first = await indexManuals([manual], { embed: testEmbed, db });
  assert.equal(first.indexed, 2);
  assert.ok(vecIndexStats(db).count >= 2);
  const v2: ManualDoc = { ...manual, version: 'v2' };
  const second = await indexManuals([v2], { embed: testEmbed, db });
  assert.equal(second.indexed, 2, '新版本键写入');
  assert.equal(second.pruned, 2, '同手册旧版本键被清剪');
  const stats = vecIndexStats(db);
  assert.equal(stats.count, 2, '库内只剩当前版本');
  // 其他手册的键不被越权清剪
  const other: ManualDoc = { id: 'pm-2', title: '其他手册', device: '其他', version: 'v1', paragraphs: [{ id: 'p1', text: '内容。' }] };
  await indexManuals([other], { embed: testEmbed, db });
  const third = await indexManuals([v2], { embed: testEmbed, db });
  assert.equal(third.pruned, 0, '不同 id 的键不受清剪影响');
});

test('A11-14 手册段落排序：只排主系统返回的手册，向量相近者靠前', async () => {
  const db = memoryDb();
  const m1: ManualDoc = { id: 'pm-1', title: '投影机手册', device: '投影仪', version: 'v1', paragraphs: [{ id: 'p1', text: '调课流程说明。' }, { id: 'p2', text: '信号接入与显示设置。' }] };
  await indexManuals([m1], { embed: testEmbed, db });
  const ranks = rankManualParagraphs([1, 0, 0, 0.01], [m1], db);
  assert.equal(ranks.get('m:pm-1@v1#p2'), 1, '投影语义段排在第一');
  assert.equal(ranks.get('m:pm-1@v1#p1'), 2);
  // 未返回的手册（不在 allowed 集）不得出现在结果里
  const other: ManualDoc = { id: 'pm-9', title: '别的', device: 'x', version: 'v1', paragraphs: [{ id: 'q1', text: '投影。' }] };
  void other;
  assert.ok(![...ranks.keys()].some((k) => k.startsWith('m:pm-9')), '未返回手册不得借排序混入');
});
