/**
 * /api/vision/* —— 视觉边缘上报的接收端与查询端
 * ============================================================================
 *  路由清单：
 *    POST /api/vision/report        边缘上报（自带 HMAC 鉴权，绕过登录身份，
 *                                   见 security/http.ts 的豁免行）
 *    GET  /api/vision/status        各房间最新状态摘要（登录身份）
 *    GET  /api/vision/events        事件流水 ?lab=&limit=&since=
 *    GET  /api/vision/snapshot?lab= 最新脱敏快照（内存单张，无则 404）
 *    GET  /api/vision/live-probe    探测实验室内网 MJPEG 服务是否可达
 *    GET  /api/vision/feed          同机代理内网 MJPEG 实时画面（拓扑感知：
 *                                   labops 与 vision 同机/同内网时才有画面；
 *                                   云端独立部署时上游不可达 → 502，前端收起画面卡）
 *
 *  快照契约：边缘必须在发送前完成人脸打码（PIPL 匿名化口径）；云端只收
 *  ≤200KB 的单张 JPEG/PNG，内存保留最新一张，不落盘。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Readable } from 'node:stream';
import {
  coerceVisionReport,
  getVisionSecret,
  ingestVisionReport,
  recordVisionFeedback,
  verifyVisionSignature,
  visionEventFeedback,
  visionEvents,
  visionIngestConfigured,
  visionSnapshot,
  visionStatus,
  MAX_SNAPSHOT_BYTES
} from '../vision/monitor.ts';
import { currentActor } from '../security/context.ts';
import { loggerFor } from '../obs/trace.ts';

const log = loggerFor('vision');
const REPORT_BODY_LIMIT = 1024 * 1024; // 上报 JSON ≤ 1MiB（含可选快照时走 snapshotBase64，同样受限）
const LIVE_FEED_URL = (process.env.VISION_LIVE_FEED_URL || 'http://127.0.0.1:5000/live/video_feed').replace(/\/+$/, '');
const LIVE_FEED_TOKEN = process.env.VISION_LIVE_TOKEN || '';

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; raw: string } | { ok: false; code: string; message: string; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (code: string, message: string, status: number): void => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code, message, status });
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail('body_too_large', `上报载荷超过 ${maxBytes} 字节上限`, 413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => fail('body_read_error', '读取上报数据失败', 400));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, raw: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

// ---- 边缘上报（HMAC 自鉴权） -------------------------------------------------

async function handleReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!visionIngestConfigured()) {
    reply(res, 503, { error: 'vision_ingest_disabled', message: '视觉接入未启用：服务端未配置 VISION_INGEST_SECRET' });
    return;
  }
  const raw = await readRawBody(req, REPORT_BODY_LIMIT);
  if (!raw.ok) {
    reply(res, raw.status, { error: raw.code, message: raw.message });
    return;
  }
  const check = verifyVisionSignature(
    getVisionSecret(),
    req.headers['x-vision-ts'],
    req.headers['x-vision-nonce'],
    raw.raw,
    req.headers['x-vision-signature']
  );
  if (!check.ok) {
    log.warn('vision_report_rejected', { code: check.code });
    reply(res, check.code === 'stale_timestamp' || check.code === 'replayed' ? 409 : 401, { error: check.code, message: '上报签名校验未通过，请核对 VISION_INGEST_SECRET 与系统时钟' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.raw);
  } catch {
    reply(res, 400, { error: 'bad_json', message: '上报载荷不是合法 JSON' });
    return;
  }
  const coerced = coerceVisionReport(parsed);
  if (!coerced.ok) {
    reply(res, 400, { error: coerced.code, message: coerced.message });
    return;
  }

  const payload = parsed as Record<string, unknown>;
  const snapshotRaw = typeof payload['snapshotBase64'] === 'string' ? payload['snapshotBase64'] : undefined;
  const ingested = ingestVisionReport(coerced.value, {
    snapshotBase64: snapshotRaw && snapshotRaw.length * 0.75 <= MAX_SNAPSHOT_BYTES ? snapshotRaw : undefined,
    snapshotMime: typeof payload['snapshotMime'] === 'string' ? payload['snapshotMime'] : undefined
  });
  if (!ingested.ok) {
    reply(res, 400, { error: ingested.code, message: ingested.message });
    return;
  }
  if (ingested.event.alert) log.info('vision_alert', { lab: ingested.event.lab_id, count: ingested.event.count, capacity: ingested.event.capacity, online: ingested.event.camera_online });
  reply(res, 200, { ok: true, alert: ingested.event.alert, snapshotIgnored: ingested.snapshotIgnored ?? null });
}

// ---- 展示口径（2026-11-11 用户裁定）------------------------------------------
// 检测结果区只呈现**真实 vision 侧上报**的房间结果（按房间分卡）：
//   · DEMO（本机演示摄像头）房间的结果不进结果展示——其原画面仍在实时画面卡照常展示；
//   · mock-vision-feed 的模拟上报（quality.det 前缀 "mock"）不是真实现场数据，不展示。
// 仅作用于展示端点（status/events）；上报接收、落盘与 Agent 工具口径不受影响。
const DEMO_LAB_ID = 'DEMO';

/** 展示过滤谓词（导出供单测）：真实 vision 侧上报的结果才进结果展示 */
export function isDisplayable(labId: string, det: string | null | undefined): boolean {
  return labId !== DEMO_LAB_ID && !(det ?? '').toLowerCase().startsWith('mock');
}

// ---- 登录态查询端点 ---------------------------------------------------------

function handleStatus(res: ServerResponse): void {
  const status = visionStatus();
  reply(res, 200, {
    ok: true,
    configured: visionIngestConfigured(),
    ...status,
    labs: status.labs.filter((lab) => isDisplayable(lab.labId, lab.det)),
    retentionNote: '事件 JSONL 保留最近 5MB；快照只保留各房间最新一张且不落盘'
  });
}

function handleEvents(query: URLSearchParams, res: ServerResponse): void {
  const labId = query.get('lab') ?? undefined;
  const limit = Number.parseInt(query.get('limit') ?? '50', 10);
  const sinceRaw = Number.parseInt(query.get('since') ?? '', 10);
  const events = visionEvents({
    labId,
    limit: Number.isFinite(limit) ? limit : 50,
    sinceEpochMs: Number.isFinite(sinceRaw) ? sinceRaw : undefined
  })
    .filter((event) => isDisplayable(event.lab_id, event.quality.det))
    .map((event) => {
      const feedback = visionEventFeedback(event.lab_id, event.receivedAt);
      return {
        labId: event.lab_id, ts: event.ts, receivedAt: event.receivedAt, alert: event.alert,
        count: event.count, recognized: event.faces ? event.faces.recognized : null,
        library: event.library,
        sceneState: event.sceneState, sceneReason: event.sceneReason,
        cameraOnline: event.camera_online,
        feedback: feedback ? { verdict: feedback.verdict, by: feedback.by, at: feedback.at } : null
      };
    });
  reply(res, 200, { ok: true, events });
}

/** POST /api/vision/feedback —— 人工核查回流（误报/确认）；登录身份，标注人取当前账号 */
function handleFeedback(req: IncomingMessage, res: ServerResponse): void {
  void readRawBody(req, 64 * 1024).then((body) => {
    if (!body.ok) {
      reply(res, body.status, { error: body.code, message: body.message });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.raw) as Record<string, unknown>;
    } catch {
      reply(res, 400, { error: 'bad_json', message: '请求体不是合法 JSON' });
      return;
    }
    const labId = typeof parsed['labId'] === 'string' ? parsed['labId'].slice(0, 64) : '';
    const receivedAt = Number(parsed['receivedAt']);
    const verdict = parsed['verdict'];
    if (!labId || !Number.isFinite(receivedAt) || (verdict !== 'false_alarm' && verdict !== 'confirmed')) {
      reply(res, 400, { error: 'bad_feedback', message: '需要 { labId, receivedAt, verdict: "false_alarm"|"confirmed" }' });
      return;
    }
    const actor = currentActor();
    // 标注人：native 模式 label=姓名/账号；demo 模式 label=角色名（SandboxActor.id 是哈希不可读）
    const result = recordVisionFeedback(labId, receivedAt, verdict, actor?.label ?? 'unknown');
    if (!result.ok) {
      reply(res, result.code === 'unknown_event' ? 404 : 400, { error: result.code, message: result.message });
      return;
    }
    reply(res, 200, { ok: true, feedback: result.feedback });
  });
}

function handleSnapshot(query: URLSearchParams, res: ServerResponse): void {
  const labId = query.get('lab') ?? '';
  const snapshot = visionSnapshot(labId);
  if (!snapshot) {
    reply(res, 404, { error: 'no_snapshot', message: '该房间暂无快照（边缘未上报，或部署形态为云端只见结论）' });
    return;
  }
  const buffer = Buffer.from(snapshot.base64, 'base64');
  res.writeHead(200, { 'Content-Type': snapshot.mime, 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
  res.end(buffer);
}

// ---- 内网画面：探活 + 同机代理 ----------------------------------------------

async function fetchLiveFeed(timeoutMs: number): Promise<Response | null> {
  try {
    const response = await fetch(LIVE_FEED_URL, {
      headers: LIVE_FEED_TOKEN ? { 'X-Vision-Token': LIVE_FEED_TOKEN } : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response;
  } catch {
    return null;
  }
}

async function handleLiveProbe(res: ServerResponse): Promise<void> {
  const response = await fetchLiveFeed(1500);
  const contentType = response?.headers.get('content-type') ?? '';
  const available = Boolean(response?.ok && contentType.includes('multipart'));
  // MJPEG 流不会结束：确认可用后立刻丢弃 body，只留探测结论
  if (response?.body) await response.body.cancel().catch(() => undefined);
  reply(res, 200, { ok: true, available, upstream: available ? 'reachable' : 'unreachable' });
}


/**
 * 实时画面识别结果（2026-11-14）
 * ---------------------------------------------------------------
 * 背景：卡片上的"人数/已录入/更新"过去只认**边缘上报**（ingest），
 * 一旦边缘没推、显示就是"离线"，但实际画面是通的（feed 能拉到）。
 * 这条端点补上"从**当前画面**现取一次识别结果"：抓 MJPEG 的一帧 →
 * 交给边缘视觉服务的 /api/count → 返回人数。15 秒内复用结果，避免每次刷新都推理。
 */
let liveCountCache: {
  at: number; count: number; room: string | null; sourceKind: string | null;
  inferFps: number | null; frameAgeMs: number | null; p95Ms: number | null;
} | null = null;
/** 实时事件流：人数变化就记一条（只来自 vision 侧，不看边缘上报历史） */
const liveEvents: Array<{ at: number; room: string | null; count: number; prev: number | null }> = [];
let lastLiveCount: number | null = null;

/**
 * 实时画面识别结果（2026-11-14 修正版）
 * ---------------------------------------------------------------
 * 上一版抓帧后调 /api/count（单帧重推理），与**画面上的检测框**不是同一套参数：
 * 同一帧 live 会话检出 23 人、单帧重推理只给 3 人，于是卡片数字与画面矛盾。
 * 现改为直接读边缘的 `/api/live/status`——那是画框的那个循环自己的结论
 * （count / counts / detected / frame_age_ms / infer_fps），与画面天然一致。
 */
async function handleLiveCount(res: ServerResponse): Promise<void> {
  const nowMs = Date.now();
  if (liveCountCache && nowMs - liveCountCache.at < 5000) {
    reply(res, 200, { ok: true, source: 'live', cached: true, ...liveCountCache, ageMs: nowMs - liveCountCache.at });
    return;
  }
  const base = LIVE_FEED_URL.replace(/\/live\/.*$/, '');
  const r = await fetch(base + '/api/live/status', { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!r || !r.ok) {
    reply(res, 502, { ok: false, error: 'vision_live_unreachable', message: '读不到边缘实时识别状态（画面可能未开始或服务未运行）' });
    return;
  }
  const st = (await r.json().catch(() => null)) as {
    running?: boolean; count?: number; detected?: number; counts?: Record<string, number>;
    infer_fps?: number; frame_age_ms?: number; p95_ms?: number;
    room?: string | null; source_kind?: string | null;
    error?: string | null; note?: string | null;
  } | null;
  if (!st) { reply(res, 502, { ok: false, error: 'bad_live_status', message: '边缘返回的实时状态不是 JSON' }); return; }
  if (st.running === false) {
    reply(res, 200, { ok: false, error: 'live_not_running', message: st.note || '实时识别未开始（请在实验室现场端启动）' });
    return;
  }
  const count = typeof st.count === 'number' ? st.count : typeof st.detected === 'number' ? st.detected : null;
  if (count === null) { reply(res, 502, { ok: false, error: 'bad_live_status', message: '实时状态里没有人数字段' }); return; }
  if (count !== lastLiveCount) {
    liveEvents.unshift({ at: nowMs, room: st.room ?? null, count, prev: lastLiveCount });
    if (liveEvents.length > 60) liveEvents.length = 60;
    lastLiveCount = count;
  }
  liveCountCache = {
    at: nowMs,
    count,
    room: st.room ?? null,
    sourceKind: st.source_kind ?? null,
    inferFps: typeof st.infer_fps === 'number' ? st.infer_fps : null,
    frameAgeMs: typeof st.frame_age_ms === 'number' ? st.frame_age_ms : null,
    p95Ms: typeof st.p95_ms === 'number' ? st.p95_ms : null
  };
  reply(res, 200, {
    ok: true, source: 'live', cached: false, ...liveCountCache, ageMs: 0,
    counts: st.counts ?? null,
    note: st.error ?? st.note ?? null
  });
}

async function handleFeed(res: ServerResponse): Promise<void> {
  // 超时 10s：live/start 后模型预热期（约 2s）内生成器不产帧、Werkzeug 不发响应头，
  // 4s 超时会在预热窗口内 502（2026-11-07 实测）——放宽到 10s 等过预热
  const upstream = await fetchLiveFeed(10000);
  if (!upstream || !upstream.ok || !upstream.body) {
    if (upstream) await upstream.body?.cancel().catch(() => undefined);
    reply(res, 502, { error: 'vision_feed_unreachable', message: '未探测到实验室内网视觉服务：画面留在实验室（边缘推理），云端只有结论 JSON' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });
  const stream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
  // ⚠️ 必须挂 error 监听：上游中断（Vision 服务重启/网络抖动/客户端断开）会让
  // fromWeb 流发 error 事件——Node 中未处理的 'error' 事件直接把进程带崩
  // （2026-11-07 两次 "exit code 1" 的根因，pipe 不会自动转发可读流错误）
  stream.on('error', (err) => {
    log.warn('vision_feed_stream_error', { message: err instanceof Error ? err.message : String(err) });
    res.destroy();
  });
  stream.pipe(res);
  res.on('close', () => {
    stream.destroy();
  });
}

// ---- 总分发 -----------------------------------------------------------------

export async function handleVisionApi(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
  if (pathname === '/api/vision/report') {
    if (req.method !== 'POST') {
      reply(res, 405, { error: 'method_not_allowed', message: '上报请用 POST' });
      return;
    }
    await handleReport(req, res);
    return;
  }
  if (pathname === '/api/vision/status' && req.method === 'GET') { handleStatus(res); return; }
  if (pathname === '/api/vision/events' && req.method === 'GET') { handleEvents(query, res); return; }
  if (pathname === '/api/vision/snapshot' && req.method === 'GET') { handleSnapshot(query, res); return; }
  if (pathname === '/api/vision/feedback' && req.method === 'POST') { handleFeedback(req, res); return; }
  if (pathname === '/api/vision/live-probe' && req.method === 'GET') { await handleLiveProbe(res); return; }
  if (pathname === '/api/vision/feed' && req.method === 'GET') { await handleFeed(res); return; }
  if (pathname === '/api/vision/live-count' && req.method === 'GET') { await handleLiveCount(res); return; }
  if (pathname === '/api/vision/live-events' && req.method === 'GET') {
    reply(res, 200, { ok: true, source: 'live', room: liveCountCache?.room ?? null, events: liveEvents });
    return;
  }
  reply(res, 404, { error: 'unknown_endpoint', message: `未实现的视觉接口：${req.method} ${pathname}` });
}
