/**
 * apply_term_schedule —— 修改学期安排 / 志愿者周值班模板（LabOps **唯一写业务数据**的工具）
 * ============================================================================
 *  背景（2026-11-08）：
 *    此前这两个档案只能由管理员在后台编辑（`admin.html`），LabOps 只有
 *    `query_term_schedule` 可读。用户要求「LabOps 也能改」→ 本工具。
 *
 *  设计红线：
 *    · **写能力只有这一个工具**，且只碰 termSchedule / volunteerSchedule 两个顶层键；
 *      不提供任何其他业务写入口（其余工具一律 read / draft）。
 *    · 真正的权限与校验在**主系统** `POST /term-schedule`（唯一写入进程）：
 *        学期安排仅管理员；周值班模板管理员或志愿者；
 *        结构校验、revision 递增、updatedAt/updatedBy 审计、空对象覆盖 409 都在服务端。
 *      本工具只做**参数收敛与白名单**，绝不自行判定身份或伪造成功。
 *    · 补丁是**浅合并**：未提供的字段保持原值；但显式传空数组是合法的（清空课表）。
 *      **禁止传空对象**——会被主系统 409 拒绝（防止前端未加载完就覆盖已导入数据）。
 *    · 失败必须如实说失败，不得回「已修改」。
 */

import { businessRequest } from '../business/bridge.ts';
import type { ToolExecution } from './registry.ts';

/** 允许通过本工具修改的字段（白名单；其余键一律丢弃并记录，避免模型塞脏字段） */
const ALLOWED_KEYS = {
  term: ['term', 'weeks', 'sessions', 'cancelled', 'changes', 'overrides', 'notes', 'roomMeta'],
  roster: ['slots', 'notes', 'dutyRoom']
} as const;

const TARGET_LABEL: Record<string, string> = { term: '学期安排', roster: '周值班模板' };

export type ApplyTermScheduleResult = {
  target: 'term' | 'roster';
  revision: number;
  count: number;
  updatedBy: string;
  droppedKeys: string[];
};

export const APPLY_TERM_SCHEDULE_SPEC = {
  name: 'apply_term_schedule',
  description:
    '修改「学期实验排课档案」或「志愿者周值班模板」。**这是写操作，会真实改动主系统数据**，只在用户明确要求修改时调用。' +
    'target=term 改学期安排（仅管理员）；target=roster 改周值班模板（管理员或志愿者）。' +
    'patch 为浅合并补丁：只写用户要改的字段，未提供的保持原值；传空数组表示清空该列表。' +
    '改动会递增 revision 并记录 updatedBy/updatedAt，可在后台审计。' +
    '红线：用户没说清要改哪条/改成什么，先问清楚再调用，不要猜；' +
    '不要用本工具"整理"或"补全"用户没提的内容；失败时如实说失败，绝不声称已修改。' +
    '学期安排影响"今天有什么课"，值班模板影响"本节谁值班"，改错会直接影响签到判定，务必与用户确认后再调。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['term', 'roster'],
        description: 'term=学期实验排课档案（管理员）；roster=志愿者周值班模板（管理员或志愿者）'
      },
      patch: {
        type: 'object',
        description:
          '浅合并补丁。term 可用字段：term(学期名) / weeks(周次) / sessions(课时列表) / cancelled / changes / overrides / notes / roomMeta；' +
          'roster 可用字段：slots(周模板席位列表，每项含 weekday 1-7、slotCode、seat、name、vacant) / notes / dutyRoom。' +
          '禁止传空对象。',
        additionalProperties: true
      }
    },
    required: ['target', 'patch'],
    additionalProperties: false
  },
  danger: false
} as const;

function bad(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** 收敛参数：target 必须合法；patch 必须是非空纯对象；按 target 白名单过滤字段 */
export function coerceApplyTermScheduleArgs(raw: Record<string, unknown>): {
  target: 'term' | 'roster';
  patch: Record<string, unknown>;
  droppedKeys: string[];
} {
  const target = raw['target'];
  if (target !== 'term' && target !== 'roster') {
    bad('bad_target', `target 必须是 term 或 roster，收到：${String(target)}`);
  }
  const patch = raw['patch'];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    bad('bad_patch', 'patch 必须是一个对象（不能是数组/字符串/null）');
  }
  const entries = Object.entries(patch as Record<string, unknown>);
  if (!entries.length) {
    bad('empty_patch', '禁止用空对象补丁修改档案（会被主系统以 empty_overwrite 拒绝）');
  }
  const allowed = new Set<string>(ALLOWED_KEYS[target]);
  const kept: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  for (const [k, v] of entries) {
    if (allowed.has(k)) kept[k] = v;
    else droppedKeys.push(k);
  }
  if (!Object.keys(kept).length) {
    bad('no_effective_fields', `补丁里没有可修改字段（${target} 允许：${[...allowed].join(' / ')}）`);
  }
  return { target, patch: kept, droppedKeys };
}

export async function applyTermSchedule(
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolExecution> {
  try {
    const { target, patch, droppedKeys } = coerceApplyTermScheduleArgs(args);
    const payload = target === 'term' ? { termSchedule: patch } : { volunteerSchedule: patch };
    // 写请求固定打主系统 /term-schedule（唯一写入进程）；身份由服务端会话绑定，不来自模型参数
    const raw = (await businessRequest('/term-schedule', 'POST', payload, signal)) as Record<string, unknown>;
    const updated = (raw['updated'] as Record<string, Record<string, unknown>> | undefined) ?? {};
    const slot = updated[target === 'term' ? 'termSchedule' : 'volunteerSchedule'] ?? {};
    const result: ApplyTermScheduleResult = {
      target,
      revision: Number(slot['revision']) || 0,
      count: Number(target === 'term' ? slot['sessions'] : slot['slots']) || 0,
      updatedBy: String(raw['updatedBy'] ?? ''),
      droppedKeys
    };
    const label = TARGET_LABEL[target];
    const dropped = droppedKeys.length ? `（已忽略非白名单字段：${droppedKeys.join('、')}）` : '';
    return {
      ok: true,
      resultKind: 'term_schedule_applied',
      result,
      summary: `${label}已更新：revision=${result.revision}，当前 ${result.count} 条，操作者 ${result.updatedBy || '当前账号'}${dropped}`
    };
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string };
    const code = e.code || (e.status === 403 ? 'forbidden' : e.status === 409 ? 'empty_overwrite' : 'business_unavailable');
    return {
      ok: false,
      code,
      message: e.message || '主系统未接受本次修改',
      suggestions: [],
      summary:
        code === 'forbidden'
          ? '没有修改权限：学期安排仅管理员，周值班模板仅管理员或志愿者。未做任何改动。'
          : code === 'empty_overwrite'
            ? '被拒绝：已导入的档案不允许用空对象覆盖。未做任何改动。'
            : '修改未生效（未连接主系统或上游报错），不作"已修改"的表述。'
    };
  }
}
