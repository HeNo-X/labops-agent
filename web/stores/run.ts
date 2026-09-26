/**
 * 任务画布状态机 —— 显式状态，不用散落的布尔值（难点 6 对策 2）
 * ============================================================================
 *  六个状态覆盖验收表要求：
 *    idle                 初始
 *    running              查询中
 *    success              查询成功
 *    empty                无匹配（房间不存在 / 当天无课 / 该节次无课）
 *    config_insufficient  配置不足（缺学期起始日 / 课表为空 → 结果是有条件的）
 *    error                网络或服务端错误
 *
 *  状态优先级：error > config_insufficient > empty > success
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  DataSourceType,
  EngineType,
  RunEvent,
  ScheduleQueryResult,
  ScheduleLesson
} from '@shared/types';
import { DATA_SOURCE_LABELS, RUN_EVENT_TYPES } from '@shared/types';
import { PERIODS } from '@shared/periods';

export type RunPhase = 'idle' | 'running' | 'success' | 'empty' | 'config_insufficient' | 'error';

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
  kind: 'start' | 'tool' | 'answer' | 'done' | 'error';
  title: string;
  detail: string;
  status: 'running' | 'done' | 'failed';
  /** 工具步骤的耗时 */
  ms?: number;
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

/**
 * 由一次查询结果推出界面状态。**唯一判定入口** ——
 * tool_result 与 run_completed 都走这里，避免两处逻辑漂移出不一致的界面。
 * 优先级：config_insufficient（有条件的结论） > empty（无匹配） > success
 */
function phaseFromResult(r: ScheduleQueryResult): RunPhase {
  if (!r.weekDeterminable || r.reason === 'timetable_empty') return 'config_insufficient';
  if (r.reason === 'ok') return 'success';
  return 'empty';
}

export const useRunStore = defineStore('run', () => {
  // ------------------------------ 运行状态 ------------------------------
  const phase = ref<RunPhase>('idle');
  const question = ref('');
  const runId = ref<string | null>(null);
  const events = ref<RunEvent[]>([]);
  const stream = ref('');
  const error = ref<StreamErrorInfo | null>(null);
  const elapsedMs = ref(0);

  // ------------------------------ 上下文 ------------------------------
  const engine = ref<EngineType | null>(null);
  const sourceType = ref<DataSourceType | null>(null);
  const serverNow = ref<ServerNowInfo | null>(null);
  const term = ref<TermInfo | null>(null);
  const allowedTools = ref<string[]>([]);

  // ------------------------------ 结果 ------------------------------
  const lastResult = ref<ScheduleQueryResult | null>(null);

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
  const engineLabel = computed(() =>
    engine.value === 'agnes' ? 'Agnes 3.0 Flash' : engine.value === 'demo' ? '演示引擎（服务端规则）' : '—'
  );

  /** 一次任务都没跑过时，用服务端上报的引擎；跑过之后以本题实际用的引擎为准 */
  const activeEngine = computed<EngineType | null>(() => engine.value ?? overviewEngine.value);

  /** 数据来源的说明文案。绝不把脱敏快照/模拟演示说成实时数据。 */
  const sourceCaveat = computed(() => {
    switch (sourceType.value) {
      case 'live':
        return '实时数据：直接读取当前真实 state.json';
      case 'snapshot':
        return '脱敏快照：从真实数据导出后已脱敏，非实时';
      case 'demo':
        return '模拟演示：内置示例数据，与真实实验室无关';
      default:
        return '—';
    }
  });

  const lessons = computed<ScheduleLesson[]>(() => lastResult.value?.lessons ?? []);

  const allRooms = computed<Lab[]>(() => [...labs.value, ...openLabs.value]);

  /** 按「楼宇 → 楼层」分组，用于编号矩阵。location 形如「文渊E区3层E310」。 */
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
    list.push(`${room} 今天有哪些课？`);
    list.push(`下周三 ${other} 有哪些课？`);
    list.push(`${room} 下午第二大节有哪些课？`);
    return list;
  });

  /** 任务轨迹：把事件流折叠成可读步骤（不展示任何内部推理） */
  const trace = computed<TraceStep[]>(() => {
    const steps: TraceStep[] = [];
    const toolIndex = new Map<string, number>();

    for (const ev of events.value) {
      switch (ev.type) {
        case 'run_started': {
          const p = ev.payload as {
            engine: EngineType;
            sourceType: DataSourceType;
            serverNow: ServerNowInfo;
            resolvedTimeHint: { raw: string | null; date: string | null; source: string };
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
          const p = ev.payload as { tool: string; args: Record<string, unknown>; step: number };
          const args = Object.entries(p.args)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(', ');
          toolIndex.set(`${p.step}`, steps.length);
          steps.push({
            id: `s${ev.seq}`,
            kind: 'tool',
            title: '正在查询课表',
            detail: `调用只读工具 ${p.tool}(${args || '无参数'})`,
            status: 'running'
          });
          break;
        }
        case 'tool_result': {
          const p = ev.payload as {
            tool: string;
            ok: boolean;
            ms: number;
            summary: string;
            step: number;
            error?: { code: string; message: string };
          };
          const at = toolIndex.get(`${p.step}`);
          const step: TraceStep = {
            id: `s${ev.seq}`,
            kind: 'tool',
            title: p.ok ? '已获得结果' : '查询未成功',
            detail: p.ok ? p.summary : `${p.error?.code ?? 'error'}：${p.error?.message ?? ''}`,
            status: p.ok ? 'done' : 'failed',
            ms: p.ms
          };
          if (at !== undefined && steps[at]) steps[at] = step;
          else steps.push(step);
          break;
        }
        case 'answer_delta': {
          const last = steps[steps.length - 1];
          if (last && last.kind === 'answer') {
            last.detail = `已生成 ${stream.value.length} 字`;
          } else {
            steps.push({ id: `s${ev.seq}`, kind: 'answer', title: '正在生成回答', detail: '', status: 'running' });
          }
          break;
        }
        case 'run_completed': {
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
        default:
          break;
      }
    }
    return steps;
  });

  const periodSummary = computed(() =>
    PERIODS.map((p) => {
      const hit = lastResult.value?.byPeriod.find((b) => b.periodKey === p.key);
      return { ...p, count: hit?.count ?? 0 };
    })
  );

  // ------------------------------ 动作 ------------------------------

  let timer: number | null = null;

  function resetRun(): void {
    phase.value = 'idle';
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
  }

  function beginRun(q: string): void {
    resetRun();
    question.value = q;
    phase.value = 'running';
    const t0 = Date.now();
    if (timer !== null) window.clearInterval(timer);
    timer = window.setInterval(() => {
      elapsedMs.value = Date.now() - t0;
    }, 100);
  }

  function ingest(ev: RunEvent): void {
    events.value = [...events.value, ev];
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
        runId.value = p.runId;
        engine.value = p.engine;
        sourceType.value = p.sourceType;
        serverNow.value = p.serverNow;
        term.value = p.term;
        allowedTools.value = p.allowedTools;
        break;
      }
      case 'tool_result': {
        const p = ev.payload as { ok: boolean; result?: ScheduleQueryResult };
        if (p.result) {
          lastResult.value = p.result;
          phase.value = phaseFromResult(p.result);
        }
        break;
      }
      case 'run_completed': {
        // ★ 真 bug 修复：不调工具的路径（越界问题、能力外问题、演示引擎直接作答）
        //   永远不会产生 tool_result，如果只靠 tool_result 推进状态机，
        //   phase 会永远停在 'running'，界面一直转圈、轨迹一直显示"查询中"。
        //   所以 run_completed 必须兜底推进状态。
        if (phase.value === 'running') {
          phase.value = lastResult.value ? phaseFromResult(lastResult.value) : 'success';
        }
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
        phase.value = 'error';
        break;
      }
      default:
        break;
    }
  }

  function failRun(err: StreamErrorInfo): void {
    error.value = err;
    phase.value = 'error';
    const synthetic: RunEvent = {
      seq: 100000 + events.value.length,
      v: 1,
      runId: runId.value ?? 'local',
      type: 'run_failed',
      ts: new Date().toISOString(),
      payload: err
    };
    events.value = [...events.value, synthetic];
  }

  function finishRun(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    if (phase.value === 'running') {
      // 流正常结束但没拿到 run_completed（例如服务端异常中断）
      if (!events.value.some((e) => e.type === 'run_completed')) {
        failRun({ code: 'stream_ended_early', message: '事件流提前结束，未收到完成事件。请重试。' });
      } else {
        phase.value = lastResult.value ? phaseFromResult(lastResult.value) : 'success';
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
    phase,
    question,
    runId,
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
    engineLabel,
    activeEngine,
    sourceCaveat,
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
    finishRun,
    loadOverview,
    RUN_EVENT_TYPES
  };
});
