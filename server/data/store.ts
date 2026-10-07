/**
 * 数据层 —— 脱敏快照 / 实时 / 模拟演示 三选一
 * ============================================================================
 *  与老系统的关系：**只读**。老系统继续跑，它的 state.json 是这里的"粮草"，
 *  本模块绝不写回、绝不连接老系统的写接口。
 *
 *  优先级：
 *    1. LIVE_DATA=1 且 LABOPS_LIVE_STATE 存在 → live（实时数据，读真实 state.json）
 *    2. seed/snapshot.json 存在                → snapshot（脱敏快照，默认）
 *    3. 否则                                   → demo（模拟演示，内置示例）
 *
 *  无论哪条路径，教师姓名都在**载入时**伪名化（live 路径也不例外）——
 *  也就是说真实姓名从不进入本进程的业务对象，更不会进日志或响应体。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { getConfig, PROJECT_ROOT } from '../config.ts';
import type { DataSourceType } from '../../shared/types.ts';
import { DATA_SOURCE_LABELS } from '../../shared/types.ts';
import type { TermConfig } from '../time/term.ts';
import { isValidDateString } from '../time/term.ts';

export interface LabRow {
  id: string;
  sortOrder: number;
  name: string;
  location: string;
  capacity: number;
  status: string;
  description: string;
  equipment?: string[];
}

export interface TimetableRow {
  id: string;
  term: string;
  classNames: string[];
  className: string;
  courseId: string;
  courseName: string;
  /** 已伪名化 */
  teacher: string;
  labId: string;
  labName: string;
  /** 0=周日 .. 6=周六 */
  weekday: number;
  periodKey: string;
  weeks: { from: number; to: number; parity: 'all' | 'odd' | 'even' };
  status: string;
  updatedAt: string;
}

export interface Dataset {
  sourceRevision?: string;
  contractVersion?: number;
  principal?: {username:string;identity:string;className:string};
  openLabStatus?:Record<string,string|{status:string;recordedAt?:string}>;
  openLabStatusMeta?:Record<string,{recordedAt:string}>;
  roomClosures?: Array<{id:string;roomId:string;roomName?:string;startDate:string;endDate:string;periodKeys:string[];status:string;reason:string}>;
  sourceType: DataSourceType;
  sourceLabel: string;
  /** 快照/演示文件的取证信息，直接进结果体的 provenance */
  meta: {
    sourceSha256Prefix?: string;
    snapshotAt?: string;
    sourceFileBasename?: string;
    note?: string;
  };
  term: TermConfig;
  labs: LabRow[];
  openLabs: LabRow[];
  scheduleAdjust?: Array<{id:string;date:string;timetableId:string;action:string;toLabId?:string;toPeriodKey?:string;status?:string}>;
  timetable: TimetableRow[];
  loadedAt: string;
  /** 载入时遇到的问题（不致命，但要能看见） */
  warnings: string[];
}

// ===========================================================================
//  教师伪名化（live 路径也必须走）
// ===========================================================================

export function pseudonymizeTeachers(rows: Array<Record<string, unknown>>): {
  rows: Array<Record<string, unknown>>;
  count: number;
} {
  const real = Array.from(
    new Set(rows.map((r) => String(r['teacher'] ?? '').trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const map = new Map(real.map((name, i) => [name, `教师T${String(i + 1).padStart(2, '0')}`]));
  const out = rows.map((r) => {
    const t = String(r['teacher'] ?? '').trim();
    return { ...r, teacher: t ? (map.get(t) ?? '教师T99') : '' };
  });
  return { rows: out, count: real.length };
}

// ===========================================================================
//  形状校验（宁可启动即失败，也不要拿错数据静默跑）
// ===========================================================================

const PARITY = new Set(['all', 'odd', 'even']);

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v);
}

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLab(raw: Record<string, unknown>, idx: number): LabRow {
  return {
    id: asString(raw['id'], `lab_${idx}`),
    sortOrder: asNumber(raw['sortOrder'], idx),
    name: asString(raw['name']).trim(),
    location: asString(raw['location']),
    capacity: asNumber(raw['capacity'], 0),
    status: asString(raw['status'], 'closed'),
    description: asString(raw['description']),
    equipment: Array.isArray(raw['equipment']) ? raw['equipment'].map(String) : undefined
  };
}

function normalizeTimetable(raw: Record<string, unknown>, idx: number): TimetableRow {
  const weeksRaw = (raw['weeks'] ?? {}) as Record<string, unknown>;
  let parity = asString(weeksRaw['parity'], 'all') as 'all' | 'odd' | 'even';
  if (!PARITY.has(parity)) parity = 'all';
  const classNames = Array.isArray(raw['classNames'])
    ? (raw['classNames'] as unknown[]).map((c) => asString(c).trim()).filter(Boolean)
    : [];
  const className = asString(raw['className']).trim();
  const list = classNames.length ? classNames : className ? [className] : [];
  return {
    id: asString(raw['id'], `tt_${idx}`),
    term: asString(raw['term']),
    classNames: list,
    className: className || list[0] || '',
    courseId: asString(raw['courseId']),
    courseName: asString(raw['courseName']).trim(),
    teacher: asString(raw['teacher']).trim(),
    labId: asString(raw['labId']),
    labName: asString(raw['labName']).trim(),
    weekday: asNumber(raw['weekday'], -1),
    periodKey: asString(raw['periodKey']).trim(),
    weeks: {
      from: asNumber(weeksRaw['from'], 1),
      to: asNumber(weeksRaw['to'], 99),
      parity
    },
    status: asString(raw['status'], 'normal'),
    updatedAt: asString(raw['updatedAt'])
  };
}

// ===========================================================================
//  载入
// ===========================================================================

function readJson(file: string): Record<string, unknown> {
  const buf = fs.readFileSync(file);
  return JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
}

export function buildFromSnapshotLike(
  parsed: Record<string, unknown>,
  sourceType: DataSourceType,
  filePath: string,
  extraWarnings: string[] = []
): Dataset {
  const warnings = [...extraWarnings];
  const rawLabs = (parsed['labs'] as Record<string, unknown>[]) ?? [];
  const rawOpen = (parsed['openLabs'] as Record<string, unknown>[]) ?? [];
  const rawTt = (parsed['timetable'] as Record<string, unknown>[]) ?? [];
  const meta = (parsed['meta'] as Record<string, unknown>) ?? {};
  const termRaw = (parsed['term'] as Record<string, unknown>) ?? {};

  if (!Array.isArray(rawLabs) || rawLabs.length === 0) warnings.push('labs 为空');
  if (!Array.isArray(rawTt)) warnings.push('timetable 不是数组，已按空处理');

  const { rows: ttRows, count: teacherCount } = pseudonymizeTeachers(rawTt);
  if (sourceType === 'live') warnings.push(`实时数据载入时伪名化了 ${teacherCount} 位教师姓名`);

  const term: TermConfig = {
    term: asString(termRaw['term']),
    termStart: isValidDateString(termRaw['termStart']) ? (termRaw['termStart'] as string) : null,
    // R09：termEnd 随数据契约提供；缺失时覆盖判断只能给 unknown
    termEnd: isValidDateString(termRaw['termEnd']) ? (termRaw['termEnd'] as string) : null,
    specialDays: Array.isArray(termRaw['specialDays']) ? termRaw['specialDays'] as TermConfig['specialDays'] : [],
    holidays: Array.isArray(termRaw['holidays']) ? (termRaw['holidays'] as unknown[]).map(String) : [],
    labMismatchPolicy: asString(termRaw['labMismatchPolicy'], 'warn')
  };
  if (!term.termStart) {
    warnings.push('termStart 缺失或非法 → 教学周不可确定，结果将不做周次过滤并如实声明');
  }

  const shaPrefix = asString(meta['sourceSha256Prefix']);
  const buf = filePath ? fs.statSync(filePath).size : Buffer.byteLength(JSON.stringify(parsed));

  return {
    sourceType,
    sourceRevision: asString(parsed['revision'], crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex')),
    contractVersion: asNumber(parsed['contractVersion'],1),
    principal: parsed['principal'] as Dataset['principal'],
    openLabStatus: parsed['openLabStatus'] as Dataset['openLabStatus']||{},
    openLabStatusMeta: parsed['openLabStatusMeta'] as Dataset['openLabStatusMeta']||{},
    roomClosures: Array.isArray(parsed['roomClosures']) ? parsed['roomClosures'] as Dataset['roomClosures'] : [],
    sourceLabel: DATA_SOURCE_LABELS[sourceType],
    meta: {
      ...(shaPrefix ? { sourceSha256Prefix: shaPrefix } : {}),
      ...(meta['generatedAt'] ? { snapshotAt: asString(meta['generatedAt']) } : {}),
      sourceFileBasename: asString(meta['sourceFileBasename'], filePath.split(/[\\/]/).pop() ?? ''),
      ...(meta['note'] ? { note: asString(meta['note']) } : {})
    },
    term,
    labs: rawLabs.map(normalizeLab),
    openLabs: rawOpen.map(normalizeLab),
    scheduleAdjust: Array.isArray(parsed['scheduleAdjust']) ? parsed['scheduleAdjust'] as Dataset['scheduleAdjust'] : [],
    timetable: ttRows.map(normalizeTimetable),
    loadedAt: new Date().toISOString(),
    warnings: [...warnings, `数据文件 ${Math.round(buf / 1024)} KB`]
  };
}

function buildFromLiveState(filePath: string): Dataset {
  const parsed = readJson(filePath);
  const st = ((parsed['state'] as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
  const cfg = (st['sysConfig'] as Record<string, unknown>) ?? {};
  // 把老系统的 state 形状映射成快照形状，后续路径完全一致
  return buildFromSnapshotLike(
    {
      meta: {
        sourceType: 'live',
        note: '实时数据：直接读取真实 state.json（本地/校内演示用，绝不出现在公开仓库）'
      },
      term: cfg,
      labs: st['labs'] ?? [],
      openLabs: st['openLabs'] ?? [],
      scheduleAdjust: st['scheduleAdjust'] ?? [],
      openLabStatus: st['openLabStatus']||{},
      openLabStatusMeta: st['openLabStatusMeta']||{},
      roomClosures: st['roomClosures'] ?? [],
      timetable: st['timetable'] ?? []
    },
    'live',
    filePath
  );
}

let cache: Dataset | null = null;
/** 缓存对应的源文件与 mtime —— 实时模式下底层 state.json 更新后必须重新载入 */
let cacheKey: { file: string; mtimeMs: number } | null = null;

/** 决定当前应使用的数据源文件；无可用文件时返回 null */
function resolveSourceFile(): { file: string; kind: 'live' | 'snapshot' | 'demo'; warnings: string[] } | null {
  const c = getConfig();
  if (c.data.live && fs.existsSync(c.data.liveStatePath)) {
    return { file: c.data.liveStatePath, kind: 'live', warnings: [] };
  }
  if (c.data.live && !fs.existsSync(c.data.liveStatePath)) {
    throw new Error('实时数据源不可用，已停止查询，不回落到历史快照');
  }
  if (fs.existsSync(c.data.snapshotPath)) {
    return { file: c.data.snapshotPath, kind: 'snapshot', warnings: [] };
  }
  if (fs.existsSync(c.data.fallbackDemoPath)) {
    return {
      file: c.data.fallbackDemoPath,
      kind: 'demo',
      warnings: ['未找到 seed/snapshot.json，已回落到内置示例数据（模拟演示）']
    };
  }
  return null;
}

function buildDataset(src: { file: string; kind: 'live' | 'snapshot' | 'demo'; warnings: string[] }): Dataset {
  if (src.kind === 'live') return buildFromLiveState(src.file);
  if (src.kind === 'snapshot') return buildFromSnapshotLike(readJson(src.file), 'snapshot', src.file);
  return buildFromSnapshotLike(readJson(src.file), 'demo', src.file, src.warnings);
}

export function loadDataset(force = false): Dataset {
  const src = resolveSourceFile();
  if (!src) {
    const c = getConfig();
    throw new Error(
      `没有任何可用数据文件。请先运行： npx tsx seed/make-snapshot.ts <真实 state.json 路径>   ` +
        `（已查找：${c.data.snapshotPath} 与 ${c.data.fallbackDemoPath}）`
    );
  }

  // 源文件被替换/更新（mtime 变化）→ 缓存失效并重建。实时模式尤其依赖这一点：
  // 否则服务长驻期间永远给旧数据，界面却标着"实时"。
  if (!force && cache && cacheKey && cacheKey.file === src.file && cacheKey.mtimeMs === fs.statSync(src.file).mtimeMs) {
    return cache;
  }
  cache = buildDataset(src);
  cacheKey = { file: src.file, mtimeMs: fs.statSync(src.file).mtimeMs };
  return cache;
}

/** 校验快照自带的指纹（仅用于启动日志的自证，不做阻断） */
export function verifySnapshotIntegrity(): string {
  const c = getConfig();
  const p = c.data.snapshotPath;
  if (!fs.existsSync(p)) return '（无快照文件）';
  const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  return `snapshot.json sha256(前16)=${sha}`;
}

export function projectRoot(): string {
  return PROJECT_ROOT;
}

// ===========================================================================
//  查询辅助
// ===========================================================================

/** 房间号归一化：全角转半角、转大写、去空格（用户可能输入 "e310" / "Ｅ310" / "E 310"） */
export function normalizeLabName(input: unknown): string {
  return String(input ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function findLab(ds: Dataset, input: unknown): LabRow | null {
  const key = normalizeLabName(input);
  if (!key) return null;
  return ds.labs.find((l) => normalizeLabName(l.name) === key) ?? null;
}

export function findOpenLab(ds: Dataset, input: unknown): LabRow | null {
  const key = normalizeLabName(input);
  if (!key) return null;
  return ds.openLabs.find((l) => normalizeLabName(l.name) === key) ?? null;
}
