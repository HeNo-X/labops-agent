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
import { PERIODS } from '@shared/periods';

export type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ResultKind = 'none' | 'schedule_hit' | 'schedule_empty' | 'config_insufficient' | 'lab_status' | 'free_rooms';

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
  const question = ref('');
  /** 当前任务的 runId。前端生成、随请求发送；服务端全部事件回带它 */
  const runId = ref<string | null>(null);
  const sessionId = ref<string | null>(null);
  const events = ref<RunEvent[]>([]);
  const stream = ref('');
  const error = ref<StreamErrorInfo | null>(null);
  const elapsedMs = ref(0);
  /** 预留：真实待确认写操作（阶段 2B）。第一阶段恒为 null → ConfirmDock 不渲染 */
  const pendingConfirm = ref<null>(null);

  // ------------------------------ 上下文 ------------------------------
  const engine = ref<EngineType | null>(null);
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

  const allRooms = computed<Lab[]>(() => [...labs.value, ...openLabs.value]);

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
    let terminalSeen = false;

    for (const ev of events.value) {
      switch (ev.type) {
        case 'run_started': {
          const p = ev.payload as {
            engine: EngineType;
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
              `数据来源：${DATA_SOURCE_LABELS[p.sourceType]}｜引擎：${p.engine === 'agnes' ? 'Agnes 3.0 Flash' : '演示引擎'}`,
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
            detail: `调用只读工具 ${p.tool}${args ? `（${args}）` : ''}`,
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
            detail: p.ok ? p.summary : `${p.error?.code ?? 'error'}：${p.error?.message ?? ''}`,
            summaryFull: p.ok ? p.summary : undefined,
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
          terminalSeen = true;
          if (answerIdx !== null && steps[answerIdx]?.status === 'running') {
            steps[answerIdx] = { ...steps[answerIdx]!, status: 'done', detail: `回答完成（${stream.value.length} 字）` };
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
          terminalSeen = true;
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
          terminalSeen = true;
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
    // 流收尾仍未见终态事件：答案步骤不可能再推进，置为失败避免"永远进行中"
    if (!terminalSeen) {
      for (const s of steps) if (s.kind === 'answer' && s.status === 'running') s.status = 'failed';
    }
    return steps;
  });

  function toolTitle(tool: string): string {
    switch (tool) {
      case 'query_schedule':
        return '查询课表';
      case 'query_lab_status':
        return '查询房间状态';
      case 'query_free_rooms':
        return '查找空闲房间';
      default:
        return `执行 ${tool}`;
    }
  }

  const periodSummary = computed(() =>
    PERIODS.map((p) => {
      const hit = lastResult.value?.byPeriod.find((b) => b.periodKey === p.key);
      return { ...p, count: hit?.count ?? 0 };
    })
  );

  // ------------------------------ 动作 ------------------------------

  let timer: number | null = null;

  function stopTimer(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
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
    question.value = '';
    runId.value = null;
    events.value = [];
    stream.value = '';
    error.value = null;
    elapsedMs.value = 0;
    engine.value = null;
    sourceType.value = null;
    serverNow.value = null;
    term.value = null;
    allowedTools.value = [];
    lastResult.value = null;
    extraResult.value = null;
  }

  function beginRun(q: string): void {
    resetRun();
    question.value = q;
    runId.value = newRunId();
    runStatus.value = 'running';
    ensureSessionId();
    const t0 = Date.now();
    stopTimer();
    timer = window.setInterval(() => {
      elapsedMs.value = Date.now() - t0;
    }, 100);
  }

  function appendEvent(ev: RunEvent): void {
    events.value = [...events.value, ev];
  }

  /** 事件入口：runId 不匹配的一律丢弃（旧任务迟到事件不得污染新任务） */
  function ingest(ev: RunEvent): void {
    if (runId.value && ev.runId !== runId.value) return;
    appendEvent(ev);
    switch (ev.type) {
      case 'run_started': {
        const p = ev.payload as {
          runId: string;
          engine: EngineType;
          sourceType: DataSourceType;
          serverNow: ServerNowInfo;
          term: TermInfo;
          allowedTools: string[];
        };
        engine.value = p.engine;
        sourceType.value = p.sourceType;
        serverNow.value = p.serverNow;
        term.value = p.term;
        allowedTools.value = p.allowedTools;
        break;
      }
      case 'tool_result': {
        const p = ev.payload as {
          ok: boolean;
          resultKind?: ToolResultKind;
          result?: ScheduleQueryResult | LabStatusResult | FreeRoomsResult;
        };
        if (!p.result) break;
        if (p.resultKind === 'lab_status') {
          extraResult.value = { kind: 'lab_status', payload: p.result as LabStatusResult };
        } else if (p.resultKind === 'free_rooms') {
          extraResult.value = { kind: 'free_rooms', payload: p.result as FreeRoomsResult };
        } else {
          lastResult.value = p.result as ScheduleQueryResult;
        }
        // ★ 注意：这里**不改 runStatus** —— 工具结果只是中间产物，
        //   输入框要等 run_completed / run_failed / run_cancelled + 流收尾才解锁。
        break;
      }
      case 'run_completed': {
        if (runStatus.value === 'running') runStatus.value = 'completed';
        break;
      }
      case 'answer_delta': {
        const p = ev.payload as { text: string };
        stream.value += p.text;
        break;
      }
      case 'run_failed': {
        const p = ev.payload as StreamErrorInfo;
        error.value = p;
        runStatus.value = 'failed';
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
  function cancelRun(message = '你取消了本次任务。'): void {
    if (runStatus.value !== 'running') return;
    stopTimer();
    runStatus.value = 'cancelled';
    appendEvent({
      seq: 100000 + events.value.length,
      v: 1,
      runId: runId.value ?? 'local',
      type: 'run_cancelled',
      ts: new Date().toISOString(),
      payload: { ms: elapsedMs.value, message }
    });
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

  async function loadOverview(): Promise<void> {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        sourceType: DataSourceType;
        engine?: EngineType;
        labs: Lab[];
        openLabs: Lab[];
        term: { term: string; termStart: string | null; holidays: string[] };
        timetableCount: number;
      };
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
      overviewError.value = `无法载入实验室概览：${(e as Error).message}`;
      overviewLoaded.value = true;
    }
  }

  return {
    // state
    runStatus,
    inputLocked,
    question,
    runId,
    sessionId,
    events,
    stream,
    error,
    elapsedMs,
    engine,
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
    periodSummary,
    // actions
    resetRun,
    beginRun,
    ingest,
    failRun,
    cancelRun,
    finishRun,
    newSession,
    loadOverview,
    RUN_EVENT_TYPES
  };
});
