#!/usr/bin/env node
/**
 * 检索评测：混合召回与子串匹配，在同一套标注下对比。
 * ============================================================================
 *  为什么要跑两种：只报单一算法的"Recall@4 = X"没有信息量。必须给出同一套标注下
 *  子串匹配的对照数字，才能说明混合召回带来了多少增益，也才能排除只挑有利指标的可能。
 *
 *  指标：
 *   · Recall@4 —— 期望文档是否出现在前 4 个结果里（与生产查询的 top4 口径一致）
 *   · MRR      —— 首个命中的名次倒数均值，衡量"排得靠不靠前"
 *   · 空结果正确率 —— 权限外/未生效/语料外问题，必须返回空；返回了就是越权或编造
 *
 *  本脚本**不调用任何模型**，纯检索，因此可离线复跑、结果确定。
 *  运行：node scripts/evaluate-retrieval.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'evaluation/retrieval-scenarios.json'), 'utf8'));

process.env.LABOPS_DB_PATH = ':memory:';
process.env.LABOPS_AUTH_MODE = 'demo';
const { documents, retrieve, retrieveRanked } = await import('../server/tools/knowledge.ts');

const docs = documents();
const corpus = {
  documents: docs.length,
  paragraphs: docs.reduce((s, d) => s + d.paragraphs.length, 0),
  roles: [...new Set(docs.flatMap((d) => d.roles))].sort()
};

/** 子串匹配：文档级打分基线 */
function legacyTop(query, role, date, k = 4) {
  return retrieve(query, role, date, docs).slice(0, k).map((d) => d.id);
}
/** 混合召回：CJK 双字 BM25 + 关键词，RRF 融合，段落级 */
function hybridTop(query, role, date, k = 4) {
  const seen = [];
  for (const h of retrieveRanked(query, role, date, docs, k, 4)) if (!seen.includes(h.doc.id)) seen.push(h.doc.id);
  return seen.slice(0, k);
}

function score(runner) {
  const rows = cases.map((c) => {
    const got = runner(c.query, c.role, c.date);
    const rank = got.findIndex((id) => c.expectDocs.includes(id));
    const hit = rank >= 0;
    // 越权/不该出现的文档：任何情况下命中即失败（与"是否答得上"独立评判）
    const leaked = (c.forbiddenDocs ?? []).filter((id) => got.includes(id));
    // 无期望文档 ⇒ 护栏用例（越权/未生效/语料外），只考核"别答错"，不要求一定为空
    const guard = c.expectDocs.length === 0;
    return {
      id: c.id,
      query: c.query,
      role: c.role,
      expected: c.expectDocs,
      got,
      hit,
      rank: hit ? rank + 1 : 0,
      leaked,
      guard,
      ok: guard ? leaked.length === 0 && (c.expectEmpty !== true || got.length === 0) ? 1 : 0 : hit ? 1 : 0
    };
  });
  const answerable = rows.filter((r) => !r.guard);
  const guards = rows.filter((r) => r.guard);
  return {
    recallAt4: answerable.length ? answerable.filter((r) => r.hit).length / answerable.length : 0,
    mrr: answerable.length ? answerable.reduce((s, r) => s + (r.hit ? 1 / r.rank : 0), 0) / answerable.length : 0,
    emptyCorrect: guards.length ? guards.filter((r) => r.ok === 1).length / guards.length : 1,
    /** 越权泄露数：独立于排序质量，>0 即不达标 */
    leaks: rows.reduce((s, r) => s + r.leaked.length, 0),
    rows
  };
}

const legacy = score(legacyTop);
const hybrid = score(hybridTop);

const pct = (x) => (x * 100).toFixed(1) + '%';
const fmt = (r) => ({
  'Recall@4': pct(r.recallAt4),
  MRR: r.mrr.toFixed(3),
  '护栏正确率': pct(r.emptyCorrect),
  越权泄露: r.leaks
});

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        evaluatedAt: new Date().toISOString(),
        corpus,
        cases: cases.length,
        modelCalls: 0,
        legacy: { ...fmt(legacy), misses: legacy.rows.filter((r) => r.ok === 0 || r.leaked.length).map((r) => r.id) },
        hybrid: { ...fmt(hybrid), misses: hybrid.rows.filter((r) => r.ok === 0 || r.leaked.length).map((r) => r.id) },
        detail: hybrid.rows
      },
      null,
      2
    )
  );
} else {
  console.log(`语料：${corpus.documents} 篇 / ${corpus.paragraphs} 段 / 角色 ${corpus.roles.join(', ')}`);
  console.log(`用例：${cases.length} 条（可答题 ${cases.filter((c) => !c.expectEmpty).length}，必须空答 ${cases.filter((c) => c.expectEmpty).length}）\n`);
  console.log('            Recall@4   MRR     护栏正确率  越权泄露');
  console.log(`旧·子串匹配  ${pct(legacy.recallAt4).padEnd(9)} ${legacy.mrr.toFixed(3).padEnd(6)} ${pct(legacy.emptyCorrect).padEnd(12)} ${legacy.leaks}`);
  console.log(`新·混合召回  ${pct(hybrid.recallAt4).padEnd(9)} ${hybrid.mrr.toFixed(3).padEnd(6)} ${pct(hybrid.emptyCorrect).padEnd(12)} ${hybrid.leaks}\n`);
  const improved = hybrid.rows.filter((r, i) => r.ok === 1 && legacy.rows[i].ok === 0);
  const regressed = hybrid.rows.filter((r, i) => r.ok === 0 && legacy.rows[i].ok === 1);
  console.log(`新算法修复 ${improved.length} 条：${improved.map((r) => r.id).join(', ') || '无'}`);
  console.log(`新算法退化 ${regressed.length} 条：${regressed.map((r) => r.id).join(', ') || '无'}`);
  const stillMissing = hybrid.rows.filter((r) => r.ok === 0 || r.leaked.length);
  if (stillMissing.length) {
    console.log('\n仍未通过（如实列出，不藏）：');
    for (const r of stillMissing) {
      const leak = r.leaked.length ? ` ⚠越权 [${r.leaked.join(',')}]` : '';
      console.log(`  ${r.id} 「${r.query}」role=${r.role} 期望 [${r.expected.join('|') || '空'}] 实得 [${r.got.join(', ') || '空'}]${leak}`);
    }
  }
}

// 达标线：可答题 Recall@4 ≥ 80%、空答全对、零越权。任一不满足即退出 1。
process.exit(hybrid.recallAt4 >= 0.8 && hybrid.emptyCorrect === 1 && hybrid.leaks === 0 ? 0 : 1);
