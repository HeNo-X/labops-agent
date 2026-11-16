/**
 * 知识向量索引 API
 * ============================================================================
 *  POST /api/knowledge/reindex —— 管理员触发重建：内置操作说明全量 + 主系统
 *  已审核手册（连通时）。幂等可重跑；供「知识导入」页导入完成后一键刷新向量。
 *  GET  /api/knowledge/vec-status —— 索引现状（管理员），供界面展示。
 *  权限：effectiveRole()==='admin'（服务端核验身份，客户端声明不作数）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { effectiveRole, isBusinessConnected, businessRequest } from '../business/bridge.ts';
import { documents } from '../tools/knowledge.ts';
import { indexKnowledge, indexManuals, vecIndexStats } from '../tools/knowledge-vector.ts';
import { embeddingEndpoint, isEmbeddingEnabled } from '../llm/embeddings.ts';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function handleKnowledgeApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/knowledge/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  try {
    if (!pathname.startsWith('/api/knowledge/vec')) {
      // 重建属管理操作：非管理员一律 403（沙盒身份同样经 resolveActor 校验）
      if (effectiveRole() !== 'admin') {
        json(res, 403, { error: 'admin_required', message: '重建知识向量索引需要管理员身份。' });
        return true;
      }
    }
    if (pathname === '/api/knowledge/reindex' && method === 'POST') {
      if (!embeddingEndpoint().apiKey) {
        json(res, 503, { error: 'embedding_not_configured', message: '未配置 DASHSCOPE_API_KEY，无法向量化。' });
        return true;
      }
      const docs = documents();
      const r = await indexKnowledge(docs);
      let manualsSummary: { indexed: number; pruned: number; docs: number } | null = null;
      let manualsError: string | null = null;
      if (isBusinessConnected()) {
        try {
          const raw = await businessRequest('/evidence/manuals');
          const manuals = (raw['manuals'] ?? []) as Array<{ id: string; title: string; device: string; version: string; paragraphs: Array<{ id: string; text: string }> }>;
          manualsSummary = await indexManuals(manuals);
        } catch (e) {
          manualsError = (e as Error).message; // 手册失败不否定内置文档的重建成果
        }
      }
      json(res, 200, {
        ok: true,
        docs: { indexed: r.indexed, pruned: r.pruned, total: r.docs },
        manuals: manualsSummary,
        manualsError,
        embeddingEnabled: isEmbeddingEnabled(),
        index: vecIndexStats()
      });
      return true;
    }
    if (pathname === '/api/knowledge/vec-status' && method === 'GET') {
      json(res, 200, {
        embeddingEnabled: isEmbeddingEnabled(),
        model: embeddingEndpoint().model,
        dimensions: embeddingEndpoint().dimensions,
        index: vecIndexStats()
      });
      return true;
    }
    json(res, 404, { error: 'not_found', message: '知识索引接口不存在。' });
    return true;
  } catch (e) {
    json(res, 500, { error: 'knowledge_reindex_failed', message: (e as Error).message });
    return true;
  }
}
