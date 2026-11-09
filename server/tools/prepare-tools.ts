import { effectiveSchedule } from '../data/calendar.ts';
/**
 * ops.v1 准备类工具（任务书 P1 首批：F01 报修 / F02 停用 / F03 通知 / F06 值班 / F10 日报）
 * ============================================================================
 *  纪律（任务书 §11.2）：
 *   · prepare 只做"理解 + 校验 + 落提案"——绝不执行业务写操作；
 *     实际提交只经受权 UI 的决策端点（executor.decideOnProposal），模型无权调用。
 *   · 任务与提案由服务端在这里创建（持久化），提案载荷只存服务端；
 *     返回给模型/前端的 Proposal 不含可执行参数本体（payloadView 仅展示）。
 *   · 身份一律取 ctx.actor（服务端注入）；args 里的任何身份字段不采信。
 *   · 数据缺失如实标注：沙盒没有名册/签到/钥匙数据，绝不编造 recipientCount
 *     或"在室人数"；缺依赖进 missingDependencies，不阻塞草稿。
 */

import { createHash } from 'node:crypto';
import type {
  EffectPreview,
  Proposal,
  SandboxActor,
  SandboxDutySession,
  TaskRecord
} from '../../shared/operations-contract.ts';
import { SANDBOX_ROLE_LABELS } from '../../shared/operations-contract.ts';
import type { OperationsReportResult } from '../../shared/types.ts';
import { normalizeLabName } from '../data/store.ts';
import {
  addDays,
  daysBetween,
  isValidDateString,
  serverNow
} from '../time/term.ts';
import { PERIODS, PERIOD_KEYS, isPeriodKey } from '../../shared/periods.ts';
import type { PeriodKey } from '../../shared/periods.ts';
import {
  createOpsProposal,
  createOpsTask,
  getDb,
  listBizIssues
} from '../persistence/db.ts';
import { actorHasCapability, type Capability } from '../operations/identity.ts';
import { availableRoomNames } from './query-schedule.ts';
import type { ToolContext, ToolExecution } from './registry.ts';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function periodLabel(key: string): string {
  return PERIODS.find((p) => p.key === key)?.label ?? key;
}

function periodTime(key: string): string {
  const p = PERIODS.find((x) => x.key === key);
  return p ? `${p.start}-${p.end}` : key;
}

/** ops 工具的结构化失败（可恢复：模型/用户按 message 修正后重试） */
export class OpsToolError extends Error {
  readonly code: string;
  readonly suggestions: string[];

  constructor(code: string, message: string, suggestions: string[] = []) {
    super(message);
    this.name = 'OpsToolError';
    this.code = code;
    this.suggestions = suggestions;
  }
}

function fail(err: OpsToolError): ToolExecution {
  return {
    ok: false,
    code: err.code,
    message: err.message,
    suggestions: err.suggestions,
    summary: err.suggestions.length ? `${err.message}（可选：${err.suggestions.slice(0, 8).join('、')}）` : err.message
  };
}

/** 严格取字符串参数：缺失/空 → null；类型非法 → 报错（不静默放宽，沿用 R10 纪律） */
function strArg(args: Record<string, unknown>, key: string, opts: { required?: boolean } = {}): string | null {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw new OpsToolError('missing_argument', `缺少必填参数 ${key}`);
    return null;
  }
  if (typeof v !== 'string') throw new OpsToolError('bad_argument', `参数 ${key} 必须是字符串，收到：${typeof v}`);
  const t = v.trim();
  if (!t && opts.required) throw new OpsToolError('missing_argument', `参数 ${key} 不能为空`);
  return t || null;
}

function boolArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'boolean') throw new OpsToolError('bad_argument', `参数 ${key} 必须是布尔值，收到：${typeof v}`);
  return v;
}

/** 校验并收敛房间号（与只读工具同一口径：数据集房间号，如 E310） */
function resolveRoom(ctx: ToolContext, raw: string | null): string {
  if (!raw) throw new OpsToolError('missing_room', '缺少房间号（roomId，例如 E310）');
  const known = availableRoomNames(ctx.dataset);
  const hit = known.find((n) => normalizeLabName(n) === normalizeLabName(raw));
  if (!hit) {
    throw new OpsToolError('lab_not_found', `系统里没有房间号「${raw}」`, known);
  }
  return hit;
}

function requireActor(ctx: ToolContext): SandboxActor {
  if (!ctx.actor) throw new OpsToolError('no_actor', '服务端未注入演示身份，无法准备业务操作');
  return ctx.actor;
}

function evidenceOf(ctx: ToolContext, coverage: string): Proposal['evidence'] {
  return [
    {
      sourceType: ctx.dataset.sourceType,
      sourceLabel: ctx.dataset.sourceLabel,
      queryTime: ctx.now.iso,
      timezone: 'Asia/Shanghai',
      coverage
    }
  ];
}

function capabilityCheck(ctx: ToolContext, caps: Capability[]): { canExecute: boolean; reason: string | null; required: string[] } {
  const actor = requireActor(ctx);
  const lacking = caps.filter((c) => !actorHasCapability(actor, c));
  return {
    canExecute: lacking.length === 0,
    reason: lacking.length
      ? `当前演示身份（${SANDBOX_ROLE_LABELS[actor.role]}）缺少能力：${lacking.join('、')}。可在左侧切换演示视角后重新确认。`
      : null,
    required: caps
  };
}

interface PrepareCommon {
  ctx: ToolContext;
  kind: TaskRecord['kind'];
  goal: string;
  actionType: string;
  payload: Record<string, unknown>;
  payloadKind: Proposal['payloadKind'];
  payloadView: Record<string, unknown>;
  title: string;
  summary: string;
  effects: EffectPreview[];
  missingDependencies: string[];
  caps: Capability[];
  evidence: Proposal['evidence'];
}

/** 落任务 + 提案（服务端持久化），返回给前端/模型的 ProposalOutput 结果 */
function persistAndReturn(c: PrepareCommon): ToolExecution {
  const actor = requireActor(c.ctx);
  const chk = capabilityCheck(c.ctx, c.caps);
  const task = createOpsTask({ kind: c.kind, goal: c.goal, actor, conversationId: c.ctx.conversationId ?? null });
  const payloadHash = sha256Hex(JSON.stringify({ actionType: c.actionType, payload: c.payload }));
  const proposal = createOpsProposal({
    taskId: task.taskId,
    actionType: c.actionType,
    payload: c.payload,
    payloadHash,
    environment: 'sandbox',
    title: c.title,
    summary: c.summary,
    effects: c.effects,
    missingDependencies: c.missingDependencies,
    requiredCapabilities: c.caps,
    evidence: c.evidence,
    payloadKind: c.payloadKind,
    payloadView: c.payloadView,
    canExecute: chk.canExecute,
    cannotExecuteReason: chk.reason
  });
  const envLabel = '沙盒演示环境（不产生真实业务影响）';
  return {
    ok: true,
    resultKind: 'operation_proposal',
    result: proposal,
    summary: `已生成办理单「${c.title}」，等待用户在提案卡中确认后于${envLabel}执行`
  };
}

// ===========================================================================
//  F01 prepare_issue_ticket —— 巡检与报修
// ===========================================================================

const ISSUE_CATEGORIES = ['equipment', 'environment', 'network', 'door_window_lighting', 'other'] as const;
const ISSUE_CATEGORY_LABELS: Record<string, string> = {
  equipment: '设备故障',
  environment: '环境卫生',
  network: '网络问题',
  door_window_lighting: '门窗照明',
  other: '其他'
};

export async function runPrepareIssueTicket(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const roomId = resolveRoom(ctx, strArg(args, 'roomId', { required: true }));
    const category = strArg(args, 'category', { required: true })!;
    if (!(ISSUE_CATEGORIES as readonly string[]).includes(category)) {
      throw new OpsToolError('bad_category', `category 必须是：${ISSUE_CATEGORIES.join(' / ')}`);
    }
    const description = strArg(args, 'description', { required: true })!;
    if (description.length > 2000) throw new OpsToolError('bad_description', 'description 最长 2000 字');
    let attachmentIds: string[] = [];
    const rawAtt = args['attachmentIds'];
    if (rawAtt !== undefined && rawAtt !== null && rawAtt !== '') {
      if (!Array.isArray(rawAtt) || rawAtt.some((x) => typeof x !== 'string')) {
        throw new OpsToolError('bad_argument', 'attachmentIds 必须是字符串数组');
      }
      attachmentIds = (rawAtt as string[]).slice(0, 8);
    }

    // 同房间未结工单提示（防重复报修的准备侧支持；最终判定在业务侧）
    const openIssues = listBizIssues({ roomId, status: 'open', actorId:requireActor(ctx).id });
    const missingDeps = attachmentIds.length
      ? ['附件上传服务未接入：attachmentIds 仅登记引用，不会保存文件内容']
      : [];

    const catLabel = ISSUE_CATEGORY_LABELS[category] ?? category;
    const goal = `报修 ${roomId}（${catLabel}）`;
    const summary =
      `为 ${roomId} 创建${catLabel}报修工单。` +
      (openIssues.length ? `注意：该房间当前有 ${openIssues.length} 张未结工单，如属同一问题建议关联而非重复建单。` : '') +
      (missingDeps.length ? ` ${missingDeps[0]}` : '');

    return persistAndReturn({
      ctx,
      kind: 'issue',
      goal,
      actionType: 'issue.create',
      payload: { roomId, category, description, attachmentRefs: attachmentIds },
      payloadKind: 'issue',
      payloadView: { roomId, category, categoryLabel: catLabel, description, attachmentIds },
      title: `报修工单 · ${roomId} · ${catLabel}`,
      summary,
      effects: [
        {
          label: `创建报修工单（${roomId} · ${catLabel}）`,
          objectType: 'issue',
          objectId: null,
          before: null,
          after: description.slice(0, 160)
        }
      ],
      missingDependencies: missingDeps,
      caps: ['issue:create:self'],
      evidence: evidenceOf(ctx, `房间档案与房间号白名单来自${ctx.dataset.sourceLabel}`)
    });
  } catch (err) {
    if (err instanceof OpsToolError) return fail(err);
    return fail(new OpsToolError('tool_internal_error', `准备报修单失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

// ===========================================================================
//  F02 prepare_room_closure —— 临时停用（可联动建单 + 通知）
// ===========================================================================

const MAX_CLOSURE_DAYS = 14;

export async function runPrepareRoomClosure(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const roomId = resolveRoom(ctx, strArg(args, 'roomId', { required: true }));
    const startDate = strArg(args, 'startDate', { required: true })!;
    const endDate = strArg(args, 'endDate', { required: true })!;
    if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
      throw new OpsToolError('bad_date', 'startDate/endDate 必须是合法日期（YYYY-MM-DD）');
    }
    if (daysBetween(startDate, endDate) < 0) throw new OpsToolError('bad_range', 'endDate 不能早于 startDate');
    if (daysBetween(startDate, endDate) + 1 > MAX_CLOSURE_DAYS) {
      throw new OpsToolError('bad_range', `停用范围一次最长 ${MAX_CLOSURE_DAYS} 天；更长范围请分期办理`);
    }
    const rawPeriods = args['periodKeys'];
    if (!Array.isArray(rawPeriods) || !rawPeriods.length) {
      throw new OpsToolError('missing_period', 'periodKeys 必须是非空节次数组（如 ["pm1","pm2"]）');
    }
    if (rawPeriods.some((p) => !isPeriodKey(p))) {
      throw new OpsToolError('bad_period', `periodKeys 含非法节次（合法值：${PERIOD_KEYS.join(' / ')}）`);
    }
    const periodKeys = [...new Set(rawPeriods as PeriodKey[])].sort(
      (a, b) => PERIOD_KEYS.indexOf(a) - PERIOD_KEYS.indexOf(b)
    );
    const reason = strArg(args, 'reason', { required: true })!;
    const createIssue = boolArg(args, 'createIssue', true);
    const prepareNotice = boolArg(args, 'prepareNotice', false);

    // ---- 受影响排课：服务端按教学周口径计算，数量必须可追溯 ----
    const termStart = ctx.dataset.term.termStart ?? null;
    const weekDeterminable = Boolean(termStart);
    const affected: Array<{ date: string; courseName: string; className: string; periodKey: PeriodKey }> = [];
    const classNames = new Set<string>();
    for (let d = startDate; daysBetween(d, endDate) >= 0; d = addDays(d, 1)) {

      for (const row of effectiveSchedule(ctx.dataset,d)) {
        if (normalizeLabName(row.labName) !== normalizeLabName(roomId)) continue;

        // TimetableRow.periodKey 在数据层是 string；此处已由 isPeriodKey 白名单收敛，可安全收窄
        if (!isPeriodKey(row.periodKey)) continue;
        if (!periodKeys.includes(row.periodKey)) continue;

        affected.push({ date: d, courseName: row.courseName, className: row.className, periodKey: row.periodKey });
        row.classNames.forEach((c) => classNames.add(c));

      }
    }
    const notes: string[] = [];
    if (!weekDeterminable) notes.push('学期起始日未配置：受影响课次按全部周次统计（未做周次过滤）');

    const periodText = periodKeys.map((k) => `${periodLabel(k)}（${periodTime(k)}）`).join('、');
    const rangeText = startDate === endDate ? startDate : `${startDate} 至 ${endDate}`;
    const affectedLabel = `${affected.length} 条排课${classNames.size ? `，涉及班级：${[...classNames].slice(0, 6).join('、')}${classNames.size > 6 ? ' 等' : ''}` : ''}`;

    const noticeTitle = `实验室临时停用通知 · ${roomId}`;
    const noticeContent =
      `${roomId} 将于 ${rangeText} 的 ${periodText} 停用检修（原因：${reason}）。` +
      `受影响排课 ${affectedLabel}。请相关师生调整安排；开放实验时段同步暂停。` +
      `（沙盒演示通知，不产生真实发布）`;

    const chk = capabilityCheck(ctx, ['availability:write']);
    const goal = `停用 ${roomId}（${rangeText} ${periodKeys.map(periodLabel).join('/')}）`;
    const summary =
      `将 ${roomId} 在 ${rangeText} 的 ${periodText} 登记为停用（覆盖层，不改房间档案），影响 ${affectedLabel}。` +
      (createIssue ? '同时创建维修工单。' : '') +
      (prepareNotice ? '并生成受影响通知草稿，一并发布。' : '') +
      (chk.canExecute ? '' : ` ${chk.reason}`);

    const effects: EffectPreview[] = [
      {
        label: `登记停用（${roomId} · ${rangeText} · ${periodKeys.map(periodLabel).join('/')}）`,
        objectType: 'closure',
        objectId: null,
        before: '房间可用状态：正常',
        after: `停用生效（覆盖 ${affected.length} 条排课时段）`
      }
    ];
    if (createIssue) {
      effects.push({ label: `创建维修工单（${roomId}）`, objectType: 'issue', objectId: null, before: null, after: reason.slice(0, 160) });
    }
    if (prepareNotice) {
      effects.push({ label: '发布受影响通知（站内）', objectType: 'notification', objectId: null, before: null, after: noticeTitle });
    }

    return persistAndReturn({
      ctx,
      kind: 'closure',
      goal,
      actionType: 'room_closure.create',
      payload: {
        roomId,
        startDate,
        endDate,
        periodKeys,
        reason,
        affectedLessons: affected.length,
        createIssue,
        issueCategory: 'equipment',
        issueDescription: `${roomId} 停用检修：${reason}（范围 ${rangeText} ${periodText}）`,
        prepareNotice,
        noticeTitle,
        noticeContent,
        noticeAudienceSummary: classNames.size ? `受影响班级：${[...classNames].slice(0, 10).join('、')}` : '受影响师生（按停用范围推算）'
      },
      payloadKind: 'closure',
      payloadView: {
        roomId,
        startDate,
        endDate,
        periodKeys,
        periodLabels: periodKeys.map(periodLabel),
        reason,
        affectedLessons: affected.length,
        affectedClassNames: [...classNames].slice(0, 10),
        affectedSamples: affected.slice(0, 8).map((a) => `${a.date} ${periodLabel(a.periodKey)} 《${a.courseName}》 ${a.className}`),
        createIssue,
        prepareNotice,
        noticePreview: prepareNotice ? { title: noticeTitle, content: noticeContent } : null,
        notes
      },
      title: `临时停用 · ${roomId} · ${rangeText}`,
      summary,
      effects,
      missingDependencies: ['生产业务接口未接入：停用仅在沙盒生效，老系统页面不会感知'],
      caps: ['availability:write'],
      evidence: evidenceOf(ctx, `课表来源${ctx.dataset.sourceLabel}；受影响课次按服务端教学周口径计算`)
    });
  } catch (err) {
    if (err instanceof OpsToolError) return fail(err);
    return fail(new OpsToolError('tool_internal_error', `准备停用计划失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

// ===========================================================================
//  F02b prepare_room_status —— 开门/关门（即时门禁/开放状态，区别于长周期停用）
// ===========================================================================

export async function runPrepareRoomStatus(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const roomId = resolveRoom(ctx, strArg(args, 'roomId', { required: true }));
    const status = strArg(args, 'status', { required: true })!;
    if (status !== 'active' && status !== 'closed') {
      throw new OpsToolError('bad_status', 'status 必须是 active（开门）/ closed（关门）');
    }
    const label = status === 'active' ? '开门' : '关门';
    return persistAndReturn({
      ctx,
      kind: 'room_status',
      goal: `${label} ${roomId}`,
      actionType: 'room_status.update',
      payload: { roomId, status },
      payloadKind: 'room_status',
      payloadView: { roomId, status, statusLabel: label },
      title: `${label} · ${roomId}`,
      summary:
        `登记 ${roomId} 为${label}状态（覆盖层，不改房间档案）；这是人员登记的开放状态，不是门禁传感器读数。`,
      effects: [
        {
          label: `${label}（${roomId}）`,
          objectType: 'room_status',
          objectId: null,
          before: null,
          after: label
        }
      ],
      missingDependencies: ['生产业务接口未接入：开门/关门仅在沙盒生效，老系统页面不会感知'],
      caps: ['availability:write'],
      evidence: evidenceOf(ctx, `房间号白名单来自${ctx.dataset.sourceLabel}`)
    });
  } catch (err) {
    if (err instanceof OpsToolError) return fail(err);
    return fail(new OpsToolError('tool_internal_error', `准备开门/关门单失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

// ===========================================================================
//  F03 prepare_notification —— 定向通知（站内）
// ===========================================================================

export async function runPrepareNotification(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const title = strArg(args, 'title', { required: true })!;
    const content = strArg(args, 'content', { required: true })!;
    if (title.length > 120) throw new OpsToolError('bad_title', 'title 最长 120 字');
    if (content.length > 2000) throw new OpsToolError('bad_content', 'content 最长 2000 字');
    const levelRaw = strArg(args, 'level', { required: true })!;
    if (!['info', 'warning', 'urgent'].includes(levelRaw)) {
      throw new OpsToolError('bad_level', 'level 必须是 info / warning / urgent');
    }

    const audience = args['audience'];
    if (!audience || typeof audience !== 'object') {
      throw new OpsToolError('bad_audience', 'audience 必须是对象（kind = role_scope / all / class_ids）');
    }
    const a = audience as Record<string, unknown>;
    const kind = strArg(a, 'kind', { required: true })!;
    let audienceSummary: string;
    if (kind === 'all') {
      audienceSummary = '全体演示用户（沙盒广播）';
    } else if (kind === 'role_scope') {
      const role = strArg(a, 'role', { required: true })!;
      if (role !== 'student' && role !== 'volunteer') {
        throw new OpsToolError('bad_audience', 'role_scope 的 role 必须是 student / volunteer');
      }
      audienceSummary = `全部演示${role === 'student' ? '学生' : '志愿者'}`;
    } else if (kind === 'class_ids') {
      const ids = a['classIds'];
      if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string')) {
        throw new OpsToolError('bad_audience', 'class_ids 必须携带非空的 classIds 字符串数组');
      }
      const known = [...new Set(ctx.dataset.timetable.map((r) => r.className))];
      const unknown = (ids as string[]).filter((c) => !known.includes(c.trim()));
      if (unknown.length) {
        throw new OpsToolError('class_not_found', `以下班级不在课表数据中：${unknown.join('、')}`, known.slice(0, 12));
      }
      audienceSummary = `班级：${(ids as string[]).map((c) => c.trim()).join('、')}`;
    } else {
      throw new OpsToolError('bad_audience', `暂不支持的受众类型：${kind}（沙盒未接入人员名册，请用 role_scope / all / class_ids）`);
    }

    const chk = capabilityCheck(ctx, ['notice:publish']);
    const summary =
      `发布站内通知《${title}》（${levelRaw}），接收范围：${audienceSummary}。` +
      `人数未知（沙盒无人员名册，不编造）；已读跟踪未接入。` +
      (chk.canExecute ? '' : ` ${chk.reason}`);

    return persistAndReturn({
      ctx,
      kind: 'notification',
      goal: `发布通知《${title}》`,
      actionType: 'notification.publish',
      payload: { title, content, level: levelRaw, audience: a, audienceSummary, recipientCount: null },
      payloadKind: 'notification',
      payloadView: { title, content, level: levelRaw, audienceSummary, recipientCount: null, readTracking: 'not_connected' },
      title: `站内通知 · ${title}`,
      summary,
      effects: [
        {
          label: '发布站内通知',
          objectType: 'notification',
          objectId: null,
          before: null,
          after: `《${title}》 → ${audienceSummary}`
        }
      ],
      missingDependencies: ['人员名册未接入：接收人数不可知；外部渠道（邮件/短信）未接入，仅站内'],
      caps: ['notice:publish'],
      evidence: evidenceOf(ctx, kind === 'class_ids' ? `班级清单来自${ctx.dataset.sourceLabel}` : '受众为沙盒演示分组')
    });
  } catch (err) {
    if (err instanceof OpsToolError) return fail(err);
    return fail(new OpsToolError('tool_internal_error', `准备通知失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

// ===========================================================================
//  F06 prepare_duty_session —— 值班开始与收尾交接
// ===========================================================================

const DUTY_CHECKLIST_TEMPLATE: Array<{ key: string; label: string }> = [
  { key: 'power', label: '关闭电源与设备' },
  { key: 'lights', label: '关灯' },
  { key: 'doors', label: '锁好门窗' },
  { key: 'keys', label: '钥匙交接' },
  { key: 'todo', label: '未完事项已记录并交接' }
];

/** listBizDutySession 尚未作为通用查询导出 —— 这里用专用小查询（见 db.ts） */
export async function runPrepareDutySession(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const mode = strArg(args, 'mode', { required: true })!;
    if (mode !== 'start' && mode !== 'handover') {
      throw new OpsToolError('bad_mode', 'mode 必须是 start / handover');
    }
    if (mode === 'start') {
      const roomId = resolveRoom(ctx, strArg(args, 'roomId', { required: true }));
      return persistAndReturn({
        ctx,
        kind: 'duty_session',
        goal: `开始 ${roomId} 值班`,
        actionType: 'duty_session.start',
        payload: { roomId },
        payloadKind: 'duty_session',
        payloadView: { mode: 'start', roomId },
        title: `开始值班 · ${roomId}`,
        summary: `创建 ${roomId} 的值班会话（沙盒）。收尾时用「结束值班/交接」整理检查清单与交接记录。`,
        effects: [{ label: `创建值班会话（${roomId}）`, objectType: 'duty_session', objectId: null, before: null, after: '值班中' }],
        missingDependencies: ['沙盒无排班实体：值班会话不与班次/考勤关联'],
        caps: ['duty:write'],
        evidence: evidenceOf(ctx, '沙盒演示数据，无排班依据')
      });
    }

    // ---- handover：定位值班会话 + 用户逐项确认的检查清单 ----
    const note = strArg(args, 'note') ?? '';
    let sessionId = strArg(args, 'sessionId');
    let session = sessionId ? findDutySession(sessionId) : findLatestOpenDutySession(requireActor(ctx).id);
    if (!session) {
      throw new OpsToolError(
        'duty_session_not_found',
        sessionId ? `值班会话 ${sessionId} 不存在或已交接` : '当前没有进行中的值班会话，请先用「开始值班」创建'
      );
    }
    sessionId = session.id;
    if (session.startedBy.id !== requireActor(ctx).id) {
      throw new OpsToolError('forbidden', '只能交接自己开始的值班会话');
    }

    const rawChecklist = args['checklist'];
    if (!Array.isArray(rawChecklist) || !rawChecklist.length) {
      throw new OpsToolError('missing_checklist', '缺少 checklist：交接必须携带用户逐项确认的检查清单（不得由模型代填现场事实）');
    }
    const templateKeys = new Set(DUTY_CHECKLIST_TEMPLATE.map((t) => t.key));
    const checklist = (rawChecklist as Array<Record<string, unknown>>).slice(0, 20).map((item, i) => {
      const key = typeof item['key'] === 'string' && templateKeys.has(item['key']) ? item['key'] : `item_${i}`;
      const label = typeof item['label'] === 'string' && item['label'].trim() ? item['label'].trim() : (DUTY_CHECKLIST_TEMPLATE.find((t) => t.key === key)?.label ?? key);
      const state = item['state'];
      if (state !== 'done' && state !== 'abnormal' && state !== 'unchecked') {
        throw new OpsToolError('bad_checklist', `checklist[${i}].state 必须是 done / abnormal / unchecked`);
      }
      return { key, label, state: state as 'done' | 'abnormal' | 'unchecked' };
    });

    const pending = checklist.filter((c) => c.state !== 'done');
    const abnormal = checklist.filter((c) => c.state === 'abnormal');
    const summary =
      `提交 ${session.roomId} 的值班交接记录。` +
      `清单 ${checklist.length} 项：已完成 ${checklist.length - pending.length}，未完成/异常 ${pending.length}` +
      (abnormal.length ? `（异常：${abnormal.map((c) => c.label).join('、')}）` : '') +
      '。检查项状态以用户确认为准；交接完成不等于签到/签退成功（考勤未接入）。';

    return persistAndReturn({
      ctx,
      kind: 'duty_session',
      goal: `交接 ${session.roomId} 值班`,
      actionType: 'duty_session.handover',
      payload: { sessionId, checklist, note },
      payloadKind: 'duty_session',
      payloadView: { mode: 'handover', sessionId, roomId: session.roomId, checklist, note },
      title: `值班交接 · ${session.roomId}`,
      summary,
      effects: [
        {
          label: `完成值班交接（${session.roomId}）`,
          objectType: 'duty_session',
          objectId: sessionId,
          before: '值班中',
          after: `已交接（未完成项 ${pending.length} 条${abnormal.length ? `，异常 ${abnormal.length} 条` : ''}）`
        }
      ],
      missingDependencies: ['考勤/签退未接入：交接与签退是两条独立流程，本操作不产生考勤记录'],
      caps: ['duty:write'],
      evidence: evidenceOf(ctx, '检查清单来自用户逐项确认（沙盒）')
    });
  } catch (err) {
    if (err instanceof OpsToolError) return fail(err);
    return fail(new OpsToolError('tool_internal_error', `准备值班操作失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

// ===========================================================================
//  F10 create_operations_report —— 运营日报（直接产物，不走确认）
// ===========================================================================

const REPORT_SECTIONS = ['schedule', 'issues', 'notifications', 'closures', 'duty'] as const;

export async function runCreateOperationsReport(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const actor = requireActor(ctx);
    const today = ctx.now.date;
    let startDate = strArg(args, 'startDate') ?? today;
    let endDate = strArg(args, 'endDate') ?? today;
    if (!isValidDateString(startDate) || !isValidDateString(endDate)) {
      throw new OpsToolError('bad_date', 'startDate/endDate 必须是合法日期（YYYY-MM-DD）');
    }
    if (daysBetween(startDate, endDate) < 0) [startDate, endDate] = [endDate, startDate];
    if (daysBetween(startDate, endDate) + 1 > 31) {
      throw new OpsToolError('bad_range', '报告范围一次最长 31 天');
    }
    let sections: string[] = [...REPORT_SECTIONS];
    const rawSections = args['sections'];
    if (rawSections !== undefined && rawSections !== null && rawSections !== '') {
      if (!Array.isArray(rawSections) || rawSections.some((s) => typeof s !== 'string')) {
        throw new OpsToolError('bad_argument', 'sections 必须是字符串数组');
      }
      const unknown = (rawSections as string[]).filter((s) => !(REPORT_SECTIONS as readonly string[]).includes(s));
      if (unknown.length) throw new OpsToolError('bad_section', `未知统计段：${unknown.join('、')}（可用：${REPORT_SECTIONS.join(' / ')}）`);
      sections = [...new Set(rawSections as string[])];
    }

    const metrics: OperationsReportResult['metrics'] = [];
    const evidence: OperationsReportResult['evidence'] = [];
    const notes: string[] = [];

    if (sections.includes('schedule')) {
      const termStart = ctx.dataset.term.termStart ?? null;
      const weekDeterminable = Boolean(termStart);
      let count = 0;
      for (let d = startDate; daysBetween(d, endDate) >= 0; d = addDays(d, 1)) {
        count += effectiveSchedule(ctx.dataset,d).length;
      }
      if (!weekDeterminable) notes.push('教学周不可确定：排课统计未做周次过滤，数字偏大（按全部周次计）');
      metrics.push({
        key: 'lessons_scheduled',
        label: '课表排课条数',
        value: count,
        unit: '条',
        status: 'known',
        note: weekDeterminable ? '按教学周口径过滤' : '未做周次过滤（教学周不可确定）'
      });
      evidence.push({
        section: 'schedule',
        sourceType: ctx.dataset.sourceType,
        sourceLabel: ctx.dataset.sourceLabel,
        note: weekDeterminable ? '按教学周口径过滤' : '未做周次过滤（教学周不可确定）'
      });
    }
    if (sections.includes('issues')) {
      const issues = listBizIssues({actorId:actor.id});
      const inRange = issues.filter((i) => serverNow(new Date(i.createdAt)).date >= startDate && serverNow(new Date(i.createdAt)).date <= endDate);
      metrics.push(
        { key: 'issues_created', label: '新建报修工单', value: inRange.length, unit: '张', status: 'known', note: '沙盒业务数据' },
        { key: 'issues_open', label: '未结工单（全量）', value: issues.filter((i) => i.status === 'open').length, unit: '张', status: 'known', note: '不限统计范围' }
      );
      evidence.push({ section: 'issues', sourceType: 'demo', sourceLabel: '沙盒业务数据（biz_issues）', note: '仅统计沙盒内创建的工单' });
    }
    if (sections.includes('notifications')) {
      const ntf = listBizNotifications(actor.id);
      metrics.push({
        key: 'notifications_published',
        label: '发布站内通知',
        value: ntf.filter((n) => serverNow(new Date(n.publishedAt)).date >= startDate && serverNow(new Date(n.publishedAt)).date <= endDate).length,
        unit: '条',
        status: 'known',
        note: '已读跟踪未接入，无触达统计'
      });
      evidence.push({ section: 'notifications', sourceType: 'demo', sourceLabel: '沙盒业务数据（biz_notifications）', note: '无已读统计' });
    }
    if (sections.includes('closures')) {
      const closures = listBizClosures(actor.id);
      metrics.push({
        key: 'closures_active',
        label: '生效中的停用',
        value: closures.filter((c) => c.status === 'active').length,
        unit: '条',
        status: 'known',
        note: '全量口径（含统计范围外创建）'
      });
      evidence.push({ section: 'closures', sourceType: 'demo', sourceLabel: '沙盒业务数据（biz_closures）', note: '' });
    }
    if (sections.includes('duty')) {
      const duties = listBizDutySessions(actor.id);
      metrics.push(
        { key: 'duty_sessions_open', label: '进行中值班会话', value: duties.filter((d) => d.status === 'open').length, unit: '个', status: 'known', note: '沙盒数据' },
        { key: 'attendance_hours', label: '签到/在室人时', value: null, unit: '人时', status: 'unknown', note: '签到数据未接入，无法统计，不显示为 0' }
      );
      evidence.push({ section: 'duty', sourceType: 'demo', sourceLabel: '沙盒业务数据（biz_duty_sessions）', note: '考勤部分未知' });
    }

    const result: OperationsReportResult = {
      reportId: `rpt-${sha256Hex(`${actor.id}:${startDate}:${endDate}:${sections.join(',')}:${ctx.now.iso}`).slice(0, 12)}`,
      artifactVersion: 1,
      createdAt: ctx.now.iso,
      range: { startDate, endDate },
      sections,
      metrics,
      evidence,
      notes: [
        '本报告为当前用户可见的草稿产物，未自动发布给他人。',
        '统计仅覆盖沙盒业务数据与课表快照；不代表真实实验室运行情况。',
        ...notes
      ]
    };
    return {
      ok: true,
      resultKind: 'operations_report',
      result,
      summary: `已生成 ${startDate}${startDate !== endDate ? ` ~ ${endDate}` : ''} 的运营日报草稿（${metrics.length} 项指标）。`
    };
  } catch (err) {
    if (err instanceof OpsToolError) return fail(err);
    return fail(new OpsToolError('tool_internal_error', `生成日报失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

// ===========================================================================
//  值班会话查询（db.ts 只导出了 CRUD；这里做只读检索）
// ===========================================================================

function rowToSession(r: Record<string, unknown>): SandboxDutySession & { startedBy: SandboxActor } {
  return {
    id: String(r['id']),
    roomId: String(r['roomId']),
    startedBy: { id: String(r['startedById']), role: String(r['startedByRole']) as SandboxActor['role'], label: SANDBOX_ROLE_LABELS[String(r['startedByRole']) as SandboxActor['role']] ?? String(r['startedByRole']) },
    startedAt: String(r['startedAt']),
    status: String(r['status']) as SandboxDutySession['status'],
    checklist: r['checklist'] ? (JSON.parse(String(r['checklist'])) as SandboxDutySession['checklist']) : null,
    handoverNote: r['handoverNote'] ? String(r['handoverNote']) : null,
    linkedIssueIds: JSON.parse(String(r['linkedIssueIds'] ?? '[]')) as string[],
    revision: Number(r['revision'])
  };
}

function findDutySession(id: string): (SandboxDutySession & { startedBy: SandboxActor }) | null {
  const row = getDb().prepare(`SELECT * FROM biz_duty_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

function findLatestOpenDutySession(actorId:string): (SandboxDutySession & { startedBy: SandboxActor }) | null {
  const row = getDb()
    .prepare(`SELECT * FROM biz_duty_sessions WHERE status = 'open' AND startedById = ? ORDER BY startedAt DESC LIMIT 1`)
    .get(actorId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

// ---------------------------------------------------------------------------
//  日报用的其余 biz 计数（与 listBizIssues 同风格；详见 db.ts）
// ---------------------------------------------------------------------------

function listBizNotifications(actorId:string): Array<{ publishedAt: string }> {
  // 被轮次回档撤回的通知不再计入日报（status='reverted'）；已送达的告知无法收回，但统计上不该再算发布量
  const rows = getDb().prepare(`SELECT publishedAt FROM biz_notifications WHERE publishedById = ? AND status <> 'reverted'`).all(actorId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ publishedAt: String(r['publishedAt']) }));
}

function listBizClosures(actorId:string): Array<{ status: string }> {
  const rows = getDb().prepare(`SELECT status FROM biz_closures WHERE createdById = ?`).all(actorId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ status: String(r['status']) }));
}

function listBizDutySessions(actorId:string): Array<{ status: string }> {
  const rows = getDb().prepare(`SELECT status FROM biz_duty_sessions WHERE startedById = ?`).all(actorId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ status: String(r['status']) }));
}
