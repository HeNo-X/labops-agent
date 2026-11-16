/**
 * 知识检索评估报告（npm run knowledge:eval）
 * ============================================================================
 *  对金样本跑双配置并输出对比报告：
 *    · 词法两路（关键词+BM25，确定性基线）——恒可复现；
 *    · 三路混合（+向量）——EMBEDDING_ENABLED=1 且 knowledge:index 已建索引时
 *      真实运行，否则如实标注 skipped。
 *  改检索（分块/召回/融合/重排/语料）前后各跑一次，指标不许变差。
 */
import { documents } from '../server/tools/knowledge.ts';
import { runKnowledgeEval, formatReport } from '../server/tools/knowledge-eval.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GOLD = (JSON.parse(readFileSync(fileURLToPath(new URL('../tests/fixtures/knowledge-eval.json', import.meta.url)), 'utf8')) as { cases: GoldCase[] }).cases;
const docs = documents();

const lexical = await runKnowledgeEval(GOLD, docs, { enabled: false });
console.log('【基线：词法两路（关键词+BM25）】');
console.log(formatReport(lexical));

const hybrid = await runKnowledgeEval(GOLD, docs, { enabled: true });
console.log('\n【对照：三路混合（+向量路）】');
console.log(formatReport(hybrid));

if (!hybrid.vectorUsed) {
  console.log('\n（向量路未启用或未建索引：置 EMBEDDING_ENABLED=1 并运行 npm run knowledge:index 后重跑可得真实对比。）');
} else {
  console.log(`\n对比结论：hit@1 ${lexical.hit1}→${hybrid.hit1}｜hit@3 ${lexical.hit3}→${hybrid.hit3}｜引文 ${lexical.textHit}→${hybrid.textHit}`);
}
process.exit(0);
