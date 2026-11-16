/**
 * query_checkin_records / query_openlab_records / query_key_records —— 逐人明细类只读工具
 * ============================================================================
 *  三类逐人明细：
 *    · 逐人签到明细（含志愿者）：谁、何时、签入还是签出、按模板还是替班
 *    · 开放实验室签到签退：谁在何时进出开放实验室
 *    · 钥匙台账：哪把钥匙、在哪个柜、被谁借走
 *
 *  隐私口径（服务端强制，工具侧不重复实现）：
 *    · **学号/借用人一律掩码**（保留前 4 后 2），原值不出主系统
 *    · 仅管理员与志愿者可查全体；学生调这三个接口一律 403
 *    · 替班只作审计标注，签到主体仍是登录账号本人
 *
 *  红线：
 *    · 掩码是服务端给的，工具**不得**尝试"还原"或推断真实学号
 *    · 明细是行为数据，回答时只陈述事实，不做考勤定性（缺勤/旷课需现场核实）
 *    · 未连接主系统或上游报错时如实说明，不编造
 */

import { businessRequest } from '../business/bridge.ts';
import type { ToolExecution } from './registry.ts';

type Query = Record<string, string | undefined>;

/** 组装 GET 查询串（忽略空值） */
function qs(q: Query): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === 'string' && v.trim()) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v.trim()));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

async function getJson(path: string, q: Query, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return (await businessRequest(path + qs(q), 'GET', undefined, signal)) as Record<string, unknown>;
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function fail(err: unknown): ToolExecution {
  const e = err as { code?: string; status?: number; message?: string };
  const code = e.code || (e.status === 403 ? 'forbidden' : 'business_unavailable');
  return {
    ok: false,
    code,
    message: e.message || '主系统不可用',
    suggestions: [],
    summary:
      code === 'forbidden'
        ? '没有查询逐人明细的权限：仅管理员与志愿者可查，未返回任何数据。'
        : '未取得明细（未连接主系统或上游不可用），不作猜测。'
  };
}

// ============================== ① 逐人签到明细 ==============================

/**
 * 签到明细的输出格式：
 *   · 学生签到：**按班级分区**——开头「当前上课班级：X」，下一行「已签到学生：掩码学号」，
 *     多个班级依次分区；只列 type=checkin 的已签到记录；
 *   · 志愿者值班：只给**姓名**（不显示掩码账号）。
 * 掩码由主系统服务端完成（前 4 后 2），此处原样透传，不还原、不推断学号。
 */
export function formatCheckinRecordsText(raw: Record<string, unknown>): string {
  const scalar = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
  const date = scalar(raw["date"]);
  // 顶层 scope 决定整批口径（duty 行级也可能带 scope；两者都兜住）
  const topScope = scalar(raw["scope"]);
  const rows = Array.isArray(raw["records"]) ? (raw["records"] as unknown[]) : [];
  const empty = `**${date ? date + " " : ""}没有查到已签到记录。**`;
  if (!rows.length) return empty;
  const groups = new Map<string, string[]>();
  const duty: string[] = [];
  let shown = 0;
  let truncated = false;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const x = row as Record<string, unknown>;
    const isDuty = topScope === "duty" || (topScope !== "student" && scalar(x["scope"]) === "duty");
    if (isDuty) {
      const n = scalar(x["name"]);
      if (n && !duty.includes(n)) duty.push(n);
      continue;
    }
    const type = scalar(x["type"]);
    if (type && type !== "checkin") continue;
    const user = scalar(x["user"]) || scalar(x["username"]);
    if (!user) continue;
    shown += 1;
    if (shown > 50) { truncated = true; continue; }
    const cls = scalar(x["className"]);
    const arr = groups.get(cls) || [];
    if (!arr.includes(user)) arr.push(user);
    groups.set(cls, arr);
  }
  const lines: string[] = [];
  for (const [cls, users] of groups) {
    if (cls) lines.push(`当前上课班级：${cls}`);
    lines.push(`已签到学生：${users.join("、")}`);
    lines.push("");
  }
  if (duty.length) { lines.push(`值班志愿者：${duty.join("、")}`); lines.push(""); }
  if (!groups.size && !duty.length) return empty;
  if (truncated) lines.push("（仅列出前 50 位，如需完整名单请缩小查询范围。）");
  const text = lines.join("\n").trim();
  return date ? `${text}\n\n（${date}）` : text;
}

export const QUERY_CHECKIN_RECORDS_SPEC = {
  name: 'query_checkin_records',
  description:
    '查询**逐人签到明细**，三类签到是三张不同的表，先用 scope 分清：' +
    'scope=student 是**学生上机课签到**（checkin_records，有房间、有课表关联，返回姓名+掩码学号+节次+课程+班级）；' +
    'scope=duty 是**志愿者值班签到**（volunteer_records，只有节次，**不绑定房间**，含按模板/替班标注）；' +
    '开放实验室的进出记录不在本工具，走 query_openlab_records。缺省 scope=all 同时给两类并逐条标注。' +
    '口径常识：3 楼 E3xx 是学生上机的公共机房，问「某房间谁签到了」基本都是学生上机签到；志愿者值班不会在具体房间签到。' +
    '仅管理员与志愿者可用；**学号已由服务端掩码**（如 2023****12），不要尝试还原或推测真实学号。' +
    '用户问「今天谁签到了」「E310 下午有谁签到」「这节谁值过班」「某人几点签的」时用本工具。' +
    '红线：明细只陈述事实，**不要据此定性旷课或代签**；缺勤需现场核实。' +
    '未连接主系统或上游报错时如实说明，不编造记录。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD，缺省为服务端当天（上海时区）' },
      periodKey: { type: 'string', enum: ['am1', 'am2', 'pm1', 'pm2', 'eve_ab', 'eve_cd'], description: '只看某一节次' },
      type: { type: 'string', enum: ['checkin', 'checkout'], description: '只看签到或只看签退' },
      labId: { type: 'string', description: '只看某个房间：房号或主系统编号都可（如 E310）。**只能配 scope=student 或 all**；值班签到不绑房间，带房间查 duty 会被主系统拒。' },
      scope: { type: 'string', enum: ['student', 'duty', 'all'], description: 'student=学生上机签到；duty=志愿者值班台账；all=两者（缺省）。问的是某个房间就用 student。' }
    },
    required: [],
    additionalProperties: false
  },
  danger: false
} as const;

export async function queryCheckinRecords(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution> {
  try {
    const raw = await getJson('/checkin-records', {
      date: asStr(args['date']),
      periodKey: asStr(args['periodKey']),
      type: asStr(args['type']),
      labId: asStr(args['labId']),
      scope: asStr(args['scope'])
    }, signal);
    return {
      ok: true,
      resultKind: 'records',
      result: raw,
      summary: formatCheckinRecordsText(raw)
    };
  } catch (err) {
    return fail(err);
  }
}

// ============================ ② 开放实验室签到签退 ============================

export const QUERY_OPENLAB_RECORDS_SPEC = {
  name: 'query_openlab_records',
  description:
    '查询**开放实验室的签到/签退记录**：某日（可按实验室过滤）有哪些人签入签出、各在何时。' +
    '开放实验室（多为 5 楼 D5xx）记录的是**谁进了哪个房间**，与学生上机课签到、志愿者值班签到是三张不同的表。' +
    '仅管理员与志愿者可用；身份字段已由服务端掩码。' +
    '用户问「今天开放实验室谁来过」「D501 开放时段进出情况」时用本工具；' +
    '若某个房号同时登记为上机实验室与开放实验室（如 D517），服务端会按两处编号一并检索并如实注记。' +
    '红线：明细只陈述事实，不做考勤定性；未连接主系统时如实说明，不编造。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD，缺省为服务端当天' },
      labId: { type: 'string', description: '只看某个房间：房号或主系统编号都可（如 D501）' },
      type: { type: 'string', description: '可选，按记录类型过滤（如 checkin / checkout）' }
    },
    required: [],
    additionalProperties: false
  },
  danger: false
} as const;

export async function queryOpenlabRecords(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution> {
  try {
    const raw = await getJson('/openlab-records', {
      date: asStr(args['date']),
      labId: asStr(args['labId']),
      type: asStr(args['type'])
    }, signal);
    const rows = (raw['records'] as unknown[]) || [];
    return {
      ok: true,
      resultKind: 'records',
      result: raw,
      summary: `${String(raw['date'] || '')} 开放实验室共 ${rows.length} 条签到签退记录（身份已掩码）`
    };
  } catch (err) {
    return fail(err);
  }
}

// ================================ ③ 钥匙台账 ================================

export const QUERY_KEY_RECORDS_SPEC = {
  name: 'query_key_records',
  description:
    '查询**钥匙台账**：每把钥匙的名称、所属实验室、存放位置、当前借用人（已掩码）与备注，' +
    '并标出是否处于「被借走」状态（borrowed）。' +
    '仅管理员与志愿者可用。用户问「E310 钥匙在谁那」「哪些钥匙还没还」「钥匙柜里有什么」时用本工具。' +
    '红线：借用人已掩码，不要尝试还原；未连接主系统时如实说明，不编造。',
  parameters: {
    type: 'object',
    properties: {
      labId: { type: 'string', description: '只看某个实验室的钥匙，如 E310' },
      type: { type: 'string', description: '按钥匙类型过滤（如 student / openlab）' },
      holder: { type: 'string', description: '可选。按借用人过滤；可传掩码值原样查询' }
    },
    required: [],
    additionalProperties: false
  },
  danger: false
} as const;

export async function queryKeyRecords(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution> {
  try {
    const raw = await getJson('/key-records', {
      labId: asStr(args['labId']),
      type: asStr(args['type']),
      holder: asStr(args['holder'])
    }, signal);
    const keys = (raw['keys'] as unknown[]) || [];
    const borrowed = (keys as Array<Record<string, unknown>>).filter((k) => k && k['borrowed'] === true).length;
    return {
      ok: true,
      resultKind: 'records',
      result: raw,
      summary: `钥匙台账共 ${keys.length} 条，其中 ${borrowed} 把处于被借出状态（借用人已掩码）`
    };
  } catch (err) {
    return fail(err);
  }
}
