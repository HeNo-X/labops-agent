/**
 * /api/service/agent-run —— 供主系统调度器"到点让 Agent 真跑一轮"的服务端入口
 * ============================================================================
 *  为什么需要它：定时任务现在只把一段静态文本投递出去；要变成 ZCode 那种
 *  "到点 Agent 自己去查、去想、去写结论"，就必须让**主系统的调度器**能代某个用户
 *  触发一轮 Agent。而 LabOps 只认 SSO 票和用户 Bearer，服务端无法自称"我是为用户 X 跑的"。
 *
 *  鉴权：机器到机器，HMAC-SHA256（`ts.nonce.rawBody` + 300 秒时间窗 + nonce 防重放 +
 *        常量时间比较），与视觉边缘上报 `POST /api/vision/report` 用同一套做法。
 *        在 security/http.ts 里与它并列豁免登录——豁免的是"身份分支"，签名校验一条不少。
 *
 *  权限：**默认只读**。调用方必须显式列出 `allowedTools` 才可能拿到写类工具，
 *        而且"写"在这里只是 `prepare_*`（出草稿、待人确认），LabOps 从来不存在
 *        无人值守直接改业务状态的工具——这是架构事实，不是本次的保守选择。
 *
 *  幂等：`jobRunId` 是幂等键。同一 jobRunId 第二次进来直接回缓存结果，不会重跑；
 *        正在跑时返回 409 in_progress，让调度器下轮再来（它本来就有三次退避）。
 *
 *  路由：
 *    POST /api/service/agent-run
 *    headers: x-service-ts / x-service-nonce / x-service-signature
 *    body: { jobRunId, owner:{id,role,label?}, prompt, allowedTools?, sessionId?, timeoutMs? }
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { getConfig } from '../config.ts';
import { getDb } from '../persistence/db.ts';
import { loggerFor } from '../obs/trace.ts';
import { runAgent } from '../agent/run.ts';
import { toolsForMode } from '../tools/registry.ts';
import { modelForMode } from '../llm/router.ts';
import type { SandboxActor, SandboxRole } from '../../shared/operations-contract.ts';

const log = loggerFor('service-agent');
const BODY_LIMIT = 64 * 1024;
const REPLAY_WINDOW_SECONDS = 300;
const NONCE_TTL_MS = 10 * 60 * 1000;
const RUNNING_STALE_MS = 90 * 1000;

const seenNonces = new Map<string, number>();

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; raw: string } | { ok: false; code: string; message: string; status: number }> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve({ ok: false, code: 'body_too_large', message: `请求体超过 ${maxBytes} 字节`, status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (err) => resolve({ ok: false, code: 'body_read_failed', message: err.message, status: 400 }));
  });
}

function serviceSecret(): string {
  return (process.env.LABOPS_SERVICE_SECRET || '').trim();
}

export function signServicePayload(secret: string, ts: number, nonce: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${rawBody}`).digest('hex');
}

type SigCheck = { ok: true } | { ok: false; code: string };
function verifySignature(secret: string, ts: unknown, nonce: unknown, rawBody: string, signature: unknown): SigCheck {
  if (!secret) return { ok: false, code: 'service_disabled' };
  const tsNum = typeof ts === 'string' || typeof ts === 'number' ? Number(ts) : NaN;
  if (!Number.isInteger(tsNum) || tsNum <= 0) return { ok: false, code: 'bad_timestamp' };
  if (Math.abs(Date.now() / 1000 - tsNum) > REPLAY_WINDOW_SECONDS) return { ok: false, code: 'stale_timestamp' };
  if (typeof nonce !== 'string' || !/^[a-f0-9]{8,64}$/i.test(nonce)) return { ok: false, code: 'bad_nonce' };
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return { ok: false, code: 'bad_signature' };
  const expected = signServicePayload(secret, tsNum, nonce, rawBody);
  const a = Buffer.from(signature.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'bad_signature' };
  const now = Date.now();
  if (seenNonces.has(nonce)) return { ok: false, code: 'replayed' };
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  if (seenNonces.size > 1024) for (const [k, exp] of seenNonces) if (exp <= now) seenNonces.delete(k);
  return { ok: true };
}

function ensureTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS service_runs(
    jobRunId TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    payload TEXT,
    startedAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );`);
}

interface CachedRow { status: string; payload: string | null; startedAt: string }

function readRun(jobRunId: string): CachedRow | undefined {
  return getDb().prepare('SELECT status,payload,startedAt FROM service_runs WHERE jobRunId=?').get(jobRunId) as CachedRow | undefined;
}

const ROLES: SandboxRole[] = ['admin', 'volunteer', 'student'];

interface ValidBody {
  jobRunId: string;
  owner: SandboxActor;
  prompt: string;
  allowedTools: string[];
  sessionId: string;
  timeoutMs: number;
}

function coerce(raw: unknown): { ok: true; value: ValidBody } | { ok: false; code: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'bad_body', message: '请求体必须是对象' };
  const b = raw as Record<string, unknown>;
  const jobRunId = typeof b['jobRunId'] === 'string' ? b['jobRunId'].trim() : '';
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(jobRunId)) return { ok: false, code: 'bad_job_run_id', message: 'jobRunId 必须是 6~80 位的字母数字下划线连字符' };

  const own = b['owner'];
  if (!own || typeof own !== 'object') return { ok: false, code: 'bad_owner', message: '缺少 owner' };
  const o = own as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
  const role = o['role'];
  if (!id) return { ok: false, code: 'bad_owner', message: 'owner.id 不能为空' };
  if (typeof role !== 'string' || !ROLES.includes(role as SandboxRole)) return { ok: false, code: 'bad_owner', message: 'owner.role 必须是 admin/volunteer/student' };

  const prompt = typeof b['prompt'] === 'string' ? b['prompt'].trim() : '';
  if (!prompt) return { ok: false, code: 'bad_prompt', message: 'prompt 不能为空' };
  if (prompt.length > 2000) return { ok: false, code: 'bad_prompt', message: 'prompt 超过 2000 字' };

  const requested = Array.isArray(b['allowedTools']) ? b['allowedTools'] : [];
  const allowedTools = [...new Set(requested.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).map((x) => x.trim()))];

  const sessionRaw = typeof b['sessionId'] === 'string' ? b['sessionId'].trim().slice(0, 96) : '';
  const timeoutRaw = Number(b['timeoutMs']);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(Math.max(timeoutRaw, 5000), 120000) : 45000;

  return {
    ok: true,
    value: {
      jobRunId,
      owner: { id, role: role as SandboxRole, label: typeof o['label'] === 'string' ? o['label'] : id },
      prompt,
      allowedTools,
      sessionId: sessionIdOf(id, sessionRaw || `scheduled-${jobRunId}`),
      timeoutMs
    }
  };
}

/** 与 /api/agent/chat 同口径：会话按用户命名空间隔离，避免跨账号串上下文 */
function sessionIdOf(actorId: string, raw: string): string {
  return `${actorId}:${raw}`.slice(0, 128);
}

interface ToolTrace { tool: string; ok: boolean; summary?: string }

async function execute(body: ValidBody): Promise<Record<string, unknown>> {
  const taskTools = new Set(toolsForMode('task').map((t) => t.name));
  const unknown = body.allowedTools.filter((name) => !taskTools.has(name));
  if (unknown.length) {
    const err = new Error(`白名单里有不存在的工具：${unknown.join('、')}`);
    (err as Error & { code?: string }).code = 'bad_tools';
    throw err;
  }

  const readOnly = toolsForMode('chat').map((t) => t.name);
  const allowed = [...new Set([...readOnly, ...body.allowedTools])];
  const mode: 'chat' | 'task' = body.allowedTools.length ? 'task' : 'chat';

  const started = Date.now();
  let answer = '';
  let runId = '';
  let toolCalls = 0;
  let engine = '';
  let model = '';
  let usage: unknown = null;
  const traces: ToolTrace[] = [];

  const signal = AbortSignal.timeout(body.timeoutMs);
  for await (const ev of runAgent({
    question: body.prompt,
    sessionId: body.sessionId,
    mode,
    actor: body.owner,
    allowedTools: allowed,
    signal
  })) {
    runId = ev.runId || runId;
    const p = ev.payload as Record<string, unknown>;
    if (ev.type === 'run_started') {
      engine = String(p['engine'] ?? '');
      model = String(p['model'] ?? '');
    } else if (ev.type === 'answer_delta') {
      answer += String(p['text'] ?? '');
    } else if (ev.type === 'tool_started') {
      toolCalls += 1;
    } else if (ev.type === 'tool_result') {
      traces.push({ tool: String(p['tool'] ?? ''), ok: Boolean(p['ok']), summary: typeof p['summary'] === 'string' ? p['summary'].slice(0, 200) : undefined });
    } else if (ev.type === 'run_completed') {
      if (typeof p['answer'] === 'string' && p['answer']) answer = p['answer'];
      if (p['model']) model = String(p['model']);
      usage = p['usage'] ?? usage;
    } else if (ev.type === 'run_failed') {
      const err = new Error(String(p['message'] ?? '本轮执行失败'));
      (err as Error & { code?: string }).code = String(p['code'] ?? 'run_failed');
      throw err;
    }
  }

  return {
    ok: true,
    runId,
    answer: answer.trim(),
    toolCalls,
    tools: traces,
    engine,
    model: model || modelForMode(mode) || '',
    usage,
    elapsedMs: Date.now() - started,
    mode,
    allowedTools: allowed
  };
}

export async function handleServiceAgent(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (pathname !== '/api/service/agent-run') {
    reply(res, 404, { error: 'not_found', message: '未知的服务端接口' });
    return;
  }
  if (req.method !== 'POST') {
    reply(res, 405, { error: 'method_not_allowed', message: '只接受 POST' });
    return;
  }
  const secret = serviceSecret();
  if (!secret) {
    reply(res, 503, { error: 'service_disabled', message: '未配置 LABOPS_SERVICE_SECRET，服务端调用通道关闭' });
    return;
  }

  const raw = await readRawBody(req, BODY_LIMIT);
  if (!raw.ok) {
    reply(res, raw.status, { error: raw.code, message: raw.message });
    return;
  }
  const sig = verifySignature(secret, req.headers['x-service-ts'], req.headers['x-service-nonce'], raw.raw, req.headers['x-service-signature']);
  if (!sig.ok) {
    log.warn('service_run_rejected', { code: sig.code });
    reply(res, sig.code === 'stale_timestamp' || sig.code === 'replayed' ? 409 : 401, { error: sig.code, message: '服务端调用签名校验未通过' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.raw);
  } catch {
    reply(res, 400, { error: 'bad_json', message: '请求体不是合法 JSON' });
    return;
  }
  const coerced = coerce(parsed);
  if (!coerced.ok) {
    reply(res, 400, { error: coerced.code, message: coerced.message });
    return;
  }
  const body = coerced.value;

  // ---- 幂等：同一 jobRunId 只跑一次 ----
  try {
    ensureTable();
  } catch (err) {
    reply(res, 503, { error: 'store_unavailable', message: `任务库不可用：${(err as Error).message}` });
    return;
  }
  const existing = readRun(body.jobRunId);
  if (existing?.status === 'done' && existing.payload) {
    reply(res, 200, { ...(JSON.parse(existing.payload) as object), replayed: true });
    return;
  }
  if (existing?.status === 'running' && Date.now() - Date.parse(existing.startedAt) < RUNNING_STALE_MS) {
    reply(res, 409, { error: 'in_progress', message: '同一任务正在执行，请稍后按原请求号复查' });
    return;
  }
  const nowIso = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO service_runs(jobRunId,status,payload,startedAt,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(jobRunId) DO UPDATE SET status=excluded.status,payload=NULL,startedAt=excluded.startedAt,updatedAt=excluded.updatedAt')
    .run(body.jobRunId, 'running', null, nowIso, nowIso);

  try {
    const result = await execute(body);
    getDb().prepare('UPDATE service_runs SET status=?,payload=?,updatedAt=? WHERE jobRunId=?').run('done', JSON.stringify(result), new Date().toISOString(), body.jobRunId);
    log.info('service_run_done', { jobRunId: body.jobRunId, owner: body.owner.id, mode: result['mode'], toolCalls: result['toolCalls'] });
    reply(res, 200, { ...result, replayed: false });
  } catch (err) {
    const code = (err as Error & { code?: string }).code || 'run_failed';
    const message = (err as Error).message;
    getDb().prepare('UPDATE service_runs SET status=?,payload=?,updatedAt=? WHERE jobRunId=?').run('failed', JSON.stringify({ ok: false, code, message }), new Date().toISOString(), body.jobRunId);
    log.warn('service_run_failed', { jobRunId: body.jobRunId, owner: body.owner.id, code, message });
    reply(res, code === 'bad_tools' ? 400 : 502, { ok: false, error: code, message });
  }
}

/** 仅供测试与运维自检：不对外暴露路由 */
export const __serviceInternals = { signServicePayload, coerce, sessionIdOf, resetNonces: () => seenNonces.clear() };
void getConfig;
void randomUUID;
