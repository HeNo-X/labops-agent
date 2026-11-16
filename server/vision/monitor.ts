/**
 * 视觉边缘上报 —— 数据面（不含 HTTP）
 * ============================================================================
 *  架构定位（对齐 Vision识别技术/docs/视觉接入LabOps-可行性分析与开发方向-20261026.md
 *  + 2026-10-30 用户裁定「场景识别只做底库匹配、PPE 废弃」）：
 *    · 摄像头是眼睛（边缘推理，画面与人脸永不出实验室局域网）；
 *    · 本模块是云端汇总层：只接收**剥离身份后的 JSON**。
 *      人脸只上报「已录入命中数 / 未知脸数」两个数量，姓名与特征永不出边缘机；
 *      底库命中的是物品/场景条目名（非个人信息），可上报。
 *    · Agent 与前端只消费这里的结构化事实；**视觉是线索不是结论**，
 *      二维码签到永远是主链，视觉只做辅助交叉验证。
 *
 *  契约 v2（schemas.report_payload v2 对齐；v1 载荷兼容接收）：
 *    { v:2, lab_id, ts, count, camera_online, capacity?,
 *      faces?:{recognized,unknown},          // 只有数量
 *      library?:[{kind,name,score,mode}],    // 物品/场景底库命中
 *      quality?:{det} }
 *    v1 的 ppe_summary 已随 10-30 裁定废弃：接收时忽略、不再存储、不再展示。
 *
 *  告警判定（云端按自己的数据判，边缘只报事实）：
 *    · count > capacity（边缘随报自己 rooms.json 的容量）；
 *    · camera_online=false。
 *    场景/物品命中是**事件**不是告警——是否异常由 Agent 与人判断。
 *
 *  安全：HMAC-SHA256（ts.nonce.body）+ ±300s 时间窗 + nonce 防重放；
 *  快照只存内存最新一张（≤200KB，须已在边缘脱敏）；事件 JSONL 落盘剥离身份。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.ts';

export const REPLAY_WINDOW_SECONDS = 300;
export const NONCE_TTL_MS = 10 * 60 * 1000;
export const MAX_SNAPSHOT_BYTES = 200 * 1024;
export const MAX_LABS = 64;
const MAX_EVENTS_PER_LAB = 200;
const MAX_GLOBAL_EVENTS = 600;
const MAX_LIBRARY_HITS = 20;
const PERSIST_DIR = path.join(PROJECT_ROOT, 'server', 'data', 'vision');
const PERSIST_FILE = path.join(PERSIST_DIR, 'events.jsonl');
const PERSIST_ROTATE_BYTES = 5 * 1024 * 1024;

/** 物品/场景底库命中（条目名非个人信息，可上报） */
export interface VisionLibraryHit {
  kind: string;
  name: string;
  score: number | null;
  mode: string | null;
}

/** 人脸识别的数量口径（姓名/特征永不出边缘机） */
export interface VisionFaces {
  recognized: number;
  unknown: number;
}

/** 上报载荷（已归一化，全部剥离身份）。v2 为主；v1 载荷由 coerce 兼容映射。 */
export interface VisionReport {
  v: 1 | 2;
  lab_id: string;
  ts: number;
  count: number;
  camera_online: boolean;
  capacity: number | null;
  faces: VisionFaces | null;
  library: VisionLibraryHit[];
  /** v1 兼容只读：旧载荷的 scene.state（底库匹配语义下为 library_match/library_miss） */
  sceneState: string | null;
  sceneReason: string | null;
  quality: { det: string | null };
}

export interface VisionEvent extends VisionReport {
  receivedAt: number;
  alert: boolean;
}

export interface VisionIngestMeta {
  snapshotBase64?: string;
  snapshotMime?: string;
  /** 测试/回放时置 false：只进内存，不写 JSONL */
  persist?: boolean;
  receivedAt?: number;
}

export interface LabSnapshot { mime: string; base64: string; ts: number; receivedAt: number }

export function getVisionSecret(): string {
  return process.env.VISION_INGEST_SECRET ?? '';
}

export function visionIngestConfigured(): boolean {
  return Boolean(getVisionSecret());
}

// ---------------------------------------------------------------------------
// 签名与重放
// ---------------------------------------------------------------------------

export type SignatureCheck =
  | { ok: true }
  | { ok: false; code: 'bad_signature' | 'stale_timestamp' | 'bad_nonce' | 'bad_timestamp' | 'replayed' };

const seenNonces = new Map<string, number>();

function pruneNonces(now: number): void {
  if (seenNonces.size < 1024) return;
  for (const [nonce, expiry] of seenNonces) {
    if (expiry <= now) seenNonces.delete(nonce);
  }
}

export function signVisionPayload(secret: string, ts: number, nonce: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${ts}.${nonce}.${rawBody}`).digest('hex');
}

export function verifyVisionSignature(secret: string, ts: unknown, nonce: unknown, rawBody: string, signature: unknown): SignatureCheck {
  if (!secret) return { ok: false, code: 'bad_signature' };
  const tsNum = typeof ts === 'string' || typeof ts === 'number' ? Number(ts) : NaN;
  if (!Number.isInteger(tsNum) || tsNum <= 0) return { ok: false, code: 'bad_timestamp' };
  if (Math.abs(Date.now() / 1000 - tsNum) > REPLAY_WINDOW_SECONDS) return { ok: false, code: 'stale_timestamp' };
  if (typeof nonce !== 'string' || !/^[a-f0-9]{8,64}$/i.test(nonce)) return { ok: false, code: 'bad_nonce' };
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return { ok: false, code: 'bad_signature' };
  const expected = signVisionPayload(secret, tsNum, nonce, rawBody);
  const a = Buffer.from(signature.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'bad_signature' };
  const now = Date.now();
  if (seenNonces.has(nonce)) return { ok: false, code: 'replayed' };
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  pruneNonces(now);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 载荷归一化（白名单剥离；v2 为主，v1 兼容）
// ---------------------------------------------------------------------------

function strOrNull(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed || null;
}

function intOrNull(value: unknown, min: number, max: number): number | null {
  // null/undefined 是"未提供"，不能落成 0（Number(null)===0 的 JS 坑会把
  // capacity:null 变成容量 0，进而 999>0 误报超容量告警）
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < min || i > max ? null : i;
}

export type CoerceResult =
  | { ok: true; value: VisionReport }
  | { ok: false; code: 'bad_payload'; message: string };

export function coerceVisionReport(raw: unknown): CoerceResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'bad_payload', message: '上报载荷必须是对象' };
  }
  const root = raw as Record<string, unknown>;
  const labId = strOrNull(root['lab_id'], 64);
  if (!labId || !/^[A-Za-z0-9_-]+$/.test(labId)) {
    return { ok: false, code: 'bad_payload', message: 'lab_id 缺失或含非法字符（仅允许字母数字下划线连字符）' };
  }
  const ts = intOrNull(root['ts'], 1, 4_102_444_800);
  if (ts === null) return { ok: false, code: 'bad_payload', message: 'ts 缺失或非法（unix 秒）' };
  const count = intOrNull(root['count'], 0, 100000) ?? 0;
  const version = root['v'] === 2 ? 2 : 1;

  // 人脸数量口径（v2）：只有数量，任何疑似姓名/特征字段都不在白名单里，天然剥离
  const facesRaw = (root['faces'] ?? null) as Record<string, unknown> | null;
  const faces: VisionFaces | null = facesRaw && typeof facesRaw === 'object'
    ? {
        recognized: intOrNull(facesRaw['recognized'], 0, 100000) ?? 0,
        unknown: intOrNull(facesRaw['unknown'], 0, 100000) ?? 0
      }
    : null;

  // 底库命中（v2）：物品/场景条目名 + 分数；数组截断到 20 条
  const libraryRaw = Array.isArray(root['library']) ? (root['library'] as unknown[]).slice(0, MAX_LIBRARY_HITS) : [];
  const library: VisionLibraryHit[] = libraryRaw.map((item) => {
    const hit = (item ?? {}) as Record<string, unknown>;
    const kind = strOrNull(hit['kind'], 16) ?? 'item';
    const scoreRaw = typeof hit['score'] === 'number' && Number.isFinite(hit['score']) ? hit['score'] : null;
    return {
      kind,
      name: strOrNull(hit['name'], 64) ?? '未知条目',
      score: scoreRaw !== null && scoreRaw >= 0 && scoreRaw <= 1e6 ? scoreRaw : null,
      mode: strOrNull(hit['mode'], 16)
    };
  }).filter((hit) => hit.name !== '未知条目' || hit.score !== null);

  // 容量（v2）：边缘随报自己 rooms.json 的口径，云端只用来判超容量
  const capacity = intOrNull(root['capacity'], 0, 100000);

  // v1 兼容：scene 字段透传（10-30 后边缘不再产出占用/着装语义，仅为旧端点保留）
  const sceneRaw = (root['scene'] ?? null) as Record<string, unknown> | null;

  const qualityRaw = (root['quality'] ?? {}) as Record<string, unknown>;

  const report: VisionReport = {
    v: version,
    lab_id: labId,
    ts,
    count,
    camera_online: root['camera_online'] !== false,
    capacity,
    faces,
    library,
    sceneState: sceneRaw ? strOrNull(sceneRaw['state'], 32) : null,
    sceneReason: sceneRaw ? strOrNull(sceneRaw['reason'], 300) : null,
    quality: { det: strOrNull(qualityRaw['det'], 32) }
  };
  return { ok: true, value: report };
}

/**
 * 告警判定（线索级，不是结论）：
 *   · 摄像头离线；· 人数超过边缘随报的容量。
 * 底库命中/人脸数量是**事件**不是告警——是否异常由 Agent 与人判断（防告警疲劳）。
 */
export function isAlertReport(report: VisionReport): boolean {
  if (!report.camera_online) return true;
  if (report.capacity !== null && report.count > report.capacity) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 存储（内存环 + JSONL 追加）
// ---------------------------------------------------------------------------

interface LabState {
  latest: VisionEvent;
  history: VisionEvent[];
  snapshot: LabSnapshot | null;
}

const labs = new Map<string, LabState>();
let globalEvents: VisionEvent[] = [];
let persistenceEnabled = true;

function alertEvent(report: VisionReport, receivedAt: number): VisionEvent {
  return { ...report, receivedAt, alert: isAlertReport(report) };
}

function appendPersisted(event: VisionEvent): void {
  if (!persistenceEnabled) return;
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    if (fs.existsSync(PERSIST_FILE) && fs.statSync(PERSIST_FILE).size > PERSIST_ROTATE_BYTES) {
      fs.renameSync(PERSIST_FILE, `${PERSIST_FILE}.1`);
    }
    const line = JSON.stringify({
      v: event.v, lab_id: event.lab_id, ts: event.ts, receivedAt: event.receivedAt, alert: event.alert,
      count: event.count, camera_online: event.camera_online, capacity: event.capacity,
      faces: event.faces, library: event.library,
      scene: event.sceneState ? { state: event.sceneState, reason: event.sceneReason } : null,
      quality: event.quality
    });
    fs.appendFileSync(PERSIST_FILE, line + '\n', 'utf8');
  } catch {
    // 持久化是尽力而为：磁盘故障不阻断上报链路（内存环仍在，查询不中断）
  }
}

function recordEvent(event: VisionEvent): void {
  let state = labs.get(event.lab_id);
  if (!state) {
    state = { latest: event, history: [], snapshot: null };
    labs.set(event.lab_id, state);
  }
  state.latest = event;
  state.history.push(event);
  if (state.history.length > MAX_EVENTS_PER_LAB) state.history.splice(0, state.history.length - MAX_EVENTS_PER_LAB);
  globalEvents.push(event);
  if (globalEvents.length > MAX_GLOBAL_EVENTS) globalEvents.splice(0, globalEvents.length - MAX_GLOBAL_EVENTS);
}

/** 重启恢复：回放 JSONL 尾部（不重复落盘）。失败静默——历史缺失好过启动失败。 */
function replayFromDisk(): void {
  if (!persistenceEnabled) return;
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const lines = fs.readFileSync(PERSIST_FILE, 'utf8').split('\n').filter(Boolean).slice(-500);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // v1 旧行与 v2 新行都走同一 coerce（v1 的 ppe_summary 会被白名单忽略）
        const coerced = coerceVisionReport(parsed);
        if (!coerced.ok) continue;
        recordEvent(alertEvent(coerced.value, Number(parsed['receivedAt']) || coerced.value.ts * 1000));
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 忽略 */ }
}
void replayFromDisk();

export type IngestResult =
  | { ok: true; event: VisionEvent; snapshotIgnored?: string }
  | { ok: false; code: 'lab_capacity' | 'bad_snapshot'; message: string };

export function ingestVisionReport(report: VisionReport, meta: VisionIngestMeta = {}): IngestResult {
  const receivedAt = meta.receivedAt ?? Date.now();
  if (!labs.has(report.lab_id) && labs.size >= MAX_LABS) {
    return { ok: false, code: 'lab_capacity', message: `接入房间已达上限 ${MAX_LABS}` };
  }

  let snapshotIgnored: string | undefined;
  const snapshot = meta.snapshotBase64;
  if (typeof snapshot === 'string' && snapshot.length > 16) {
    const mime = meta.snapshotMime === 'image/png' ? 'image/png' : 'image/jpeg';
    const bytes = Buffer.byteLength(snapshot, 'base64');
    if (bytes > MAX_SNAPSHOT_BYTES) snapshotIgnored = `snapshot too large (${bytes}B > ${MAX_SNAPSHOT_BYTES}B)`;
    else {
      let state = labs.get(report.lab_id);
      if (!state) { state = { latest: alertEvent(report, receivedAt), history: [], snapshot: null }; labs.set(report.lab_id, state); }
      state.snapshot = { mime, base64: snapshot, ts: report.ts, receivedAt };
    }
  }

  const event = alertEvent(report, receivedAt);
  recordEvent(event);
  appendPersisted(event);
  return { ok: true, event, snapshotIgnored };
}

// ---------------------------------------------------------------------------
// 查询（前端 /api/vision/* 与 Agent 工具共用这一层）
// ---------------------------------------------------------------------------

export interface VisionLabSummary {
  labId: string;
  online: boolean;
  lastSeenAt: string;
  lastSeenEpochMs: number;
  ageSeconds: number;
  count: number;
  capacity: number | null;
  recognized: number | null;
  unknownFaces: number | null;
  library: VisionLibraryHit[];
  sceneState: string | null;
  sceneReason: string | null;
  /** 上报来源标记（quality.det）：mock-vision-feed 的模拟上报为 "mock-*"，真实边缘为检测模型名 */
  det: string | null;
  alert: boolean;
  snapshotAvailable: boolean;
}

export function visionStatus(): { labs: VisionLabSummary[]; eventCount: number; generatedAt: string } {
  const now = Date.now();
  const summary: VisionLabSummary[] = [...labs.values()]
    .map((state) => ({
      labId: state.latest.lab_id,
      online: state.latest.camera_online && now - state.latest.receivedAt < 120_000,
      lastSeenAt: new Date(state.latest.receivedAt).toISOString(),
      lastSeenEpochMs: state.latest.receivedAt,
      ageSeconds: Math.max(0, Math.round((now - state.latest.receivedAt) / 1000)),
      count: state.latest.count,
      capacity: state.latest.capacity,
      recognized: state.latest.faces ? state.latest.faces.recognized : null,
      unknownFaces: state.latest.faces ? state.latest.faces.unknown : null,
      library: state.latest.library,
      sceneState: state.latest.sceneState,
      sceneReason: state.latest.sceneReason,
      det: state.latest.quality.det,
      alert: state.latest.alert,
      snapshotAvailable: Boolean(state.snapshot)
    }))
    .sort((a, b) => b.lastSeenEpochMs - a.lastSeenEpochMs);
  return { labs: summary, eventCount: globalEvents.length, generatedAt: new Date(now).toISOString() };
}

export function visionEvents(options: { labId?: string; limit?: number; sinceEpochMs?: number } = {}): VisionEvent[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const pool = options.labId ? labs.get(options.labId)?.history ?? [] : globalEvents;
  const filtered = options.sinceEpochMs ? pool.filter((event) => event.receivedAt > options.sinceEpochMs!) : pool;
  return filtered.slice(-limit).reverse();
}

export function visionSnapshot(labId: string): LabSnapshot | null {
  return labs.get(labId)?.snapshot ?? null;
}

// ---------------------------------------------------------------------------
// 人工核查反馈（批C：误报回流 = 免费标注数据；事件唯一键 labId:receivedAt）
// ---------------------------------------------------------------------------

export type VisionVerdict = 'false_alarm' | 'confirmed';

export interface VisionFeedback {
  labId: string;
  receivedAt: number;
  verdict: VisionVerdict;
  by: string;
  at: string;
}

const FEEDBACK_FILE = path.join(PERSIST_DIR, 'feedback.jsonl');
const feedbacks = new Map<string, VisionFeedback>();

function feedbackKey(labId: string, receivedAt: number): string {
  return `${labId}:${receivedAt}`;
}

/** 启动回放 feedback.jsonl 尾部（与事件 JSONL 同样的"尽力而为"策略） */
function replayFeedbackFromDisk(): void {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return;
    const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean).slice(-500);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as VisionFeedback;
        if (entry && entry.labId && typeof entry.receivedAt === 'number'
            && (entry.verdict === 'false_alarm' || entry.verdict === 'confirmed')) {
          feedbacks.set(feedbackKey(entry.labId, entry.receivedAt), entry);
        }
      } catch { /* 单行损坏跳过 */ }
    }
  } catch { /* 忽略 */ }
}
void replayFeedbackFromDisk();

export type FeedbackResult =
  | { ok: true; feedback: VisionFeedback }
  | { ok: false; code: 'unknown_event' | 'bad_verdict'; message: string };

/** 记录人工核查结论：事件必须真实存在（防对凭空事件标注） */
export function recordVisionFeedback(labId: string, receivedAt: number, verdict: VisionVerdict, by: string): FeedbackResult {
  const pool = labs.get(labId)?.history ?? [];
  if (!pool.some((event) => event.receivedAt === receivedAt)) {
    return { ok: false, code: 'unknown_event', message: `事件不存在或已滚出保留窗口：${labId}@${receivedAt}` };
  }
  const entry: VisionFeedback = {
    labId, receivedAt, verdict,
    by: String(by || '').slice(0, 64) || 'unknown',
    at: new Date().toISOString()
  };
  feedbacks.set(feedbackKey(labId, receivedAt), entry);
  if (persistenceEnabled) {
    try {
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
      fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* 尽力而为 */ }
  }
  return { ok: true, feedback: entry };
}

/** 房间级查询：该房间最近的人工核查结论（无则 null） */
export function visionFeedbackFor(labId: string): VisionFeedback | null {
  let latest: VisionFeedback | null = null;
  for (const entry of feedbacks.values()) {
    if (entry.labId !== labId) continue;
    if (!latest || entry.at > latest.at) latest = entry;
  }
  return latest;
}

/** 事件级查询（供 events 输出合并） */
export function visionEventFeedback(labId: string, receivedAt: number): VisionFeedback | null {
  return feedbacks.get(feedbackKey(labId, receivedAt)) ?? null;
}

export interface VisionFeedbackStats { falseAlarm: number; confirmed: number }

/** 房间级误报/确认统计（Agent 用：历史误报多的事件应降低置信） */
export function visionFeedbackStats(labId?: string): VisionFeedbackStats {
  let falseAlarm = 0;
  let confirmed = 0;
  for (const entry of feedbacks.values()) {
    if (labId && entry.labId !== labId) continue;
    if (entry.verdict === 'false_alarm') falseAlarm += 1;
    else confirmed += 1;
  }
  return { falseAlarm, confirmed };
}

/** 仅测试用 */
export function resetVisionStoreForTests(options: { persist?: boolean } = {}): void {
  labs.clear();
  globalEvents = [];
  seenNonces.clear();
  feedbacks.clear();
  persistenceEnabled = options.persist ?? false;
}
