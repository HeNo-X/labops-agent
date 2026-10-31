/**
 * RAG 批次 1：知识向量索引命令（npm run knowledge:index）
 * ============================================================================
 *  对知识库全量段落向量化并写入持久库（knowledge_chunks_vec），幂等可重跑。
 *  需要 DASHSCOPE_API_KEY（走 DashScope text-embedding，OpenAI 兼容端点）。
 *  索引建立 ≠ 查询期启用：查询期还要求 EMBEDDING_ENABLED=1（见 .env.example）。
 */
import { documents } from '../server/tools/knowledge.ts';
import { indexKnowledge, vecIndexStats } from '../server/tools/knowledge-vector.ts';
import { embeddingEndpoint, isEmbeddingEnabled } from '../server/llm/embeddings.ts';

const docs = documents();
if (!docs.length) {
  console.log('知识库为空，无需索引。');
  process.exit(0);
}
const ep = embeddingEndpoint();
if (!ep.apiKey) {
  console.error('未配置 DASHSCOPE_API_KEY，无法向量化。请在 .env 配置后重试。');
  process.exit(1);
}
console.log(`向量化 ${docs.length} 份文档（模型 ${ep.model}，维度 ${ep.dimensions}，批量 ${ep.batchSize}）…`);
const started = Date.now();
const r = await indexKnowledge(docs);
const stats = vecIndexStats();
console.log(`完成：写入/更新 ${r.indexed} 块，清理陈旧 ${r.pruned} 块；库内现 ${stats.count} 块（${Math.round((Date.now() - started) / 100) / 10}s）`);
if (!isEmbeddingEnabled()) {
  console.log('⚠️ EMBEDDING_ENABLED=0：索引已建，但查询期暂不使用向量路。置 1 并重启服务后生效。');
}
process.exit(0);
