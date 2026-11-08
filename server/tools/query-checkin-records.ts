/**
 * query_checkin_records / query_openlab_records / query_key_records —— 逐人明细类只读工具
 * ============================================================================
 *  背景（2026-11-08，用户明确要求开放）：
 *    此前逐人签到明细「不开放接口」，只给聚合与缺口。现在开放：
 *      · 逐人签到明细（含志愿者）：谁、何时、签入还是签出、按模板还是替班
 *      · 开放实验室签到签退：谁在何时进出开放实验室
 *      · 钥匙台账：哪把钥匙、在哪个柜、被谁借走
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

export const QUERY_CHECKIN_RECORDS_SPEC = {
  name: 'query_checkin_records',
  description:
    '查询**逐人签到明细**：某日（可按节次/类型过滤）每条签到签退记录的操作人、姓名、时间、节次，' +
    '以及这条记录是按周值班模板匹配（dutySource=roster）还是替班（substitute）。' +
    '仅管理员与志愿者可用；**学号已由服务端掩码**（如 2023****12），不要尝试还原或推测真实学号。' +
    '用户问「今天谁签到了」「这节谁值过班」「某人几点签的」时用本工具。' +
    '红线：明细只陈述事实，**不要据此定性旷课或代签**；缺勤需现场核实。' +
    '未连接主系统或上游报错时如实说明，不编造记录。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD，缺省为服务端当天（上海时区）' },
      periodKey: { type: 'string', enum: ['am1', 'am2', 'pm1', 'pm2', 'eve_ab', 'eve_cd'], description: '只看某一节次' },
      type: { type: 'string', enum: ['checkin', 'checkout'], description: '只看签到或只看签退' }
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
      type: asStr(args['type'])
    }, signal);
    const rows = (raw['records'] as unknown[]) || [];
    const day = String(raw['date'] || '');
    return {
      ok: true,
      resultKind: 'records',
      result: raw,
      summary: `${day} 共 ${rows.length} 条逐人签到记录（学号已掩码）`
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
    '仅管理员与志愿者可用；身份字段已由服务端掩码。' +
    '用户问「今天开放实验室谁来过」「E310 开放时段进出情况」时用本工具。' +
    '红线：明细只陈述事实，不做考勤定性；未连接主系统时如实说明，不编造。',
  parameters: {
    type: 'object',
    properties: {
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD，缺省为服务端当天' },
      labId: { type: 'string', description: '只看某个实验室房号，如 E310' },
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
