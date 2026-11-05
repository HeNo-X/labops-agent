/**
 * 轮次 render unit —— 把一轮的事件轨迹折叠成「可折叠的一段工作」
 * ============================================================================
 *  设计依据：正常完成的 segment 默认折叠成"已工作 N 秒"，运行中 / 中断 / 失败
 *  强制展开；冷恢复发现缺完成时间的轮次归一化为 interrupted（只显示"已停止"，
 *  **不带耗时**），绝不伪造"已完成"（R4）。
 *
 *  纯函数、无 Vue 依赖 —— 可直接单测。
 */

import type { TraceStep } from '../stores/run';

export interface TurnRenderUnit {
  steps: TraceStep[];
  /** 工具调用次数（= tool_result 步数；运行中已发起的 tool_started 也计） */
  toolCount: number;
  /** 本轮用到的**真实工具名**去重保序。禁止从 title 反推（失败时标题统一为"查询未成功"） */
  chosenTools: string[];
  workStatus:
    | { state: 'running'; label: string }
    | { state: 'completed'; label: string }
    | { state: 'interrupted'; label: string };
  /** 本轮是否有失败步骤（强制展开依据之一） */
  hasFailure: boolean;
  /** 本轮是否被中止（中断/取消）—— 强制展开且不带耗时 */
  interrupted: boolean;
}

export interface BuildTurnUnitOptions {
  /** 该轮仍在进行（活跃轮） */
  running: boolean;
  /** 该轮被中断（断流/取消/服务端中断），即便有部分步骤也不得显示"已工作" */
  interrupted: boolean;
  /**
   * 服务端事实的耗时。**只能是 run_completed.payload.ms 或 run_started→终态 ts 之差**；
   * 拿不到就传 null —— 此时显示"已停止"且不带数字，不许用前端本地时钟补一个
   * 看起来合理的数。
   */
  serverMs: number | null;
}

/** 秒数取整（向下），只在有服务端事实时才有数字 */
function secondsLabel(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

export function buildTurnRenderUnit(steps: TraceStep[], opts: BuildTurnUnitOptions): TurnRenderUnit {
  const toolSteps = steps.filter((s) => s.kind === 'tool');
  const seen: string[] = [];
  for (const s of toolSteps) {
    // 必须用真实工具名；带 tool 字段的才是工具步（失败步也带）
    if (s.tool && !seen.includes(s.tool)) seen.push(s.tool);
  }
  const hasFailure = steps.some((s) => s.status === 'failed' || s.kind === 'error');
  const interrupted = opts.interrupted || steps.some((s) => s.kind === 'cancelled' && s.status === 'cancelled');

  let workStatus: TurnRenderUnit['workStatus'];
  if (opts.running) {
    // 运行中：有服务端耗时就用它累积（如取消前的已运行时间），没有就只说"工作中"
    workStatus = { state: 'running', label: opts.serverMs !== null ? `工作中 ${secondsLabel(opts.serverMs)}` : '工作中' };
  } else if (interrupted) {
    // 中断/取消：**不带耗时**（ZCode orphan 归一化口径）
    workStatus = { state: 'interrupted', label: '已停止' };
  } else if (opts.serverMs !== null) {
    workStatus = { state: 'completed', label: `已工作 ${secondsLabel(opts.serverMs)}` };
  } else {
    // 终态缺完成时间（历史孤儿轮）→ interrupted，不得伪装成 completed
    workStatus = { state: 'interrupted', label: '已停止' };
  }

  return {
    steps,
    toolCount: toolSteps.length,
    chosenTools: seen,
    workStatus,
    hasFailure,
    interrupted: workStatus.state === 'interrupted' || interrupted
  };
}

/** 运行中 / 中断 / 失败一律强制展开；只有正常完成且无失败才允许默认收起 */
export function shouldForceExpand(unit: TurnRenderUnit): boolean {
  if (unit.workStatus.state !== 'completed') return true;
  return unit.hasFailure;
}

/**
 * 工具的中文展示名 —— **全仓唯一事实源**（此前 run.ts 与 ChatMessage.vue 各一份）。
 * 这是类别名（"课表查询"式），不是动作名；动作名由 tool-display.ts 的 family 提供。
 */
const TOOL_TITLES: Record<string, string> = {
  query_schedule: '查询课表',
  query_lab_status: '查询房间状态',
  query_free_rooms: '查找空闲房间',
  query_checkin_status: '查询签到状态',
  query_vision_status: '查询现场事实',
  prepare_issue_ticket: '准备报修单',
  prepare_room_closure: '准备停用计划',
  prepare_notification: '准备站内通知',
  prepare_duty_session: '准备值班操作',
  create_operations_report: '生成运营日报'
};

export function toolTitle(tool: string): string {
  return TOOL_TITLES[tool] ?? `执行 ${tool}`;
}

/** 步骤状态 → 展示标签（StatusTag 的 label/glyph/tone 由 toneOf/glyphOf/labelOf 统一提供） */
export function toneOf(s: TraceStep): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (s.status === 'failed') return 'danger';
  if (s.status === 'running') return 'info';
  if (s.status === 'cancelled') return 'neutral';
  return 'ok';
}

export function glyphOf(s: TraceStep): string {
  if (s.status === 'failed') return '✕';
  if (s.status === 'running') return '◌';
  if (s.status === 'cancelled') return '⏹';
  if (s.kind === 'done') return '✓';
  if (s.kind === 'tool') return '▣';
  return '✓';
}

export function labelOf(s: TraceStep): string {
  if (s.status === 'failed') return '失败';
  if (s.status === 'running') return '进行中';
  if (s.status === 'cancelled') return '已取消';
  return '完成';
}
