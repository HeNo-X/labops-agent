/**
 * 实时画面识别状态 —— 边缘视觉服务「画框循环」自己的结论（数据面）
 * ============================================================================
 *  与 monitor.ts（边缘 HMAC 上报的事件环）是两条独立数据通路：
 *    · monitor.ts：边缘按契约上报的房间状态/事件（DEMO、E310、E312…）
 *    · 本模块：边缘视觉服务 /api/live/status 的实时识别人数与人数变化事件
 *      （E315 等现场摄像头房间在这里，监控面板「当前画面识别」「实时事件」读它）
 *  Agent 工具 query_vision_status 与 HTTP /api/vision/live-* 共用本模块，
 *  保证「监控面板看到的」与「Agent 说的」是同一份实时数据。
 *
 *  上一版抓帧调 /api/count（单帧重推理）与画面上的检测框不是同一套参数：
 *  同一帧 live 会话检出 23 人、单帧重推理只给 3 人，卡片数字与画面矛盾。
 *  现直接读 /api/live/status——画框循环自己的结论，与画面天然一致。
 */

export const LIVE_FEED_URL = (process.env.VISION_LIVE_FEED_URL || 'http://127.0.0.1:5000/live/video_feed').replace(/\/+$/, '');

export interface LiveSnapshot {
  at: number; count: number; room: string | null; sourceKind: string | null;
  inferFps: number | null; frameAgeMs: number | null; p95Ms: number | null;
  /** 画面是回放（历史录像）而非此刻现场——Agent 须据此区分「过去」与「现在」 */
  isPlayback: boolean;
  /** 回放时段（可读，如 "2026-11-14 10:27 ~ 10:40"）；非回放/解析不出为 null */
  playbackWindow: string | null;
}

export interface LiveReadResult {
  ok: boolean;
  error?: 'vision_live_unreachable' | 'bad_live_status' | 'live_not_running' | 'no_count';
  message?: string;
  cached?: boolean;
  snapshot?: LiveSnapshot;
  counts?: Record<string, number> | null;
  note?: string | null;
}

export interface LiveEvent { at: number; room: string | null; count: number; prev: number | null }

/** 海康回放时间参数（yyyymmddThhmmssZ）→ "YYYY-MM-DD HH:MM"（按上海时区字面呈现） */
function fmtPlaybackTime(raw: string | undefined | null): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})[Tt](\d{2})(\d{2})/.exec(raw ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null;
}

/** 回放判定：vision 侧 source_kind=playback，或源地址带海康回放参数 starttime= */
function parsePlayback(source: string | null | undefined, kind: string | null | undefined): { isPlayback: boolean; playbackWindow: string | null } {
  const s = (source ?? '');
  const isPlayback = kind === 'playback' || /starttime=/i.test(s);
  if (!isPlayback) return { isPlayback: false, playbackWindow: null };
  const start = fmtPlaybackTime(/starttime=(\d{8}[Tt]\d{6}[Zz]?)/i.exec(s)?.[1]);
  const end = fmtPlaybackTime(/endtime=(\d{8}[Tt]\d{6}[Zz]?)/i.exec(s)?.[1]);
  return { isPlayback: true, playbackWindow: start && end ? `${start} ~ ${end}` : start ? `${start} 起` : null };
}

let liveCountCache: LiveSnapshot | null = null;
/** 实时事件流：人数变化就记一条（只来自 vision 侧，不看边缘上报历史） */
const liveEvents: LiveEvent[] = [];
let lastLiveCount: number | null = null;

/** 读实时识别状态；5 秒内复用缓存（force=true 强制重读）。只读不写任何业务数据。 */
export async function readLiveStatus(force = false): Promise<LiveReadResult> {
  const nowMs = Date.now();
  if (!force && liveCountCache && nowMs - liveCountCache.at < 5000) {
    return { ok: true, cached: true, snapshot: liveCountCache, counts: null, note: null };
  }
  const base = LIVE_FEED_URL.replace(/\/live\/.*$/, '');
  const r = await fetch(base + '/api/live/status', { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!r || !r.ok) return { ok: false, error: 'vision_live_unreachable', message: '读不到边缘实时识别状态（画面可能未开始或服务未运行）' };
  const st = (await r.json().catch(() => null)) as {
    running?: boolean; count?: number; detected?: number; counts?: Record<string, number>;
    infer_fps?: number; frame_age_ms?: number; p95_ms?: number;
    room?: string | null; source?: string | null; source_kind?: string | null;
    error?: string | null; note?: string | null;
  } | null;
  if (!st) return { ok: false, error: 'bad_live_status', message: '边缘返回的实时状态不是 JSON' };
  if (st.running === false) return { ok: true, error: 'live_not_running', message: st.note || '实时识别未开始（请在实验室现场端启动）' };
  const count = typeof st.count === 'number' ? st.count : typeof st.detected === 'number' ? st.detected : null;
  if (count === null) return { ok: false, error: 'no_count', message: '实时状态里没有人数字段' };
  if (count !== lastLiveCount) {
    liveEvents.unshift({ at: nowMs, room: st.room ?? null, count, prev: lastLiveCount });
    if (liveEvents.length > 60) liveEvents.length = 60;
    lastLiveCount = count;
  }
  const playback = parsePlayback(st.source, st.source_kind);
  liveCountCache = {
    at: nowMs,
    count,
    room: st.room ?? null,
    sourceKind: st.source_kind ?? null,
    inferFps: typeof st.infer_fps === 'number' ? st.infer_fps : null,
    frameAgeMs: typeof st.frame_age_ms === 'number' ? st.frame_age_ms : null,
    p95Ms: typeof st.p95_ms === 'number' ? st.p95_ms : null,
    ...playback
  };
  return { ok: true, cached: false, snapshot: liveCountCache, counts: st.counts ?? null, note: st.error ?? st.note ?? null };
}

/** 最近人数变化事件（新在前） */
export function liveEventList(limit = 20): LiveEvent[] {
  return liveEvents.slice(0, limit);
}

/** 最近一次实时识别所在房间（供 /api/vision/live-events 等透出） */
export function liveRoom(): string | null {
  return liveCountCache?.room ?? null;
}
