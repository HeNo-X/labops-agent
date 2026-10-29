/**
 * 知识检索验收（WS1.2 / WS1.3）
 * ============================================================================
 *  锁三件事，都是"RAG 名不副实"最容易翻车的地方：
 *   ① 中文短查询必须能命中（两字词是 unicode61 的死角）；
 *   ② 权限与生效日期是**打分之前**的硬前置，不能靠分数挤进来；
 *   ③ 语料外问题必须返回空 —— 宁可说"没有依据"，不可凑一段相关度最高的废话。
 *
 *  运行：node --test tests/knowledge-retrieval.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cjkBigrams, searchChunks, explainRecall, resetIndexForTests } from '../server/tools/knowledge-search.ts';
import { documents, retrieveRanked } from '../server/tools/knowledge.ts';

const docs = documents();

test('CJK 双字切分：两字词成为可检索单元，拉丁词不被切碎', () => {
  const t = cjkBigrams('指定日期调课，支持 AES-256 加密');
  assert.ok(t.split(' ').includes('调课'), '两字中文词必须独立成 token');
  assert.ok(t.split(' ').includes('指定'), '相邻双字应生成');
  assert.ok(t.split(' ').includes('aes'), '拉丁词保持完整');
  assert.ok(!t.split(' ').some((x) => /^[一-鿿]$/.test(x)), '单字无区分度，不应作为 token');
});

test('回归：双字必须**重叠**生成（旧实现只出非重叠对，"值班"永远召不回）', () => {
  const toks = cjkBigrams('课程管理与值班').split(' ');
  assert.ok(toks.includes('课程') && toks.includes('程管') && toks.includes('管理'), '应逐字滑动生成');
  assert.ok(toks.includes('值班'), '奇数偏移处的词也必须能被生成 —— 这是旧实现的漏召根因');
  // 重复字不得产生空 token（旧实现 prev!==ch 会把"妈妈"整对丢掉）
  const dup = cjkBigrams('妈妈来了').split(' ');
  assert.ok(dup.includes('妈妈') && dup.includes('来了'), '重复相邻字要正常出词');
  assert.ok(!dup.includes(''), '不得产生空 token');
});

test('回归：连字符不得被当作汉字切出脏 token', () => {
  const toks = cjkBigrams('A-B学').split(' ');
  assert.ok(!toks.some((t) => t.startsWith('-')), '旧字符类 [一-鿿-] 把裸 - 当汉字，会产出 "-学"');
});

test('两字中文短查询能命中对应文档（unicode61 直挂的场景）', () => {
  const hits = searchChunks('调课', 'admin', '2026-10-29', docs, 4);
  assert.ok(hits.length > 0, '「调课」不应零命中');
  assert.equal(hits[0].docId, 'schedule-adjustment');
  assert.ok(hits.some((h) => h.via.includes('bm25')), 'BM25 路应参与召回');
});

test('权限是硬前置：管理员专属制度不可能靠高分进入学生结果', () => {
  const student = searchChunks('学生能自己调课吗', 'student', '2026-10-29', docs, 8);
  assert.ok(!student.some((h) => h.docId === 'schedule-adjustment'), '学生不得检索到 admin-only 制度');
  const admin = searchChunks('学生能自己调课吗', 'admin', '2026-10-29', docs, 8);
  assert.ok(admin.some((h) => h.docId === 'schedule-adjustment'), '同一查询在管理员侧应可见');
});

test('生效日期是硬前置：制度生效前检索不到，过期后同样检索不到', () => {
  assert.equal(searchChunks('调课', 'admin', '2026-09-01', docs, 4).length, 0, '生效日之前必须为空');
  const expiring = docs.find((d) => d.effectiveTo);
  if (expiring) {
    // 取到失效日之后一天：该文档的招牌关键词在任何角色下都不应再被检索到
    const after = new Date(new Date(expiring.effectiveTo!).getTime() + 86400000).toISOString().slice(0, 10);
    const hits = searchChunks(expiring.keywords[0], 'admin', after, docs, 20);
    assert.ok(!hits.some((h) => h.docId === expiring.id), `${expiring.id} 已过期仍被引用`);
  }
});

test('语料外问题返回空，不返回"最接近"的段落', () => {
  assert.equal(searchChunks('全国考试报销金额标准', 'admin', '2026-10-29', docs, 4).length, 0);
  assert.equal(searchChunks('', 'admin', '2026-10-29', docs, 4).length, 0, '空查询不得返回全库');
});

test('引用定位可回溯：§N 指向真实存在的段落原文', () => {
  for (const h of retrieveRanked('在室人数是怎么算出来的', 'admin', '2026-10-29', docs, 4, 3)) {
    for (const p of h.paragraphs) {
      assert.ok(p.index >= 1 && p.index <= h.doc.paragraphs.length, `${h.doc.id} §${p.index} 越界`);
      assert.equal(p.text, h.doc.paragraphs[p.index - 1], `${h.doc.id} §${p.index} 文本与原文不一致`);
    }
  }
});

test('语料规模达到参赛叙事底线', () => {
  assert.ok(docs.length >= 14, `文档数 ${docs.length}`);
  const paragraphs = docs.reduce((s, d) => s + d.paragraphs.length, 0);
  assert.ok(paragraphs >= 50, `段落数 ${paragraphs}`);
  for (const d of docs) {
    assert.ok(d.roles.length > 0 && d.keywords.length > 0, `${d.id} 缺角色或关键词`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d.effectiveFrom), `${d.id} 生效日期格式`);
  }
});

test('explainRecall 能区分"被过滤掉"与"排序没排上"', () => {
  resetIndexForTests();
  const blocked = explainRecall('调课', 'student', '2026-10-29', docs);
  assert.ok(blocked.filteredOut > 0, '学生侧应有文档被权限过滤');
  assert.ok(!blocked.eligibleDocs.includes('schedule-adjustment'));
  const ok = explainRecall('调课', 'admin', '2026-10-29', docs);
  assert.ok(ok.keyword.length + ok.bm25.length > 0, '管理员侧至少一路有召回');
});
