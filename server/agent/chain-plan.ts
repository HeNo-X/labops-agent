/**
 * 确定性链编排（批次D）
 * ============================================================================
 *  为什么做：11-10 探针实测 spark 单轮 15–30 s 里，读 29 份工具清单只多花 0.5 s，
 *  大头是**每一轮都让模型重新生成一遍"思考 + 工具名 + 参数 JSON"**。
 *  而"故障事件 → 分析教学影响 → 准备联合方案"这条链的顺序、参数、接口契约都是固定的
 *  （workflow/preview → plans/commit 同型），让模型走三遍只是把同一件事贵三次，
 *  实测还会顶到 120 s 墙钟（方案卡已生成却被截尾）。
 *
 *  怎么做：契约固定的机械步骤由服务端按已验证的接口顺序驱动；模型只在
 *  **参数不全 / 候选不唯一**时接手——这两种情况一律返回 null 交回模型，绝不替用户猜。
 *
 *  红线（不许被"变快"诱惑而越线）：
 *    · 链只准备方案，**不调用 plans/commit、不点确认**——执行权始终在用户；
 *    · 候选多于一个、被阻塞项非空、或搜索被截断 ⇒ 停在 analyze，如实说明有几个候选要人选；
 *    · 任一步失败就地停下，把主系统原文错误码与"上一步已完成"一并说清，不掩盖半提交；
 *    · `AGENT_CHAIN_ORCHESTRATION=0` 一键回退纯模型链。
 */

import type { Dataset } from '../data/store.ts';
import type { ServerNow } from '../time/term.ts';
import type { Intent } from './intent.ts';
import type { ToolExecution } from '../tools/registry.ts';
import type { ToolResultKind } from '../../shared/types.ts';
import type { BusinessResult, NativeIncident, NativeIncidentSet, NativePlan } from '../../shared/business.ts';
import { normalizeLabName } from '../data/store.ts';
import { resolvePeriodKey } from './intent.ts';

export type ChainKind = 'incident_joint' | 'schedule_move' | 'key_transaction';

/** 停下时要说清是哪条链，不能三条都报"联合处置链"（2026-11-10 真实数据实测到文案错位） */
export const CHAIN_LABEL: Record<ChainKind, string> = {
  incident_joint: '故障事件联合处置链',
  schedule_move: '调课提案链',
  key_transaction: '钥匙借还链'
};

export interface ChainStepResult {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  code?: string;
  message?: string;
  summary?: string;
  resultKind?: ToolResultKind;
  /** 成功分支的结果体，类型直接取自 ToolExecution，避免在 emit 处再断言一次 */
  result?: Extract<ToolExecution, { ok: true }>['result'];
}

export interface ChainOutcome {
  kind: ChainKind;
  steps: ChainStepResult[];
  /** 确定性渲染好的正文；null 表示编排判断不了，交回模型 */
  answer: string | null;
  awaitingConfirmation: boolean;
  /** 停下来说明原因（参数缺口 / 候选不唯一 / 某步失败） */
  stoppedReason: string | null;
}

export interface ChainDeps {
  question: string;
  intent: Intent;
  ds: Dataset;
  now: ServerNow;
  mode: 'chat' | 'task';
  execute: (tool: string, args: Record<string, unknown>) => Promise<ToolExecution>;
}

/** 故障征象：只认用户自己说出口的现象词，不推断、不补全 */
const FAULT_RE = /(没有信号|无信号|不制冷|不制热|不亮|黑屏|蓝屏|花屏|无法开机|开不了机|死机|坏了|损坏|失灵|断网|掉线|连不上|没声音|无声音|异响|噪音|漏水|冒烟|异味|过热|闪退|接口松|屏幕碎)/;
const PLAN_RE = /(联合|处置方案|办理方案|准备方案|影响.*分析|分析.*影响|调课.*停用|停用.*工单|登记.*事件.*方案)/;
const PREFERENCES: Array<[RegExp, 'keep_period' | 'few_rooms' | 'early', string]> = [
  [/不改节次|保持节次|不要改节次|节次不变/, 'keep_period', '尽量不改节次'],
  [/少用房间|房间少一点|尽量同一间/, 'few_rooms', '尽量少用房间'],
  [/尽早|较早|提前结束|越早越好/, 'early', '优先较早节次']
];

function enabled(): boolean {
  return process.env['AGENT_CHAIN_ORCHESTRATION'] !== '0';
}

/** 失败原因取主系统原文；ToolExecution 的成功分支没有 code/message，这里显式收窄 */
function failText(out: ToolExecution): string {
  return out.ok ? '结果类型不符合预期' : `${out.code ?? '未知错误码'}：${out.message ?? '无更多信息'}`;
}

/** 取用户原话里含故障征象的那一句作为"故障事实"——不是摘要，也不是改写 */
function faultStatement(question: string): string | null {
  for (const clause of question.split(/[，,。;；\n]/)) {
    if (FAULT_RE.test(clause)) return clause.trim();
  }
  return null;
}

function roomIds(ds: Dataset, name: string): string[] {
  return [...(ds.labs || []), ...(ds.openLabs || [])]
    .filter((l) => normalizeLabName(l.name) === normalizeLabName(name))
    .map((l) => l.id);
}

/** 命中即返回链类型；任何前置条件不满足都返回 null（交回模型，不猜） */
const MOVE_RE = /(调到|换到|挪到|改到|调课|换教室|换一间|换个房间)/;
const KEY_RE = /钥匙|钥匙柜|(借|还|归还).*(柜|钥匙)/;

export function detectChain(deps: Pick<ChainDeps, 'question' | 'mode'>): ChainKind | null {
  if (!enabled()) return null;
  if (deps.mode !== 'task') return null;
  // 联合处置优先：一句话里既有故障征象又明确要方案时，走事件链（它已包含调课）
  if (FAULT_RE.test(deps.question) && PLAN_RE.test(deps.question)) return 'incident_joint';
  // 只问"报修/登记"不要求方案时不进链——模型可能一步就够，编排反而多绕
  if (MOVE_RE.test(deps.question)) return 'schedule_move';
  if (KEY_RE.test(deps.question)) return 'key_transaction';
  return null;
}

export async function runChain(kind: ChainKind, deps: ChainDeps): Promise<ChainOutcome> {
  return kind === 'incident_joint' ? runIncidentJoint(deps) : kind === 'schedule_move' ? runScheduleMove(deps) : runKeyTransaction(deps);
}

async function runIncidentJoint(deps: ChainDeps): Promise<ChainOutcome> {
  const kind: ChainKind = 'incident_joint';
  const steps: ChainStepResult[] = [];
  const record = async (tool: string, args: Record<string, unknown>): Promise<ToolExecution> => {
    const t0 = Date.now();
    const out = await deps.execute(tool, args);
    steps.push({
      tool, args, ok: out.ok, ms: Date.now() - t0,
      ...(!out.ok ? { code: out.code, message: out.message } : { summary: out.summary, resultKind: out.resultKind, result: out.result })
    });
    return out;
  };
  const stop = (stoppedReason: string): ChainOutcome => ({ kind, steps, answer: null, awaitingConfirmation: false, stoppedReason });

  // —— 前置参数：房间 / 日期 / 影响节次 / 故障事实，缺任何一个都不开工 ——
  const name = deps.intent.labName;
  if (!name) return stop('缺房间');
  const ids = roomIds(deps.ds, name);
  if (ids.length !== 1) return stop(ids.length ? `房间「${name}」有 ${ids.length} 条登记，需用户确认` : `系统里没有房间「${name}」`);
  const date = deps.intent.date?.date;
  if (!date) return stop('缺日期');
  const periodKeys = deps.intent.periodKeys ?? (deps.intent.periodKey ? [deps.intent.periodKey] : null);
  if (!periodKeys || !periodKeys.length) return stop('缺影响节次');
  const description = faultStatement(deps.question);
  if (!description) return stop('缺用户声明的故障事实');

  const pref = PREFERENCES.find(([re]) => re.test(deps.question));
  const preference = pref ? pref[1] : 'keep_period';
  const prefLabel = pref ? pref[2] : '尽量不改节次（默认，用户未指定偏好）';

  // —— ① 登记事件草稿（参数已由 assertIncidentDraftArgs 同口径校验过，这里不再重复判） ——
  const draft = await record('prepare_incident_plan', { action: 'draft', roomId: ids[0]!, date, description, periodKeys });
  if (!draft.ok || draft.resultKind !== 'business_plan') return stop(`登记事件失败：${failText(draft)}`);
  const incident = (draft.result as BusinessResult).incident as NativeIncident | undefined;
  const incidentId = incident?.id;
  if (!incidentId) return stop('主系统未返回事件编号');

  // —— ② 分析教学影响与联合候选 ——
  const analyzed = await record('prepare_incident_plan', { action: 'analyze', incidentId, expectedRevision: incident.revision, preference });
  if (!analyzed.ok || analyzed.resultKind !== 'business_plan') return stop(`分析候选失败：${failText(analyzed)}`);
  const set = (analyzed.result as BusinessResult).incidentSet as NativeIncidentSet | undefined;
  if (!set) return stop(`分析结果没有候选集合：${failText(analyzed)}`);
  const options = set.options ?? [];
  const blocked = set.blocked ?? [];
  const truncated = set.search?.truncated === true;

  // 候选不唯一 / 有阻塞 / 搜索被截断 ⇒ 停在 analyze，把选择权交回人（不是模型）
  if (options.length !== 1 || blocked.length > 0 || truncated) {
    const why = options.length === 0 ? '没有可执行的联合候选'
      : options.length > 1 ? `有 ${options.length} 个候选需要本人挑选`
        : blocked.length > 0 ? `存在 ${blocked.length} 项阻塞条件`
          : '候选搜索被截断，结果可能不完整';
    return {
      kind, steps,
      answer: `事件已登记（${incidentId}），偏好「${prefLabel}」下${why}。请在方案卡里挑选或调整条件后重新分析——我不会替你选。`,
      awaitingConfirmation: false,
      stoppedReason: why
    };
  }

  // —— ③ 准备唯一方案（只准备，不提交） ——
  const previewed = await record('prepare_incident_plan', { action: 'preview', incidentId, candidateSetId: set.id, optionId: options[0]!.id });
  if (!previewed.ok || previewed.resultKind !== 'business_plan') return stop(`准备方案失败：${failText(previewed)}`);
  const plan = (previewed.result as BusinessResult).plan as NativePlan | undefined;
  const impact = (previewed.result as BusinessResult).impact;
  const activities = impact && typeof impact === 'object' && 'activityCount' in impact ? String((impact as { activityCount?: number }).activityCount) : null;

  return {
    kind,
    steps,
    answer: [
      `已按你声明的故障事实准备联合处置方案（偏好：${prefLabel}${activities ? `，当前影响 ${activities} 项教学活动` : ''}）。`,
      `方案编号 ${plan?.id ?? '（未取得）'} · 状态 ${plan?.state ?? '待本人确认'}。`,
      '包含调课、故障范围停用、工单与受影响班级站内通知；**尚未写入主系统**——请在方案卡核对全部对象后点击确认，确认权在你。'
    ].join('\n'),
    awaitingConfirmation: plan?.state === 'awaiting_confirmation',
    stoppedReason: null
  };
}

// ===========================================================================
//  ② 调课提案链：query_schedule 取 timetableId → prepare_schedule_adjustment
//  主系统 /schedule/preview 的硬要求（Pages/server/operations.js:539-557）：
//    · 原课程必须在该日有效（source_missing）；
//    · 目标房间+节次必须落在候选集合里且 eligible（constraints_failed）；
//    · reason 必填（text(body.reason,'调课原因')）。
//  所以这三样缺任何一样都不开工——尤其 reason，用户没说就问他，不编一个"设备故障"。
// ===========================================================================

// 捕获"调到"之后的整段（房号 + 可能的节次）；节次由 resolvePeriodKey 从这段里解出来，
// 只截到第一个空格会漏掉"调到 E312 上午第二大节"里的节次。
const MOVE_TARGET_RE = /(?:调到|换到|挪到|改到)\s*([^，。,；;\n]+)/;

function mentionedRooms(ds: Dataset, question: string): Array<{ id: string; name: string }> {
  return [...(ds.labs || []), ...(ds.openLabs || [])].filter((l) => l.name && question.includes(l.name));
}

function statedReason(question: string): string | null {
  // 「原因是投影仪故障」是最自然的说法，字符类里少了「是」会让整条链零执行交回模型（2026-11-10 彩排实测到）
  const m = /(?:因为|由于|原因[：:是为])\s*([^。，,；;\n]+)/.exec(question);
  const v = m?.[1]?.trim();
  return v && v.length >= 2 ? v : null;
}

async function runScheduleMove(deps: ChainDeps): Promise<ChainOutcome> {
  const kind: ChainKind = 'schedule_move';
  const steps: ChainStepResult[] = [];
  const record = async (tool: string, args: Record<string, unknown>): Promise<ToolExecution> => {
    const t0 = Date.now();
    const out = await deps.execute(tool, args);
    steps.push({
      tool, args, ok: out.ok, ms: Date.now() - t0,
      ...(!out.ok ? { code: out.code, message: out.message } : { summary: out.summary, resultKind: out.resultKind, result: out.result })
    });
    return out;
  };
  const stop = (stoppedReason: string): ChainOutcome => ({ kind, steps, answer: null, awaitingConfirmation: false, stoppedReason });

  const source = deps.intent.labName;
  if (!source) return stop('缺原房间');
  const date = deps.intent.date?.date;
  if (!date) return stop('缺日期');
  const reason = statedReason(deps.question);
  if (!reason) return stop('缺用户说明的调课原因');

  // 目标房间：问题里提到、且不是源房间的那一个；说不清或说两个都交回模型问用户
  const targets = mentionedRooms(deps.ds, deps.question).filter((l) => normalizeLabName(l.name) !== normalizeLabName(source));
  if (targets.length !== 1) return stop(targets.length === 0 ? '缺目标房间' : `目标房间有 ${targets.length} 个候选，需用户指定`);

  // 节次：说了"调到 X 节"就用 X；没说就保持原节次（这是"换教室不换时间"的自然读法，正文里写明）
  const wanted = deps.intent.periodKeys ?? (deps.intent.periodKey ? [deps.intent.periodKey] : null);
  const targetPeriodText = MOVE_TARGET_RE.exec(deps.question)?.[1] ?? '';

  // —— ① 查原课次（拿 timetableId，顺带把依据卡给界面） ——
  const queried = await record('query_schedule', { labName: source, date, ...(deps.intent.periodKey ? { periodKey: deps.intent.periodKey } : {}) });
  if (!queried.ok || queried.resultKind !== 'schedule') return stop(`查课表失败：${failText(queried)}`);
  const schedule = queried.result as { lessons?: Array<{ timetableId: string; periodKey: string; courseName: string; className?: string }>; reason?: string };
  const lessons = (schedule.lessons ?? []).filter((l) => !wanted || wanted.includes(l.periodKey as never));
  if (lessons.length !== 1) return stop(lessons.length === 0 ? '该日期该节次没有可调的原课程' : `命中 ${lessons.length} 门课程，需用户指定调哪一门`);
  const lesson = lessons[0]!;

  // —— ② 准备调课方案（只准备，不提交） ——
  const toPeriodKey = resolvePeriodKey(targetPeriodText) ?? lesson.periodKey;
  const keptPeriod = toPeriodKey === lesson.periodKey;
  const prepared = await record('prepare_schedule_adjustment', {
    date, timetableId: lesson.timetableId, toLabId: targets[0]!.id, toPeriodKey, reason
  });
  if (!prepared.ok || prepared.resultKind !== 'business_plan') return stop(`准备调课方案失败：${failText(prepared)}`);
  const plan = (prepared.result as BusinessResult).plan as NativePlan | undefined;

  return {
    kind,
    steps,
    answer: [
      `已准备调课方案：${lesson.courseName}${lesson.className ? `（${lesson.className}）` : ''} ${date} ${lesson.periodKey}` +
        ` → ${targets[0]!.name} ${toPeriodKey}${keptPeriod ? '（未指定新节次，保持原节次）' : ''}。`,
      `调课原因按你的原话记为「${reason}」。`,
      `方案编号 ${plan?.id ?? '（未取得）'} · 状态 ${plan?.state ?? '待本人确认'}。**尚未写入主系统**——请在方案卡核对后点击确认，确认权在你。`
    ].join('\n'),
    awaitingConfirmation: plan?.state === 'awaiting_confirmation',
    stoppedReason: null
  };
}

// ===========================================================================
//  ③ 钥匙借还链：query_key_records 取编号 → prepare_business_workflow(key.lend|key.return)
//  并发令牌 expectedHolder 由主系统按当前台账自己写入（operations.js:498-505），
//  编排侧只负责"把钥匙找出来"——台账里的借用人是掩码值，本来也不许拿来当参数。
// ===========================================================================

const KEY_LEND_RE = /借给\s*([^\s，。,；;的]+)/;

async function runKeyTransaction(deps: ChainDeps): Promise<ChainOutcome> {
  const kind: ChainKind = 'key_transaction';
  const steps: ChainStepResult[] = [];
  const record = async (tool: string, args: Record<string, unknown>): Promise<ToolExecution> => {
    const t0 = Date.now();
    const out = await deps.execute(tool, args);
    steps.push({
      tool, args, ok: out.ok, ms: Date.now() - t0,
      ...(!out.ok ? { code: out.code, message: out.message } : { summary: out.summary, resultKind: out.resultKind, result: out.result })
    });
    return out;
  };
  const stop = (stoppedReason: string): ChainOutcome => ({ kind, steps, answer: null, awaitingConfirmation: false, stoppedReason });

  const q = deps.question;
  const returning = /(归还|还钥匙|还回|交回|放回)/.test(q);
  if (!returning && !/借/.test(q)) return stop('没说明是借出还是归还');

  // 借给人：说"借给我/本人"= 办理人自己（主系统缺省即本人）；说别人就带上；一个字都没说就交回模型问
  let holderUsername: string | undefined;
  if (!returning) {
    const to = KEY_LEND_RE.exec(q)?.[1]?.trim();
    if (!to) return stop('缺借给人（用户未说明借给谁，不能猜）');
    if (!/^(我|本人|自己)$/.test("") ) {
      // 角色称谓不是账号：主系统一定回 holder_invalid，与其留一条失败的写步骤，不如零执行交回模型问用户
      if (/^(志愿者|学生|管理员|老师|教师|同学|值班员|负责人|操作员)(们|同学)?$/.test(to)) {
        return stop(`借用人只说了「${to}」这类角色称谓，不是具体账号或姓名——需先问清借给哪一位，我不替你挑人`);
      }
      holderUsername = to;
    }
  }

  // —— ① 查台账定位钥匙（按房间名查，与全仓 id-or-name 口径一致） ——
  const roomName = deps.intent.labName;
  const listed = await record('query_key_records', roomName ? { labId: roomName } : {});
  if (!listed.ok) return stop(`查钥匙台账失败：${failText(listed)}`);
  const keys = ((listed.result as { keys?: Array<{ id: string; name: string; labName?: string; holder?: string; borrowed?: boolean }> })?.keys ?? [])
    .filter((k) => !roomName || normalizeLabName(k.labName ?? '') === normalizeLabName(roomName) || normalizeLabName(k.id) === normalizeLabName(roomName));
  if (keys.length !== 1) return stop(keys.length === 0 ? '台账里找不到这把钥匙（请说明房间或钥匙编号）' : `台账命中 ${keys.length} 把钥匙，需用户指定编号`);
  const key = keys[0]!;
  if (returning && key.borrowed !== true) return stop(`钥匙「${key.name || key.id}」当前在柜，无需归还`);
  if (!returning && key.borrowed === true) return stop(`钥匙「${key.name || key.id}」当前已借出，请先归还或重新核对台账`);

  // —— ② 准备借还方案（只准备，不提交） ——
  const args: Record<string, unknown> = { kind: returning ? 'key.return' : 'key.lend', keyId: key.id };
  if (holderUsername) args.holderUsername = holderUsername;
  const prepared = await record('prepare_business_workflow', args);
  if (!prepared.ok || prepared.resultKind !== 'business_plan') return stop(`准备借还方案失败：${failText(prepared)}`);
  const plan = (prepared.result as BusinessResult).plan as NativePlan | undefined;

  return {
    kind,
    steps,
    answer: [
      returning ? `已准备归还方案：钥匙「${key.name || key.id}」（${key.labName ?? '房间未标注'}）放回柜内。`
        : `已准备借出方案：钥匙「${key.name || key.id}」（${key.labName ?? '房间未标注'}）借给${holderUsername ? `账号 ${holderUsername}` : '你本人（未指定借给人时主系统默认办理人）'}。`,
      `方案编号 ${plan?.id ?? '（未取得）'} · 状态 ${plan?.state ?? '待本人确认'}。**台账尚未变化**——请在方案卡核对后点击确认，确认权在你。`,
      '借用人字段由主系统按台账写入，我这边只见到掩码值，不据此推断真实账号。'
    ].join('\n'),
    awaitingConfirmation: plan?.state === 'awaiting_confirmation',
    stoppedReason: null
  };
}
