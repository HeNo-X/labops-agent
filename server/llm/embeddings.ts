/**
 * Embedding 客户端
 * ============================================================================
 *  走 DashScope 的 OpenAI 兼容端点 `POST {baseUrl}/embeddings`（复用
 *  DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL，不引入额外依赖）。
 *  模型 text-embedding-v3，维度可配（缺省 1024）。
 *
 *  设计约束：
 *   · 批量输入按 EMBEDDING_BATCH_SIZE（缺省 10）分批，顺序按上游返回的
 *     index 字段重排——绝不依赖响应顺序恰与请求一致；
 *   · 可重试：网络错误 / 5xx / 429 各重试一次（指数退避），配额类 403 不重试；
 *   · 测试可注入：embedTexts 的第二参允许覆盖 endpoint 配置（进程内起假上游
 *     即可测，不需要子进程——避免 execFileSync 死锁，见 tests/fixtures/quota-probe.ts）；
 *   · 关闭（EMBEDDING_ENABLED=0）或无 Key 时调用方必须走纯词法路（本模块
 *     不做兜底决策，只如实抛错/报状态）。
 */
import { getConfig } from '../config.ts';

export class EmbeddingError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = code;
    this.status = status;
  }
}

export interface EmbeddingEndpoint {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  batchSize: number;
}

/** 运行配置（config 缓存一次；测试用 override 注入假上游，避免子进程） */
export function embeddingEndpoint(override?: Partial<EmbeddingEndpoint>): EmbeddingEndpoint {
  const c = getConfig();
  return {
    apiKey: override?.apiKey ?? c.dashscope.apiKey,
    baseUrl: override?.baseUrl ?? c.dashscope.baseUrl,
    model: override?.model ?? c.embeddings.model,
    dimensions: override?.dimensions ?? c.embeddings.dimensions,
    batchSize: override?.batchSize ?? c.embeddings.batchSize
  };
}

/** 查询期总开关：显式开启 且 有 Key 才算可用（索引是否已建由调用方查表判断） */
export function isEmbeddingEnabled(): boolean {
  return getConfig().embeddings.enabled && getConfig().dashscope.apiKey.length > 0;
}

/** 余弦相似度（纯函数）。零向量返回 0——不相似也好过 NaN 污染排序。 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

interface EmbedResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

async function postEmbeddings(texts: string[], ep: EmbeddingEndpoint, signal?: AbortSignal): Promise<number[][]> {
  const res = await fetch(`${ep.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
    body: JSON.stringify({ model: ep.model, input: texts, dimensions: ep.dimensions }),
    signal
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const quota = res.status === 403 && /AllocationQuota|FreeTierOnly|Arrearage|quota|欠费/i.test(body);
    if (quota) throw new EmbeddingError('embedding_quota_exhausted', `Embedding 账号配额/额度已用尽（HTTP 403）。`, res.status);
    if (res.status === 401) throw new EmbeddingError('embedding_auth_failed', `Embedding 鉴权失败（HTTP 401）：检查 DASHSCOPE_API_KEY。`, res.status);
    throw new EmbeddingError('embedding_http_error', `Embedding 上游错误（HTTP ${res.status}）。${body.slice(0, 200)}`, res.status);
  }
  const json = (await res.json()) as EmbedResponse;
  const data = Array.isArray(json.data) ? json.data : [];
  const out: number[][] = new Array(texts.length);
  data.forEach((d, i) => {
    const target = typeof d.index === 'number' ? d.index : i;
    if (Array.isArray(d.embedding)) out[target] = d.embedding;
  });
  for (let i = 0; i < texts.length; i += 1) {
    if (!Array.isArray(out[i])) throw new EmbeddingError('embedding_bad_response', `Embedding 响应缺少第 ${i} 条向量。`, res.status);
  }
  return out;
}

/**
 * 批量向量化。分批串行（上游批量上限 ~10 条），批间遇错整体抛出——
 * 调用方（索引命令）据此停止，绝不写半截索引不吭声。
 */
export async function embedTexts(texts: string[], override?: Partial<EmbeddingEndpoint>): Promise<number[][]> {
  if (!texts.length) return [];
  const ep = embeddingEndpoint(override);
  if (!ep.apiKey) throw new EmbeddingError('embedding_not_configured', '未配置 DASHSCOPE_API_KEY，无法向量化。', null);
  const out: number[][] = new Array(texts.length);
  for (let start = 0; start < texts.length; start += ep.batchSize) {
    const slice = texts.slice(start, start + ep.batchSize);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const vecs = await postEmbeddings(slice, ep);
        vecs.forEach((v, i) => { out[start + i] = v; });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const e = err as EmbeddingError;
        if (e.code === 'embedding_quota_exhausted' || e.code === 'embedding_auth_failed' || e.code === 'embedding_not_configured') throw e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (lastErr) throw lastErr;
  }
  return out;
}

/** 单条查询向量化（查询期每次一次调用） */
export async function embedQuery(text: string, override?: Partial<EmbeddingEndpoint>): Promise<number[]> {
  const [vec] = await embedTexts([text], override);
  if (!vec) throw new EmbeddingError('embedding_bad_response', '查询向量化返回为空。', null);
  return vec;
}
