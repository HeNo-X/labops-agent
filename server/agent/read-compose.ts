/**
 * 确定性只读组合（批次L）
 * ============================================================================
 *  为什么做：11-10 深夜真实数据彩排实测，剩下的慢例全部是"两半各查一张表"的只读问句——
 *    「2026-11-09 E310 有谁签到了？那天的值班是谁」63.1 s/3 轮、
 *    「D525 今天开放吗？最近有谁进出过」22.8 s/2 轮、「E312 钥匙在谁手里？那节有课吗」20.8 s/2 轮。
 *    这些问句的两半各自对应**固定接口**（签到台账 / 周值班模板 / 房间状态 / 开放实验室台账 /
 *    钥匙台账 / 课表），让模型走两遍只是把同一次机械决定贵收两遍，还带来覆盖面抖动
 *    （B 臂同一问句只答了签到半句）。批J 实测换模型优先链只降 15.8%（判据 ≥25%）且上游 429，
 *    所以真正的解法是**把这类只读组合也交服务端一次执行完**。
 *
 *  红线（与批次D-F 同口径）：
 *    · 只做只读查询，绝不调用任何写工具、绝不准备方案；
 *    · 两半里任何一半的参数不能从用户原话+档案确定 ⇒ 零执行交回模型，不猜日期/房间/节次；
 *    · 事实与出处一律复用既有渲染器，本文不新写任何事实句式，避免同一问题两套口径；
 *    · 办理话术（报修/调课/借还）优先走写链，本模块在 detectChain 命中时一律不接手；
 *    · `AGENT_READONLY_COMPOSITION=0` 一键回退纯模型链。
 */

import type { Dataset } from '../data/store.ts';
import type { Intent } from './intent.ts';
import type { ServerNow } from '../time/term.ts';
import type { ToolExecution } from '../tools/registry.ts';
import type { ToolResultKind } from '../../shared/types.ts';
import { renderDemoAnswer } from './demo-engine.ts';

export type ReadKind = 'checkin_duty' | 'openlab_presence' | 'key_schedule';

/** 停下或讲解时要说清是哪一种组合，不能三条都报"只读组合" */
export const READ_LABEL: Record<ReadKind, string> = {
  checkin_duty: '签到明细 + 周值班模板',
  openlab_presence: '开放实验室状态 + 进出记录',
  key_schedule: '钥匙台账 + 该节课表'
};

export interface ReadStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  code?: string;
  message?: string;
  summary?: string;
  resultKind?: ToolResultKind;
  /** 结果体类型直接取自 ToolExecution，避免在 emit 处再断言一次 */
  result?: Extract<ToolExecution, { ok: true }>['result'];
}

export interface ReadOutcome {
  kind: ReadKind | null;
  steps: ReadStep[];
  /** 两份依据都取到时才有；null 表示交回模型或某一步失败 */
  answer: string | null;
  /** 已取到的那半份正文（某一步失败时仍要如实交代，不能把已成功的一半丢掉） */
  partial: string;
  stoppedReason: string | null;
}

export interface ReadDeps {
  question: string;
  intent: Intent;
  ds: Dataset;
  now: ServerNow;
  mode: 'chat' | 'task';
  execute: (tool: string, args: Record<string, unknown>) => Promise<ToolExecution>;
}

// 两半都要命中才接手——只命中一半时模型可能还需要判断，编排反而抢话
const CHECKIN_RE = /(谁签到|签到的|签到明细|签到情况|签到记录|有哪些人.{0,6}签到|签到(过)?(了)?)/;
const DUTY_RE = /(值班|值守|排班)/;
const OPEN_STATE_RE = /(开放吗|开着吗|还开|开放状态|关着吗)/;
const OPEN_VISIT_RE = /(进出|进出过|来过|哪些人|有谁|签到)/;
const KEY_RE = /钥匙/;
const LESSON_RE = /(有课|有课吗|课表|哪些课|上课|排课|上什么课)/;

function enabled(): boolean {
  return process.env['AGENT_READONLY_COMPOSITION'] !== '0';
}

/** 有写意图就不接手——这类话术归批次D-F 的办理链，组合只处理"两份都是查" */
const WRITE_INTENT_RE = /(借|还|归还|报修|登记|调课|换到|挪到|停用|工单|方案|处置|准备|提交|通知|排班|改派)/;

/** 命中即返回组合类型；任何前置条件不满足都返回 null（交回模型，不猜） */
export function detectReadComposition(deps: Pick<ReadDeps, 'question' | 'mode' | 'intent'>): ReadKind | null {
  if (!enabled()) return null;
  if (deps.mode !== 'task') return null;
  const q = deps.question;
  if (WRITE_INTENT_RE.test(q)) return null;
  if (CHECKIN_RE.test(q) && DUTY_RE.test(q)) return 'checkin_duty';
  if (OPEN_STATE_RE.test(q) && OPEN_VISIT_RE.test(q) && deps.intent.labName) return 'openlab_presence';
  if (KEY_RE.test(q) && LESSON_RE.test(q) && deps.intent.labName) return 'key_schedule';
  return null;
}

/** 每个组合的工具与参数缺口：返回 null 的字段就是"必须用户说清"的前置条件 */
function planFor(kind: ReadKind, deps: ReadDeps): Array<{ tool: string; args: Record<string, unknown> }> | string {
  const date = deps.intent.date?.date ?? null;
  const lab = deps.intent.labName ?? null;
  const period = deps.intent.periodKey ?? null;
  if (kind === 'checkin_duty') {
    if (!date) return '没说明查哪一天（签到台账与值班模板都按日期取，不能猜）';
    return [
      { tool: 'query_checkin_records', args: { date, ...(lab ? { labId: lab } : {}) } },
      { tool: 'query_term_schedule', args: { date, ...(period ? { periodKey: period } : {}) } }
    ];
  }
  if (kind === 'openlab_presence') {
    if (!lab) return '没说明是哪间实验室';
    return [
      { tool: 'query_lab_status', args: { labName: lab, ...(date ? { date } : {}) } },
      { tool: 'query_openlab_records', args: { labId: lab, ...(date ? { date } : {}) } }
    ];
  }
  if (!lab) return '没说明是哪间实验室的钥匙';
  return [
    { tool: 'query_key_records', args: { labId: lab } },
    { tool: 'query_schedule', args: { labName: lab, ...(date ? { date } : {}), ...(period ? { periodKey: period } : {}) } }
  ];
}

export async function runReadComposition(kind: ReadKind, deps: ReadDeps): Promise<ReadOutcome> {
  const plan = planFor(kind, deps);
  if (typeof plan === 'string') return { kind, steps: [], answer: null, partial: '', stoppedReason: plan };

  const steps: ReadStep[] = [];
  const parts: string[] = [];
  const dateWasDefaulted = !deps.intent.date?.date;
  for (const step of plan) {
    const t0 = Date.now();
    const out = await deps.execute(step.tool, step.args);
    steps.push({
      tool: step.tool, args: step.args, ok: out.ok, ms: Date.now() - t0,
      ...(!out.ok ? { code: out.code, message: out.message } : { summary: out.summary, resultKind: out.resultKind, result: out.result })
    });
    if (!out.ok) return { kind, steps, answer: null, partial: parts.join('\n\n'), stoppedReason: `${step.tool} 失败：${out.code ?? '未知错误码'}：${out.message ?? '无更多信息'}` };
    // 呈现完全交给既有渲染器：同一份数据在单工具路径与组合路径必须是同一句话
    parts.push(renderDemoAnswer(
      { kind: out.resultKind, payload: out.result, summary: out.summary },
      { dateWasDefaulted, periodFiltered: Boolean(deps.intent.periodKey), textOnly: false }
    ));
  }
  return { kind, steps, answer: parts.join('\n\n'), partial: parts.join('\n\n'), stoppedReason: null };
}
