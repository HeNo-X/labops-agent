/**
 * 任务计划复述（todo recitation）—— maintain_task_plan 工具
 * ============================================================================
 *  多步任务让模型自己维护一份步骤计划，每完成/放弃一步就更新。这份计划有三重价值：
 *    ① 对模型：计划随工具结果一起留在上下文里，长任务中途不"迷失"；
 *    ② 对用户：计划面板如实呈现 Agent 打算做什么、做到了哪一步（可审计）；
 *    ③ 对界面：把"有界自主编排"从一句话变成看得见的步骤流。
 *
 *  红线：这是**工作记录**，不是业务结果——工具结果只回显计划本身，
 *  不进 verifiedAnswers，不参与任何业务判定，不得据此向用户报告业务事实。
 */

import type { TaskPlanStep } from '../../shared/types.ts';
import type { ToolExecution } from './registry.ts';

/** 步数上限：超过说明任务粒度太粗，让模型自己收敛 */
export const PLAN_MAX_STEPS = 12;
/** 单步文字上限：计划是索引用的，不是论文 */
export const PLAN_MAX_TEXT = 80;

const STATUSES = new Set(['pending', 'done', 'dropped']);

export interface NormalizePlanOutcome {
  steps: TaskPlanStep[];
  /** 因超限被丢弃的步数（如实反馈给模型与日志，不静默） */
  droppedCount: number;
  /** text 非法（空/超长）被丢弃的条数 */
  invalidCount: number;
}

/**
 * 纯函数：把模型给的 steps 数组规范化。
 *  · 只接受 {text, status}；status 非法值一律回退 'pending'（不猜语义）；
 *  · text 去首尾空白、截到 PLAN_MAX_TEXT（截断如实计 invalid? —— 截断不算非法，
 *    只有空白/非字符串才算非法）；
 *  · 超过 PLAN_MAX_STEPS 的多余步骤丢弃并计数；
 *  · id 稳定生成：s1..sN（同一轮内重发全量计划时 UI 可按 text+status 重渲染）。
 */
export function normalizePlanSteps(raw: unknown): NormalizePlanOutcome {
  const list = Array.isArray(raw) ? raw : [];
  const steps: TaskPlanStep[] = [];
  let invalidCount = 0;
  for (const item of list.slice(0, PLAN_MAX_STEPS)) {
    const text = typeof (item as { text?: unknown })?.text === 'string' ? (item as { text: string }).text.trim() : '';
    if (!text) {
      invalidCount += 1;
      continue;
    }
    const rawStatus = (item as { status?: unknown })?.status;
    const status = typeof rawStatus === 'string' && STATUSES.has(rawStatus) ? rawStatus : 'pending';
    steps.push({ id: `s${steps.length + 1}`, text: text.slice(0, PLAN_MAX_TEXT), status: status as TaskPlanStep['status'] });
  }
  const droppedCount = Math.max(0, list.length - PLAN_MAX_STEPS);
  return { steps, droppedCount, invalidCount };
}

/**
 * 工具执行体。每次调用以**全量** steps 替换整份计划（幂等、无需 diff）。
 * 模型每次更新都重发全量——计划本来就是短清单，全量比增量协议简单得多。
 */
export function executeTaskPlan(args: Record<string, unknown>): ToolExecution {
  const { steps, droppedCount, invalidCount } = normalizePlanSteps(args['steps']);
  if (!steps.length) {
    return {
      ok: false,
      code: 'empty_plan',
      message: '计划至少需要一步（text 不能为空）。若任务已能直接回答，就不需要调用本工具。',
      suggestions: ['把任务拆成可执行的步骤再登记；单步任务直接执行即可'],
      summary: '任务计划为空，未登记'
    };
  }
  const done = steps.filter((s) => s.status === 'done').length;
  const dropped = steps.filter((s) => s.status === 'dropped').length;
  const notes: string[] = [];
  if (droppedCount) notes.push(`${droppedCount} 步超出上限被丢弃`);
  if (invalidCount) notes.push(`${invalidCount} 条无效步骤被忽略`);
  const summary = `任务计划已更新：${steps.length} 步（${done} 完成、${steps.length - done - dropped} 待办、${dropped} 放弃）${notes.length ? `；${notes.join('，')}` : ''}`;
  return {
    ok: true,
    resultKind: 'task_plan',
    result: { steps, updatedAt: new Date().toISOString() },
    summary
  };
}
