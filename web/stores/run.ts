import {clientFetch} from '../client';
/**
 * 任务状态机 —— 「运行生命周期」与「结果类型」正交拆分（工作台改造 P0 修复）
 * ============================================================================
 *  runStatus 回答「这次任务还开着吗」：
 *    idle       初始
 *    running    已发起、事件流尚未给出终态（输入框锁定与否**只看它**）
 *    completed  收到 run_completed 且流收尾
 *    failed     收到 run_failed / 流提前断掉（合成 stream_ended_early）
 *    cancelled  用户主动取消（中性状态，不是故障）
 *
 *  resultKind 回答「结果长什么样」，只驱动结果区渲染：
 *    none / schedule_hit / schedule_empty / config_insufficient / lab_status / free_rooms
 *
 *  phase（T1 相位机）回答「现在在等谁」：planning / model / tool / awaiting_confirm /
 *    answering / 终态。只做展示与计时口径（awaiting_confirm 暂停工作计时），
 *    不参与输入锁判断；转移白名单见 PHASE_TRANSITIONS。
 *
 *  隔离规则：每次 beginRun 生成新的 runId 随请求发送；ingest 丢弃一切
 *  runId 不等于当前任务的事件 —— 旧流迟到的事件绝不可能污染新任务。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  DataSourceType,
  EngineType,
  FreeRoomsResult,
  LabStatusResult,
  RunEvent,
  ScheduleLesson,
  ScheduleQueryResult,
  ToolResultKind
} from '@shared/types';
import { DATA_SOURCE_LABELS, RUN_EVENT_TYPES } from '@shared/types';
import type { NeedConfirmPayload } from '@shared/operations-contract';
import { PERIODS } from '@shared/periods';
import { actorHeaders } from '../actor';
import { toolTitle } from '../lib/turn-view';
import { DISPLAY_TEXT_BUDGET, clampText } from '../lib/tool-display';

/** 时间线那一行短结论的预算（正文级篇幅；完整内容在 summaryFull / 结果卡里） */
const TIMELINE_DETAIL_BUDGET = 160;

function clampLine(s: string, n: number): string {
  const c = clampText(s, n);
  return c.truncated ? `${c.text}…` : c.text;
}

function clampSummary(s: string): { summaryFull: string; summaryTruncated?: boolean } {
  const c = clampText(s, DISPLAY_TEXT_BUDGET.output);
  return c.truncated ? { summaryFull: c.text, summaryTruncated: true } : { summaryFull: c.text };
}

export type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ResultKind = 'none' | 'schedule_hit' | 'schedule_empty' | 'config_insufficient' | 'lab_status' | 'free_rooms';

/**
 * 运行相位 —— 回答「现在到底在等谁」，与 RunStatus（回答「任务还开着吗」）正交并存。
 * need_confirm 到达时 runStatus 仍是 running（输入互斥不放宽），但相位进入
 * awaiting_confirm：UI 把"任务执行中"换成"等待你的确认"，工作计时暂停累计。
 * 相位只来自已存在的真实事件（不新增服务端事件类型），run_cancelled 归为正常结束。
 */
export type RunPhase =
  | 'idle' | 'planning' | 'model' | 'tool'
  | 'awaiting_confirm' | 'answering'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/**
 * 相位转移白名单表（表驱动，不写 if-else 散落）。表**逐条列出全部合法边**，
 * 含同态自环（a→a）—— 重复/重发事件幂等靠它，而不是靠函数里的提前 return；
 * 三个终态只有自环，迟到事件不得把终态翻回中间态。
 */
export const PHASE_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  idle: ['idle', 'planning', 'failed', 'cancelled'],
  planning: ['planning', 'model', 'tool', 'awaiting_confirm', 'answering', 'completed', 'failed', 'cancelled', 'interrupted'],
  model: ['model', 'tool', 'awaiting_confirm', 'answering', 'completed', 'failed', 'cancelled', 'interrupted'],
  tool: ['tool', 'model', 'awaiting_confirm', 'answering', 'completed', 'failed', 'cancelled', 'interrupted'],
  awaiting_confirm: ['awaiting_confirm', 'tool', 'model', 'answering', 'completed', 'failed', 'cancelled', 'interrupted'],
  answering: ['answering', 'tool', 'model', 'awaiting_confirm', 'completed', 'failed', 'cancelled', 'interrupted'],
  completed: ['completed'],
  failed: ['failed'],
  cancelled: ['cancelled'],
  interrupted: ['interrupted']
};

export function canTransitionPhase(from: RunPhase, to: RunPhase): boolean {
  return PHASE_TRANSITIONS[from].includes(to);
}

/** 严格版：白名单外抛错。store 内经 movePhase 防御性消费（异常事件序列不炸运行界面）。 */
export function transitionPhase(from: RunPhase, to: RunPhase): RunPhase {
  if (!canTransitionPhase(from, to)) throw new Error(`invalid phase transition: ${from} -> ${to}`);
  return to;
}

export interface Lab {
  id: string;
  sortOrder: number;
  name: string;
  location: string;
  capacity: number;
  status: string;
  description: string;
}

export interface TraceStep {
  id: string;
  kind: 'start' | 'tool' | 'answer' | 'done' | 'error' | 'cancelled';
  title: string;
  detail: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** 工具步骤的耗时 */
  ms?: number;
  /** 工具步骤：调用参数（可展开明细） */
  argsText?: string;
  /** 工具步骤：完整摘要（可展开明细；时间线上只显示 detail 一行短结论） */
  summaryFull?: string;
  /** 完整摘要是否被 display 预算截断（为真时 UI 必须提示"已截断，完整依据见结果卡"） */
  summaryTruncated?: boolean;
  /** 该步骤对应的**真实工具名**。标题是给人看的中文（失败时统一为"查询未成功"），
   *  任何需要按工具聚合的展示都必须用它，不能从中文标题反推。 */
  tool?: string;
}

export interface ServerNowInfo {
  iso: string;
  date: string;
  time: string;
  weekday: number;
  weekdayLabel: string;
  timezone: string;
}

export interface TermInfo {
  term: string;
  termStart: string | null;
  weekNo: number | null;
  weekDeterminable: boolean;
  note: string;
}

export interface StreamErrorInfo {
  code: string;
  message: string;
  hint?: string;
}

// ---- 与生产代码独立实现的日期小工具（前端只做展示，不参与事实判定）----
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function newRunId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return `run-${c.randomUUID()}`;
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 由课表查询结果推出 resultKind。**唯一判定入口**，
 * 优先级：config_insufficient（有条件的结论） > empty（无匹配） > success（命中）。
 */
function resultKindFromSchedule(r: ScheduleQueryResult): ResultKind {
  if (!r.weekDeterminable || r.reason === 'timetable_empty') return 'config_insufficient';
  if (r.reason === 'ok') return 'schedule_hit';
  return 'schedule_empty';
}

export const useRunStore = defineStore('run', () => {
  // ------------------------------ 运行生命周期 ------------------------------
  const runStatus = ref<RunStatus>('idle');
  /** 输入锁定 = 任务还在跑。只有终态事件 + 流收尾才解锁（P0 修复） */
  const inputLocked = computed(() => runStatus.value === 'running');
  /**
   * 运行相位（T1）：只用于展示与计时口径，**不接入 inputLocked 判断** ——
   * 锁的语义保持 RunStatus 原样，避免 6 处消费点行为漂移。
   */
  const phase = ref<RunPhase>('idle');
  const question = ref('');
  /** 当前任务的 runId。前端生成、随请求发送；服务端全部事件回带它 */
  const runId = ref<string | null>(null);
  const sessionId = ref<string | null>(null);
  const events = ref<RunEvent[]>([]);
  const stream = ref('');
  const error = ref<StreamErrorInfo | null>(null);
  const elapsedMs = ref(0);
  /**
   * 服务端权威耗时（run_completed.payload.ms）。**唯一允许用来显示"已工作 N 秒"的数字**；
   * 前端本地时钟的 elapsedMs 只用于运行中的进度感与取消前的时长，不冒充服务端事实。
   */
  const serverMs = ref<number | null>(null);
  /** 最近一次收到事件的时间（毫秒）。前台恢复时据此判断"是否已超过 5s 无新事件" */
  const lastEventAt = ref<number | null>(null);
  /** ops.v1：活跃轮的待确认提案（need_confirm 事件载荷）。历史轮由消息内的提案卡自持 */
  const pendingConfirm = ref<NeedConfirmPayload | null>(null);

  // ------------------------------ 上下文 ------------------------------
  const engine = ref<EngineType | null>(null);
  /** 实际产出本次回答的模型（run_completed.model 为 fallback 之后的真值，覆盖 run_started 的计划值） */
  const model = ref<string | null>(null);
  const sourceType = ref<DataSourceType | null>(null);
  const serverNow = ref<ServerNowInfo | null>(null);
  const term = ref<TermInfo | null>(null);
  const allowedTools = ref<string[]>([]);

  // ------------------------------ 结果 ------------------------------
  const lastResult = ref<ScheduleQueryResult | null>(null);
  /** 非课表类工具结果（房间状态 / 空闲名单），按 resultKind 分流渲染 */
  const extraResult = ref<{ kind: ToolResultKind; payload: LabStatusResult | FreeRoomsResult } | null>(null);

  const resultKind = computed<ResultKind>(() => {
    if (lastResult.value) return resultKindFromSchedule(lastResult.value);
    if (extraResult.value) return extraResult.value.kind === 'lab_status' ? 'lab_status' : 'free_rooms';
    return 'none';
  });

  // ------------------------------ 静态概览（/api/state）------------------------------
  const labs = ref<Lab[]>([]);
  const openLabs = ref<Lab[]>([]);
  const overviewSourceType = ref<DataSourceType | null>(null);
  /** 服务端**当前**的推理引擎。第一次任务之前就知道，界面不能靠 run_started 才敢说实话。 */
  const overviewEngine = ref<EngineType | null>(null);
  const overviewTerm = ref<{ term: string; termStart: string | null; holidays: string[] } | null>(null);
  const overviewLoaded = ref(false);
  const overviewError = ref<string | null>(null);
  const timetableCount = ref(0);
  const selectedLab = ref<string | null>(null);

  // ------------------------------ 派生 ------------------------------
  const sourceLabel = computed(() => (sourceType.value ? DATA_SOURCE_LABELS[sourceType.value] : '未知来源'));
  const overviewSourceLabel = computed(() =>
    overviewSourceType.value ? DATA_SOURCE_LABELS[overviewSourceType.value] : '未知来源'
  );

  /** 一次任务都没跑过时，用服务端上报的引擎；跑过之后以本题实际用的引擎为准 */
  const activeEngine = computed<EngineType | null>(() => engine.value ?? overviewEngine.value);

  const lessons = computed<ScheduleLesson[]>(() => lastResult.value?.lessons ?? []);

  // 房间清单调整（用于验证 APP 已更新）：去掉 D533/D532，补充 D530/D531
  const ROOM_HIDE = new Set(['D533', 'D532']);
  const ROOM_EXTRA: Lab[] = [
    { id: 'demo-d530', sortOrder: 90530, name: 'D530', location: '文渊D区5层D530', capacity: 40, status: 'active', description: '' },
    { id: 'demo-d531', sortOrder: 90531, name: 'D531', location: '文渊D区5层D531', capacity: 40, status: 'active', description: '' }
  ];
  const allRooms = computed<Lab[]>(() => {
    const base = [...labs.value, ...openLabs.value].filter((x) => !ROOM_HIDE.has(x.name));
    const names = new Set(base.map((x) => x.name));
    return [...base, ...ROOM_EXTRA.filter((x) => !names.has(x.name))];
  });

  /** 按「楼宇 → 楼层」分组，用于房间清单。location 形如「文渊E区3层E310」。 */
  const labGroups = computed(() => {
    const groups = new Map<string, { key: string; building: string; floor: string; rooms: Lab[] }>();
    for (const lab of allRooms.value) {
      const m = /(.*?区)\s*(\d+)\s*层/.exec(lab.location ?? '');
      const building = m ? m[1] : '未标注楼宇';
      const floor = m ? `${m[2]} 层` : '未标注楼层';
      const key = `${building}|${floor}`;
      const g = groups.get(key) ?? { key, building, floor, rooms: [] };
      g.rooms.push(lab);
      groups.set(key, g);
    }
    for (const g of groups.values()) g.rooms.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'));
  });

  /** 演示日期：取学期第 4 教学周的周三 —— 由 termStart 推导，不硬编码日期 */
  const demoDate = computed<string | null>(() => {
    const t = overviewTerm.value?.termStart ?? term.value?.termStart;
    if (!t) return null;
    return addDays(t, (4 - 1) * 7 + 2); // 第 4 周的周三
  });

  const exampleQuestions = computed<string[]>(() => {
    const room = selectedLab.value ?? labs.value[0]?.name ?? 'E310';
    const other = labs.value.find((l) => l.name !== room)?.name ?? 'D517';
    const d = demoDate.value;
    const list: string[] = [];
    if (d) list.push(`${room} ${d} 有哪些课？`);
    list.push(`${other} 现在开放吗？`);
    list.push(`明天下午第二大节哪些实验室空着？`);
    // 首屏示例原本全是只读查询，评委看不到本项目最有区分度的"提案→本人确认"链路。
    // 这里补一条办理类示例，并在界面注明它只会生成待确认提案、不会直接改数据。
    list.push(`${room} 投影仪没有信号，帮我报修`);
    list.push(`那 ${other} 呢？`);
    return list;
  });

  /**
   * 任务轨迹：把事件流折叠成可读步骤（不展示任何内部推理）。
   * 工具卡按 toolCallId 配对（step 只是展示序号）；时间线只放**一行短摘要**，
   * 参数与完整摘要进可展开明细。终态事件会关闭"正在生成回答"步骤 ——
   * 时间线任何时刻只允许一个确定的终态。
   */
  const trace = computed<TraceStep[]>(() => {
    const steps: TraceStep[] = [];
    const toolIndex = new Map<string, number>();
    let answerIdx: number | null = null;

    for (const ev of events.value) {
      switch (ev.type) {
        case 'run_started': {
          const p = ev.payload as {
            engine: EngineType;
            model?: string;
            sourceType: DataSourceType;
            serverNow: ServerNowInfo;
            term: TermInfo;
          };
          steps.push({
            id: `s${ev.seq}`,
            kind: 'start',
            title: '任务已受理',
            detail:
              `服务端时间 ${p.serverNow.date} ${p.serverNow.time}（${p.serverNow.weekdayLabel}）｜` +
              `数据来源：${DATA_SOURCE_LABELS[p.sourceType]}｜引擎：${p.engine === 'agnes' ? `Agnes${p.model ? ` · ${p.model}` : ''}` : p.engine === 'dashscope' ? `DashScope${p.model ? ` · ${p.model}` : ''}` : '演示引擎'}`,
            status: 'done'
          });
          break;
        }
        case 'tool_started': {
          const p = ev.payload as { tool: string; toolCallId: string; args: Record<string, unknown>; step: number };
          const args = Object.entries(p.args ?? {})
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `${k}=${String(v)}`)
            .join('，');
          toolIndex.set(p.toolCallId ?? String(p.step), steps.length);
          steps.push({
            id: `s${ev.seq}`,
            kind: 'tool',
            title: toolTitle(p.tool),
            tool: p.tool,
            detail: `调用工具 ${p.tool}${args ? `（${args}）` : ''}`,
            argsText: args || '（无参数）',
            status: 'running'
          });
          break;
        }
        case 'tool_result': {
          const p = ev.payload as {
            tool: string;
            toolCallId: string;
            ok: boolean;
            ms: number;
            summary: string;
            step: number;
            error?: { code: string; message: string };
          };
          const step: TraceStep = {
            id: `s${ev.seq}`,
            kind: 'tool',
            title: p.ok ? toolTitle(p.tool) : '查询未成功',
            tool: p.tool,
            detail: p.ok ? clampLine(p.summary, TIMELINE_DETAIL_BUDGET) : `${p.error?.code ?? 'error'}：${p.error?.message ?? ''}`,
            // display 预算：知识检索等长摘要不再无上限直塞 DOM；截断必须可见地标记
            ...(p.ok ? clampSummary(p.summary) : {}),
            status: p.ok ? 'done' : 'failed',
            ms: p.ms
          };
          const at = toolIndex.get(p.toolCallId ?? String(p.step));
          if (at !== undefined && steps[at]) steps[at] = step;
          else steps.push(step);
          break;
        }
        case 'answer_delta': {
          if (answerIdx !== null && steps[answerIdx]) {
            steps[answerIdx]!.detail = `已生成 ${stream.value.length} 字`;
          } else {
            steps.push({ id: `s${ev.seq}`, kind: 'answer', title: '正在生成回答', detail: '', status: 'running' });
            answerIdx = steps.length - 1;
          }
          break;
        }
        case 'run_completed': {
          if (answerIdx !== null && steps[answerIdx]?.status === 'running') {
            // F04：完成后关闭回答步骤并把标题改掉，不再叫"正在生成回答"
            steps[answerIdx] = { ...steps[answerIdx]!, status: 'done', title: '回答完成', detail: `回答完成（${stream.value.length} 字）` };
            answerIdx = null;
          }
          const p = ev.payload as { steps: number; toolCalls: number; ms: number };
          steps.push({
            id: `s${ev.seq}`,
            kind: 'done',
            title: '任务完成',
            detail: `工具调用 ${p.toolCalls} 次｜服务端耗时 ${p.ms} ms`,
            status: 'done'
          });
          break;
        }
        case 'run_failed': {
          if (answerIdx !== null && steps[answerIdx]?.status === 'running') {
            steps[answerIdx] = { ...steps[answerIdx]!, status: 'failed' };
            answerIdx = null;
          }
          const p = ev.payload as { code: string; message: string; hint?: string };
          steps.push({
            id: `s${ev.seq}`,
            kind: 'error',
            title: `任务失败（${p.code}）`,
            detail: `${p.message}${p.hint ? `　建议：${p.hint}` : ''}`,
            status: 'failed'
          });
          break;
        }
        case 'run_cancelled': {
          if (answerIdx !== null && steps[answerIdx]?.status === 'running') {
            steps[answerIdx] = { ...steps[answerIdx]!, status: 'cancelled' };
            answerIdx = null;
          }
          const p = ev.payload as { ms: number; message: string };
          steps.push({
            id: `s${ev.seq}`,
            kind: 'cancelled',
            title: '任务已取消',
            detail: `${p.message}（已运行 ${(p.ms / 1000).toFixed(1)} 秒）`,
            status: 'cancelled'
          });
          break;
        }
        default:
          break;
      }
    }
    // F04 修复：**没有**终态事件时不再擅自把回答步骤标成失败 ——
    // 流式进行中本来就没有终态；真正的断流由 finishRun() 合成 run_failed 事件，
    // cancelRun() 合成 run_cancelled，终态在这里统一关闭，不在计算属性里猜。
    return steps;
  });

  /** 按 toolCallId 配对的工具调用（含参数与结果），供消息渲染与历史提交使用 */
  const toolCalls = computed<
    Array<{ toolCallId: string; tool: string; args: Record<string, unknown>; ok: boolean | null; ms?: number; summary?: string; resultKind?: string; result?: unknown; error?: { code: string; message: string } }>
  >(() => {
    const map = new Map<string, { toolCallId: string; tool: string; args: Record<string, unknown>; ok: boolean | null; ms?: number; summary?: string; resultKind?: string; result?: unknown; error?: { code: string; message: string } }>();
    for (const ev of events.value) {
      if (ev.type === 'tool_started') {
        const p = ev.payload as { toolCallId: string; tool: string; args: Record<string, unknown> };
        map.set(p.toolCallId, { toolCallId: p.toolCallId, tool: p.tool, args: p.args ?? {}, ok: null });
      } else if (ev.type === 'tool_result') {
        const p = ev.payload as { toolCallId: string; tool: string; ok: boolean; ms: number; summary: string; resultKind?: string; result?: unknown; error?: { code: string; message: string } };
        const cur = map.get(p.toolCallId) ?? { toolCallId: p.toolCallId, tool: p.tool, args: {}, ok: null };
        map.set(p.toolCallId, { ...cur, ok: p.ok, ms: p.ms, summary: p.summary, resultKind: p.resultKind, result: p.result ?? null, error: p.error });
      }
    }
    return [...map.values()];
  });

  /**
   * 工具中文名由 web/lib/turn-view.ts 统一提供（此前本文件与 ChatMessage.vue
   * 各有一份映射表，会漂移 —— 合并为单一事实源）。
   */


  const periodSummary = computed(() =>
    PERIODS.map((p) => {
      const hit = lastResult.value?.byPeriod.find((b) => b.periodKey === p.key);
      return { ...p, count: hit?.count ?? 0 };
    })
  );

  // ------------------------------ 动作 ------------------------------

  let timer: number | null = null;
  /**
   * 工作计时两段式：awaiting_confirm（等人拍板）的时间**不计入工作时长**。
   * workSince === 0 表示当前处于暂停段；stopTimer 把剩余段折进 workAccum 收尾。
   */
  let workSince = 0;
  let workAccum = 0;

  function pauseWorkTimer(): void {
    if (workSince > 0) {
      workAccum += Date.now() - workSince;
      workSince = 0;
    }
  }

  function resumeWorkTimer(): void {
    if (workSince === 0 && runStatus.value === 'running') workSince = Date.now();
  }

  function stopTimer(): void {
    pauseWorkTimer();
    elapsedMs.value = workAccum;
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  /** 相位迁移的唯一入口。终态后迟到事件不改相位；白名单外的序列降级为告警，不炸运行界面。 */
  function movePhase(to: RunPhase): void {
    const from = phase.value;
    if (from === 'completed' || from === 'failed' || from === 'cancelled' || from === 'interrupted') return;
    try {
      phase.value = transitionPhase(from, to);
    } catch (e) {
      console.warn(`[run] ${(e as Error).message}`);
      return;
    }
    if (phase.value === 'awaiting_confirm') pauseWorkTimer();
    else if (from === 'awaiting_confirm') resumeWorkTimer();
  }

  /** 仍有 tool_started 未收到 tool_result 的调用数 —— 相位回 model 的依据 */
  function outstandingTools(): number {
    const started = new Set<string>();
    for (const ev of events.value) {
      if (ev.type === 'tool_started') started.add(String((ev.payload as { toolCallId?: string }).toolCallId ?? ''));
      else if (ev.type === 'tool_result') started.delete(String((ev.payload as { toolCallId?: string }).toolCallId ?? ''));
    }
    return started.size;
  }

  function ensureSessionId(): string {
    if (!sessionId.value) {
      const c = globalThis.crypto;
      sessionId.value = c && 'randomUUID' in c ? c.randomUUID() : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        const saved = localStorage.getItem('labops.sessionId');
        if (saved) sessionId.value = saved;
        else localStorage.setItem('labops.sessionId', sessionId.value);
      } catch {
        /* 隐私模式拿不到 localStorage 就用内存会话 */
      }
    }
    return sessionId.value;
  }

  function newSession(): void {
    sessionId.value = null;
    try {
      localStorage.removeItem('labops.sessionId');
    } catch {
      /* 忽略 */
    }
    resetRun();
    ensureSessionId();
  }

  function resetRun(): void {
    runStatus.value = 'idle';
    phase.value = 'idle'; // 初始化直赋值：不是事件驱动的转移，不走白名单
    question.value = '';
    runId.value = null;
    events.value = [];
    stream.value = '';
    error.value = null;
    elapsedMs.value = 0;
    serverMs.value = null;
    lastEventAt.value = null;
    engine.value = null;
    model.value = null;
    sourceType.value = null;
    serverNow.value = null;
    term.value = null;
    allowedTools.value = [];
    lastResult.value = null;
    extraResult.value = null;
    pendingConfirm.value = null;
  }

  function beginRun(q: string): string {
    resetRun();
    question.value = q;
    runId.value = newRunId();
    runStatus.value = 'running';
    movePhase('planning'); // 乐观相位：run_started 到达后重申（同态重入幂等）
    ensureSessionId();
    stopTimer();
    workAccum = 0;
    resumeWorkTimer();
    timer = window.setInterval(() => {
      elapsedMs.value = workAccum + (workSince > 0 ? Date.now() - workSince : 0);
    }, 100);
    return runId.value;
  }

  /** N01：会话端点的 runId 由服务端生成 —— 通过 run_accepted 事件采纳，事件过滤随之切换 */
  function adoptRunId(serverRunId: string): void {
    if (serverRunId && serverRunId !== runId.value) runId.value = serverRunId;
  }

  function appendEvent(ev: RunEvent): void {
    events.value = [...events.value, ev];
  }

  /** 事件入口：runId 不匹配的一律丢弃（旧任务迟到事件不得污染新任务） */
  function ingest(ev: RunEvent): void {
    if (runId.value && ev.runId !== runId.value) return;
    lastEventAt.value = Date.now();
    appendEvent(ev);
    switch (ev.type) {
      case 'run_started': {
        const p = ev.payload as {
          runId: string;
          engine: EngineType;
          model?: string;
          sourceType: DataSourceType;
          serverNow: ServerNowInfo;
          term: TermInfo;
          allowedTools: string[];
        };
        engine.value = p.engine;
        if (p.model) model.value = p.model;
        sourceType.value = p.sourceType;
        serverNow.value = p.serverNow;
        term.value = p.term;
        allowedTools.value = p.allowedTools;
        movePhase('planning');
        break;
      }
      case 'tool_started': {
        movePhase('tool');
        break;
      }
      case 'tool_result': {
        const p = ev.payload as {
          ok: boolean;
          resultKind?: ToolResultKind;
          result?: ScheduleQueryResult | LabStatusResult | FreeRoomsResult;
        };
        // 相位判定必须放在 `if (!p.result)` 之前：多数工具（准备/查询类）回传不带
        // 结构化 result，仍算"这次调用已经返回"，否则相位会永远卡在 tool。
        // 相位：仍有工具在跑保持 tool；全部返回且未出正文 → 回 model 等待
        movePhase(outstandingTools() > 0 ? 'tool' : 'model');
        if (!p.result) break;
        if (p.resultKind === 'lab_status') {
          extraResult.value = { kind: 'lab_status', payload: p.result as LabStatusResult };
        } else if (p.resultKind === 'free_rooms') {
          extraResult.value = { kind: 'free_rooms', payload: p.result as FreeRoomsResult };
        } else if (p.resultKind === 'schedule') {
          lastResult.value = p.result as ScheduleQueryResult;
        }
        // operation_proposal / operations_report 不进全局结果区：
        // 它们由消息内的提案卡 / 日报卡渲染（活跃与历史同一组件）
        // ★ 注意：这里**不改 runStatus** —— 工具结果只是中间产物，
        //   输入框要等 run_completed / run_failed / run_cancelled + 流收尾才解锁。
        break;
      }
      case 'run_completed': {
        movePhase('completed');
        if (runStatus.value === 'running') runStatus.value = 'completed';
        // R03/C04：以服务端权威全文对齐（delta 可能漏块；durable 确认在保存成功后发出）
        const p2 = ev.payload as { answer?: string; engine?: EngineType; model?: string; ms?: number };
        if(p2.engine) engine.value=p2.engine;
        // model 反映 fallback 之后真正生效的模型，覆盖 run_started 的计划值
        if(p2.model) model.value=p2.model;
        if (typeof p2.ms === 'number') serverMs.value = p2.ms;
        if (typeof p2.answer === 'string' && p2.answer) stream.value = p2.answer;
        break;
      }
      case 'save_failed': {
        // R03：保存失败必须可见 —— 保留已生成内容，但明确"刷新后可能丢失"
        const p3 = ev.payload as { message?: string; answer?: string };
        if (runStatus.value !== 'cancelled') runStatus.value = 'failed';
        movePhase('failed');
        if (typeof p3.answer === 'string') stream.value = p3.answer;
        error.value = { code: 'save_failed', message: p3.message ?? '本轮结果写入会话历史失败' };
        break;
      }
      case 'end': {
        // R03：end 是传输收尾 + 保存确认。saved=false 时状态转为 failed（可见错误），输入解锁
        const p4 = ev.payload as { saved?: boolean; saveError?: string; status?: string };
        if (p4.saved === false) {
          error.value = {
            code: 'save_failed',
            message: `本轮结果已生成，但写入会话历史失败（${p4.saveError ?? '未知原因'}）。请复制保留重要内容。`
          };
          if (runStatus.value !== 'cancelled') runStatus.value = 'failed';
        }
        movePhase(p4.saved === false ? 'failed' : 'completed');
        break;
      }
      case 'answer_delta': {
        const p = ev.payload as { text: string };
        stream.value += p.text;
        movePhase('answering');
        break;
      }
      case 'need_confirm': {
        // ops.v1：活跃轮待确认提案。卡片本体渲染在消息流内（OperationCard），
        // 这里保存载荷供"有未确认办理单"类提示使用
        pendingConfirm.value = ev.payload as NeedConfirmPayload;
        // T1：等人拍板是显式相位 —— UI 据此停 loading、暂停工作计时；runStatus 不动（输入互斥不变）
        movePhase('awaiting_confirm');
        break;
      }
      case 'task_updated':
      case 'operation_result':
        // ops.v1：本轮决策经 REST 返回；SSE 侧登记备用。事件本身保留在 events 轨迹里
        break;
      case 'run_failed': {
        const p = ev.payload as StreamErrorInfo;
        error.value = p;
        if (runStatus.value !== 'cancelled') runStatus.value = 'failed';
        movePhase('failed');
        break;
      }
      case 'run_cancelled': {
        // F05：服务端发出的取消同样是终态。此前缺这个分支会让输入永久锁住。
        // 终态幂等：只在运行中才收敛到 cancelled。取消是**正常结束**（中性态）：
        // 不置 error、不进服务端熔断计数（router.ts 对 run_cancelled 直接透传）。
        if (runStatus.value === 'running') runStatus.value = 'cancelled';
        movePhase('cancelled');
        break;
      }
      default:
        break;
    }
  }

  /** 服务端/网络层报错（非业务终态事件） */
  function failRun(err: StreamErrorInfo): void {
    // 用户主动取消由 cancelRun 呈现，不走失败
    if (err.code === 'run_cancelled') {
      cancelRun(err.message);
      return;
    }
    error.value = err;
    runStatus.value = 'failed';
    movePhase('failed');
    appendEvent({
      seq: 100000 + events.value.length,
      v: 1,
      runId: runId.value ?? 'local',
      type: 'run_failed',
      ts: new Date().toISOString(),
      payload: err
    });
  }

  /** 用户主动取消：中性终态，不是故障 */
  function cancelRun(message = '你取消了本次任务。'): void {    if (runStatus.value !== 'running') return;
    stopTimer();
    runStatus.value = 'cancelled';
    movePhase('cancelled');
    appendEvent({
      seq: 100000 + events.value.length,
      v: 1,
      runId: runId.value ?? 'local',
      type: 'run_cancelled',
      ts: new Date().toISOString(),
      payload: { ms: elapsedMs.value, message }
    });
  }

  /**
   * 用服务端快照把本轮收敛到真实终态（T5）。
   * 不合成假事件：只改生命周期与耗时事实，步骤/正文由调用方按快照整段替换消息。
   * 未拿到明确终态时调用方**不得**调用本函数（仍运行 → 继续等）。
   */
  function settleFromSnapshot(terminal: 'completed' | 'failed' | 'cancelled' | 'interrupted', ms: number | null): void {
    stopTimer();
    if (ms !== null) {
      serverMs.value = ms;
      elapsedMs.value = ms;
    }
    runStatus.value = terminal === 'completed' ? 'completed' : terminal === 'cancelled' ? 'cancelled' : 'failed';
    movePhase(terminal);
  }

  /** 事件流收尾。若没有收到任何终态事件 → 合成失败，绝不留下"永远在跑"的任务 */
  function finishRun(): void {
    stopTimer();
    if (runStatus.value === 'running') {
      const hasTerminal = events.value.some(
        (e) => e.type === 'run_completed' || e.type === 'run_failed' || e.type === 'run_cancelled'
      );
      if (!hasTerminal) {
        failRun({ code: 'stream_ended_early', message: '事件流提前结束，未收到完成事件。请重试。' });
      }
    }
  }

  let overviewGeneration = 0;
  function clearOverview(){overviewGeneration++;labs.value=[];openLabs.value=[];selectedLab.value=null;overviewLoaded.value=false;overviewError.value=null;overviewTerm.value=null;overviewSourceType.value=null;overviewEngine.value=null;timetableCount.value=0;}
  async function loadOverview(): Promise<void> {
    const generation = ++overviewGeneration;
    // 账号变更时立即移除旧来源；迟到的请求不得覆盖新身份的概览。
    labs.value = [];
    openLabs.value = [];
    overviewSourceType.value = null;
    overviewEngine.value = null;
    overviewTerm.value = null;
    selectedLab.value = null;
    timetableCount.value = 0;
    overviewLoaded.value = false;
    overviewError.value = null;
    try {
      const res = await clientFetch('/api/state', { headers: actorHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        sourceType: DataSourceType;
        engine?: EngineType;
        labs: Lab[];
        openLabs: Lab[];
        term: { term: string; termStart: string | null; holidays: string[] };
        timetableCount: number;
      };
      if (generation !== overviewGeneration) return;
      labs.value = j.labs ?? [];
      openLabs.value = j.openLabs ?? [];
      overviewSourceType.value = j.sourceType;
      overviewEngine.value = j.engine ?? null;
      overviewTerm.value = j.term;
      timetableCount.value = j.timetableCount ?? 0;
      overviewLoaded.value = true;
      overviewError.value = null;
      if (!selectedLab.value && labs.value.length) selectedLab.value = labs.value[0]?.name ?? null;
    } catch (e) {
      if (generation !== overviewGeneration) return;
      overviewError.value = `无法载入实验室概览：${(e as Error).message}`;
      overviewLoaded.value = true;
    }
  }

  return {
    // state
    runStatus,
    phase,
    inputLocked,
    question,
    runId,
    sessionId,
    events,
    stream,
    error,
    elapsedMs,
    serverMs,
    lastEventAt,
    engine,
    model,
    sourceType,
    serverNow,
    term,
    allowedTools,
    lastResult,
    extraResult,
    resultKind,
    pendingConfirm,
    labs,
    openLabs,
    overviewSourceType,
    overviewEngine,
    overviewTerm,
    overviewLoaded,
    overviewError,
    timetableCount,
    selectedLab,
    // derived
    sourceLabel,
    overviewSourceLabel,
    activeEngine,
    lessons,
    allRooms,
    labGroups,
    demoDate,
    exampleQuestions,
    trace,
    toolCalls,
    periodSummary,
    // actions
    resetRun,
    beginRun,
    adoptRunId,
    ingest,
    failRun,
    cancelRun,
    settleFromSnapshot,
    finishRun,
    newSession,
    loadOverview,clearOverview,
    RUN_EVENT_TYPES
  };
});
