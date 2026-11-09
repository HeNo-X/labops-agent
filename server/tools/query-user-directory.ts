/**
 * query_user_directory —— 名册与账号目录（整合方案批次3，2026-11-10）
 * ============================================================================
 *  主系统新增的只读端点 GET /user-directory（Pages/server/operations.js）：
 *    · 账号列表：username 已掩码（保留前 4 后 2）、姓名、身份、状态
 *    · 名册汇总：每班级人数（不回传逐条学号清单）
 *  隐私红线（服务端已强制，工具侧同样不得越）：
 *    · 不还原、不推测真实学号；电话与学院信息不出主系统
 *    · 仅管理员与志愿者可查（学生通道 403，工具如实转述）
 *  回答口径：目录只陈述"有哪些账号/什么状态/每班多少人"，
 *    不做人员定性；账号状态异常（禁用/待改密）如实说明，不解读原因。
 */
import { businessRequest } from '../business/bridge.ts';
import type { ToolExecution } from './registry.ts';

export const QUERY_USER_DIRECTORY_SPEC = {
  name: 'query_user_directory',
  description:
    '查询实验室系统的**账号目录与班级名册汇总**：有多少账号、各自的身份（管理员/志愿者/学生）与状态（正常/禁用/待改密），' +
    '以及每个班级登记的人数。**账号（学号）已由服务端掩码**（如 2023****12），不要尝试还原或推测真实学号；' +
    '电话与学院信息不在返回范围内。仅管理员与志愿者可用；学生查询会被主系统拒绝，如实转告即可。' +
    '用户问「系统里一共多少人」「有哪些志愿者账号」「XX班名册多少人」时用本工具；' +
    '目录只陈述事实，不要据此定性谁异常。未连接主系统或上游报错时如实说明，不编造。',
  parameters: {
    type: 'object',
    properties: {
      identity: { type: 'string', enum: ['admin', 'volunteer', 'student'], description: '只看某一身份的账号（可选）' },
      status: { type: 'string', enum: ['active', 'disabled', 'pending', 'password_change_required'], description: '只看某一状态（可选）' }
    },
    required: [],
    additionalProperties: false
  },
  danger: false
} as const;

export async function queryUserDirectory(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution> {
  try {
    const raw = (await businessRequest('/user-directory', 'GET', undefined, signal)) as Record<string, unknown>;
    const identity = typeof args['identity'] === 'string' ? args['identity'].trim() : '';
    const status = typeof args['status'] === 'string' ? args['status'].trim() : '';
    const all = Array.isArray(raw['accounts']) ? (raw['accounts'] as Array<Record<string, unknown>>) : [];
    const accounts = all.filter((a) => (!identity || a['identity'] === identity) && (!status || a['status'] === status));
    const roster = Array.isArray(raw['roster']) ? raw['roster'] : [];
    const scopeNote = identity || status
      ? `（已按${identity ? `身份 ${identity}` : ''}${identity && status ? '、' : ''}${status ? `状态 ${status}` : ''}过滤）`
      : '';
    return {
      ok: true,
      resultKind: 'records',
      result: { directory: true, total: accounts.length, accounts, roster, meta: raw['meta'] },
      summary: `账号目录：${accounts.length} 个账号${scopeNote}；班级名册 ${roster.length} 个班级（学号已掩码，名册只给人数）`
    };
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string };
    const code = e.code || (e.status === 403 ? 'forbidden' : 'business_unavailable');
    return {
      ok: false,
      code,
      message: e.message || '主系统不可用',
      suggestions: [],
      summary: code === 'forbidden'
        ? '没有查询账号目录的权限：仅管理员与志愿者可查，未返回任何数据。'
        : '未取得账号目录（未连接主系统或上游不可用），不作猜测。'
    };
  }
}
