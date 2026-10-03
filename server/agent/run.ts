/**
 * Agent 编排 —— 有界自主循环（C5）
 * ============================================================================
 *  停止条件（四个都要有，缺一个就是事故）：
 *    ① max_steps   —— 最多 AGENT_MAX_STEPS 步（默认 6），到点强制收敛
 *    ② 墙钟上限     —— AGENT_WALL_CLOCK_MS（默认 60s），超时立即收敛
 *    ③ 无工具调用   —— 模型不再要求调工具 ⇒ 已可作答，正常结束
 *    ④ 重复调用检测 —— 同一 (工具名+参数) 连续出现 2 次 ⇒ 打断，用已有结果作答
 *  人工接管点：第一阶段没有写操作，因此不需要阻塞式确认；预留事件在 shared/types.ts。
 *
 *  两个引擎（agnes / demo）产出**完全同构**的事件流，前端不需要区分。
 */

import type {
  AnswerDeltaPayload,
  DataSourceType,
  EngineType,
  RunCompletedPayload,
  RunEvent,
  RunEventType,
  RunFailedPayload,
  RunStartedPayload,
  ToolResultPayload,
  ToolStartedPayload
} from '../../shared/types.ts';
import type { NeedConfirmPayload, Proposal, SandboxActor } from '../../shared/operations-contract.ts';
import { getConfig } from '../config.ts';
import { loadDataset } from '../data/store.ts';
import type { Dataset } from '../data/store.ts';
import { loggerFor, newTraceId, Stopwatch } from '../obs/trace.ts';
import type { Logger } from '../obs/trace.ts';
import { describeWeek, serverNow } from '../time/term.ts';
import type { ServerNow } from '../time/term.ts';
import { isAgnesConfigured, AgnesError, streamChat } from '../llm/agnes.ts';
import type { ChatMessage, TokenUsage } from '../llm/agnes.ts';
import { executeTool, toolSpecs } from '../tools/registry.ts';
import { availableRoomNames } from '../tools/query-schedule.ts';
import { LAB_STATUS_RE } from './demo-engine.ts';
import { buildTimeContext, parseIntent } from './intent.ts';
import type { Intent } from './intent.ts';
import { getSession, rememberSession } from './session.ts';
import { loadContext } from '../persistence/db.ts';
import { planDemo, renderDemoAnswer, runDemoTool, FREE_ROOMS_RE, SMALLTALK_RE } from './demo-engine.ts';
import { PROMPT_VERSION, buildSystemPrompt, detectInjection, sanitizeInput } from './prompts.ts';
import { normalizeLabName } from '../data/store.ts';

export interface RunInput {
  question: string;
  /** 不传则自动生成 */
  runId?: string;
  /** 会话 id：服务端据此承接该会话上一问的房间/日期指代 */
  sessionId?: string;
  /** 会话类型（服务端权威存储）：task=任务工作台（默认）；chat=纯聊天，无工具、不能执行任务操作 */
  mode?: 'chat' | 'task';
  /** ops.v1：服务端解析的沙盒演示身份（写操作准备必需；不传则 prepare 工具报 no_actor） */
  actor?: SandboxActor;
  /** 客户端断开时置位：模型请求与流式输出随即停止，不再产生新事件 */
  signal?: AbortSignal;
  /** N07：本轮结束时回传最终可信上下文（会话 API 落库用） */
  onContext?: (ctx: { labName: string | null; date: string | null; task: string | null }) => void;
}

/** 本轮问题指向的任务类型（N08 继承用） */
function planTaskOf(question: string): string | null {
  if (FREE_ROOMS_RE.test(question)) return 'free_rooms';
  if (LAB_STATUS_RE.test(question)) return 'lab_status';
  if (/(课|排课|课表)/.test(question)) return 'schedule';
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function* runAgent(input: RunInput): AsyncGenerator<RunEvent> {
  const cfg = getConfig();
  let runId = input.runId ?? newTraceId('run');
  let seq = 0;
  const emit = <T extends RunEventType, P>(type: T, payload: P): RunEvent<T, P> => ({
    seq: seq++,
    v: 1,
    runId,
    type,
    ts: nowIso(),
    payload
  });

  const question = sanitizeInput(input.question);
  const log = loggerFor(runId, { question: question.slice(0, 80), promptVersion: PROMPT_VERSION });
  const watch = Stopwatch0();

  let ds: Dataset;
  let now: ServerNow;
  try {
    ds = loadDataset();
    now = serverNow();
  } catch (err) {
    yield emit('run_failed', {
      code: 'data_unavailable',
      message: `无法载入数据：${(err as Error).message}`,
      hint: '在 labops-agent 目录执行：npx tsx seed/make-snapshot.ts <真实 state.json 路径>'
    } satisfies RunFailedPayload);
    return;
  }

  const sourceType: DataSourceType = ds.sourceType;
  const engine: EngineType = isAgnesConfigured() ? 'agnes' : 'demo';
  const intent: Intent = parseIntent(question, now);

  // ---- 会话承接（阶段 2A）：缺房间/日期时显式沿用上一问，且必须留痕 ----
  // F13 继承纪律：
  //   · 找空闲房间/寒暄/能力外问题不继承房间号（范围语义不同或无必要）；
  //   · 非法日期绝不继承，也绝不静默回落（dateInvalid 分支直接显式报错）；
  //   · 只有真实存在的房间才允许写入会话记忆（E999 这类错误实体不能升级为上下文）。
  const roomlessIntent = FREE_ROOMS_RE.test(question) || SMALLTALK_RE.test(question.trim());
  let sess = getSession(input.sessionId);
  // N07：进程重启后内存表为空 → 从会话库的 ContextSnapshot 回退加载
  if (!sess && input.sessionId?.startsWith('conv-')) {
    const snap = loadContext(input.sessionId);
    if (snap) sess = { labName: snap.labName, date: snap.date, periodKey: null, lastTask: snap.task, question: '', updatedAt: Date.now() };
  }
  // N08：追问默认继承上一问的**任务类型**（"那 E312 呢"保持状态查询，不跳回课表）
  if (sess?.labName || sess?.date) intent.lastTask = sess.lastTask ?? intent.lastTask;
  if (sess && !roomlessIntent && !intent.dateInvalid) {
    if (!intent.labName && sess.labName) {
      intent.labName = sess.labName;
      intent.notes.push(`未识别到房间号，沿用上一问的 ${sess.labName}`);
    }
    if (!intent.date && sess.date) {
      intent.date = {
        date: sess.date,
        raw: '（沿用上一问）',
        source: `本轮未识别到日期指代，沿用上一问的 ${sess.date}`
      };
      intent.notes.push(`未识别到日期指代，沿用上一问的 ${sess.date}`);
    }
    // 注意：节次（periodKey/periodKeys）不沿用 —— 节次过滤过强容易把"换个房间再问"变成"查不到"，宁缺勿错
  }
  {
    const knownRooms = new Set(availableRoomNames(ds).map((n) => normalizeLabName(n)));
    const task: string | null =
      intent.dateInvalid || roomlessIntent ? (sess?.lastTask ?? null) : (planTaskOf(question) ?? sess?.lastTask ?? null);
    const finalCtx = {
      labName: intent.labName && knownRooms.has(normalizeLabName(intent.labName)) ? intent.labName : (sess?.labName ?? null),
      date: intent.dateInvalid ? (sess?.date ?? null) : (intent.date?.date ?? sess?.date ?? null),
      task
    };
    rememberSession(input.sessionId, { ...finalCtx, task: finalCtx.task, periodKey: intent.periodKey ?? sess?.periodKey ?? null, question });
    input.onContext?.({ labName: finalCtx.labName, date: finalCtx.date, task: finalCtx.task });
  }

  const week = describeWeek(intent.date?.date ?? now.date, ds.term);
  // 会话类型：chat=聊天（可查询真实数据，不能办理业务）；task=任务（可生成办理单）
  // 用户口径：聊天模式只是不能"执行操作"，数据读取与回答照常 —— 查询类工具全部保留
  const convMode: 'chat' | 'task' = input.mode === 'chat' ? 'chat' : 'task';
  const modeTools = convMode === 'chat' ? toolSpecs().filter((t) => t.name.startsWith('query_')) : toolSpecs();
  const toolListText =
    '【可用工具】\n' + modeTools.map((t) => `- ${t.name}：${t.description}`).join('\n');
  const injectionSuspected = detectInjection(question);

  log.info('run_started', { engine, sourceType, weekNo: week.weekNo, injectionSuspected });

  yield emit('run_started', {
    runId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    question,
    engine,
    sourceType,
    serverNow: {
      iso: now.iso,
      date: now.date,
      time: now.time,
      weekday: now.weekday,
      weekdayLabel: now.weekdayLabel,
      timezone: 'Asia/Shanghai'
    },
    resolvedTimeHint: {
      raw: intent.date?.raw ?? null,
      date: intent.date?.date ?? null,
      source: intent.date?.source ?? '未识别日期指代'
    },
    term: {
      term: ds.term.term,
      termStart: ds.term.termStart,
      weekNo: week.weekNo,
      weekDeterminable: week.determinable,
      note: week.note
    },
    allowedTools: modeTools.map((t) => t.name)
  } satisfies RunStartedPayload);

  try {
    if (input.signal?.aborted) return;
    if (engine === 'demo') {
      yield* runDemoEngine({ question, intent, ds, now, emit, log, runId, watch, sourceType, signal: input.signal, actor: input.actor, conversationId: input.sessionId ?? null, mode: convMode });
    } else {
      yield* runAgnesEngine({
        question,
        intent,
        ds,
        now,
        emit,
        log,
        runId,
        watch,
        sourceType,
        signal: input.signal,
        actor: input.actor,
        conversationId: input.sessionId ?? null,
        mode: convMode,
        week,
        toolListText,
        injectionSuspected
      });
    }
  } catch (err) {
    // 客户端主动断开不算故障：流被上层 abort 收尾即可，不必再补 run_failed
    if (input.signal?.aborted) return;
    const failed = toRunFailed(err, cfg.agent.wallClockMs);
    log.error('run_failed', { code: failed.code, message: failed.message, ms: watch.ms });
    yield emit('run_failed', failed);
    return;
  }
}

function Stopwatch0(): Stopwatch {
  return new Stopwatch();
}

// ===========================================================================
//  演示引擎（无 AGNES_API_KEY）
// ===========================================================================

interface DemoArgs {
  question: string;
  intent: Intent;
  ds: Dataset;
  now: ServerNow;
  emit: <T extends RunEventType, P>(type: T, payload: P) => RunEvent<T, P>;
  log: Logger;
  runId: string;
  watch: Stopwatch;
  sourceType: DataSourceType;
  signal?: AbortSignal;
  /** ops.v1：服务端注入的沙盒演示身份与会话（prepare 工具必需） */
  actor?: SandboxActor;
  conversationId?: string | null;
  /** 会话类型：chat=纯聊天（无工具，演示引擎下诚实说明能力边界） */
  mode?: 'chat' | 'task';
}

async function* runDemoEngine(a: DemoArgs): AsyncGenerator<RunEvent> {
  const plan = planDemo(a.question, a.intent, a.ds);
  a.log.info('demo_plan', { callTool: plan.callTool, args: plan.args, disclosures: plan.needsDisclosure, mode: a.mode });

  // 用户口径（2A.4 复核）：聊天模式可以查真实数据，只是不能办理业务。
  // 演示引擎在聊天模式下照常路由查询工具；仅当问题指向业务办理（prepare_*/报告单）时
  // 诚实告知需切换任务模式。
  if (a.mode === 'chat' && plan.callTool && !String(plan.tool).startsWith('query_')) {
    const OPS_NAMES: Record<string, string> = {
      prepare_issue_ticket: '报修工单',
      prepare_room_closure: '房间停用',
      prepare_notification: '通知发布',
      prepare_duty_session: '值班安排',
      create_operations_report: '运营报告'
    };
    const text =
      '「聊天」模式只提供查询（课表 / 房间状态 / 空闲房间），不生成业务办理单。' +
      `请切换到「任务」模式后再办理${OPS_NAMES[String(plan.tool)] ?? ''}。`;
    yield* streamText(text, a.emit, a.signal);
    yield a.emit('run_completed', {
      answer: text,
      steps: 0,
      toolCalls: 0,
      ms: a.watch.ms,
      sourceType: a.sourceType,
      engine: 'demo'
    } satisfies RunCompletedPayload);
    return;
  }

  if (!plan.callTool) {
    const text = (plan.directReply ?? '我无法处理这个问题。') + renderDisclosure(plan.needsDisclosure, true);
    yield* streamText(text, a.emit, a.signal);
    yield a.emit('run_completed', {
      answer: text,
      steps: 0,
      toolCalls: 0,
      ms: a.watch.ms,
      sourceType: a.sourceType,
      engine: 'demo'
    } satisfies RunCompletedPayload);
    return;
  }

  // ---- 调工具（与 Agnes 引擎共用同一注册表实现）----
  const toolCallId = 'tc1_1';
  yield a.emit('tool_started', {
    step: 1,
    toolCallId,
    tool: plan.tool,
    args: plan.args,
    sourceType: a.sourceType
  } satisfies ToolStartedPayload);

  const t0 = Date.now();
  const exec = await runDemoTool(plan.tool, plan.args, {
    dataset: a.ds,
    now: a.now,
    actor: a.actor,
    conversationId: a.conversationId ?? null
  });
  const ms = Date.now() - t0;

  if (!exec.ok) {
    yield a.emit('tool_result', {
      step: 1,
      toolCallId,
      tool: plan.tool,
      ok: false,
      ms,
      sourceType: a.sourceType,
      summary: exec.summary,
      error: { code: exec.code, message: exec.message }
    } satisfies ToolResultPayload);
  } else {
    yield a.emit('tool_result', {
      step: 1,
      toolCallId,
      tool: plan.tool,
      ok: true,
      ms,
      sourceType: a.sourceType,
      resultKind: exec.resultKind,
      summary: exec.summary,
      result: exec.result
    } satisfies ToolResultPayload);
    // ops.v1：prepare 工具产出待确认提案 → need_confirm（前端活跃轮渲染提案卡）
    if (exec.resultKind === 'operation_proposal') {
      yield a.emit('need_confirm', {
        taskId: (exec.result as Proposal).taskId,
        proposal: exec.result as Proposal,
        allowedDecisions: ['confirm', 'reject']
      } satisfies NeedConfirmPayload);
    }
  }

  const answer = exec.ok
    ? renderDemoAnswer({ kind: exec.resultKind, payload: exec.result }, {
        dateWasDefaulted: !a.intent.date,
        periodFiltered: Boolean(a.intent.periodKey)
      })
    : `${exec.message}${exec.suggestions.length ? `\n可选：${exec.suggestions.join('、')}` : ''}`;

  const full = answer + renderDisclosure(plan.needsDisclosure, false);
  yield* streamText(full, a.emit, a.signal);

  yield a.emit('run_completed', {
    answer: full,
    steps: 1,
    toolCalls: 1,
    ms: a.watch.ms,
    sourceType: a.sourceType,
    engine: 'demo',
    ...(exec.ok && exec.resultKind === 'operation_proposal' ? { taskStatus: 'awaiting_confirmation' } : {})
  } satisfies RunCompletedPayload);
}

/** 演示引擎的披露话术 —— 必须让用户一眼看出"这段文字不是大模型生成的" */
function renderDisclosure(extra: string[], short: boolean): string {
  const base = short
    ? '\n\n（演示引擎：本条回答由服务端规则生成，未调用大模型。）'
    : '\n\n（演示引擎：本条回答由服务端规则解析并渲染，未调用大模型；数据仍来自上方的数据来源。）';
  const tail = extra.length ? '\n' + extra.map((e) => `· ${e}`).join('\n') : '';
  return base + tail;
}

/** 把文本切块成 answer_delta —— 顺带真实检验前端的 UTF-8 分块拼接；abort 后立即停止 */
async function* streamText(
  text: string,
  emit: <T extends RunEventType, P>(type: T, payload: P) => RunEvent<T, P>,
  signal?: AbortSignal
): AsyncGenerator<RunEvent> {
  const CHUNK = 24;
  const chars = [...text];
  for (let i = 0; i < chars.length; i += CHUNK) {
    if (signal?.aborted) return;
    const piece = chars.slice(i, i + CHUNK).join('');
    yield emit('answer_delta', { text: piece } satisfies AnswerDeltaPayload);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ===========================================================================
//  Agnes 引擎
// ===========================================================================

interface AgnesArgs extends Omit<DemoArgs, 'sourceType'> {
  sourceType: DataSourceType;
  week: { weekNo: number | null; determinable: boolean; note: string };
  toolListText: string;
  injectionSuspected: boolean;
}

async function* runAgnesEngine(a: AgnesArgs): AsyncGenerator<RunEvent> {
  const cfg = getConfig();
  const system = buildSystemPrompt({
    timeContext: buildTimeContext(a.now, a.intent, a.week.note),
    toolList: a.toolListText,
    sourceTypeLabel: a.ds.sourceLabel,
    injectionSuspected: a.injectionSuspected,
    chatMode: a.mode === 'chat'
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: a.question }
  ];

  let steps = 0;
  let toolCalls = 0;
  let answer = '';
  let usage: TokenUsage | null = null;
  let lastToolSummary: string | null = null;
  /** ops.v1：本轮产出了待确认提案时，run_completed 必须如实带出任务状态 */
  let runTaskStatus: 'awaiting_confirmation' | undefined = undefined;
  /** 指纹 = 工具名 + 排序后的规范化参数；在**执行前**检查（写工具接入后防重复执行） */
  const seenCalls = new Map<string, number>();

  while (steps < cfg.agent.maxSteps) {
    if (a.signal?.aborted) return;
    if (a.watch.ms > cfg.agent.wallClockMs) {
      a.log.warn('wall_clock_exceeded', { steps, ms: a.watch.ms });
      answer += (answer ? '\n\n' : '') + `（已达单次任务时间上限 ${cfg.agent.wallClockMs} ms，以下为已获得的结果。）`;
      break;
    }
    steps += 1;

    let roundText = '';
    let calls: ChatMessage['tool_calls'] = undefined;

    for await (const ev of streamChat({ messages, tools: a.mode === 'chat' ? undefined : toolSpecs(), signal: a.signal }, a.log)) {
      if (ev.type === 'text') {
        roundText += ev.text;
        answer += ev.text;
        yield a.emit('answer_delta', { text: ev.text } satisfies AnswerDeltaPayload);
      } else if (ev.type === 'tool_calls') {
        calls = ev.calls as ChatMessage['tool_calls'];
      } else if (ev.type === 'usage') {
        usage = ev.usage;
      }
    }

    if (!calls || calls.length === 0) break; // 停止条件③：不再需要工具

    messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: calls
    });

    for (let ci = 0; ci < calls.length; ci++) {
      const call = calls[ci]!;
      const name = call.function.name;
      let rawArgs: Record<string, unknown> = {};
      try {
        rawArgs = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        // 容错解析（难点 1 对策 1）：JSON 坏了不中断，回一条可恢复错误让模型重来
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: false,
            code: 'bad_tool_arguments_json',
            message: `工具参数不是合法 JSON：${call.function.arguments?.slice(0, 200)}。请重新输出严格的 JSON 对象。`
          })
        });
        continue;
      }

      // 停止条件④：重复检测在**执行之前**（指纹含工具名）。
      // 命中即拦截：不执行、不发 tool_started，只回 tool 消息与一条可观察的拦截记录。
      const dupKey = `${name}::${fnKey(rawArgs)}`;
      const seen = (seenCalls.get(dupKey) ?? 0) + 1;
      seenCalls.set(dupKey, seen);
      if (seen >= 2) {
        a.log.warn('duplicate_tool_call', { tool: name, args: rawArgs, seen });
        const toolCallId = call.id || `tc${steps}_${ci + 1}`;
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: false,
            code: 'duplicate_call_blocked',
            message: '重复调用已拦截：同样的工具与参数已经执行过。请直接依据已有结果回答用户，不要再调用工具。'
          })
        });
        yield a.emit('tool_result', {
          step: steps,
          toolCallId,
          tool: name,
          ok: false,
          ms: 0,
          sourceType: a.sourceType,
          summary: '重复调用已拦截（同工具+同参数已执行过），依据已有结果作答',
          error: { code: 'duplicate_call_blocked', message: '同样的工具与参数已经执行过，未重复执行' }
        } satisfies ToolResultPayload);
        messages.push({
          role: 'system',
          content: '检测到你重复调用了同一个工具且参数相同。请立即停止调用工具，直接依据已有结果回答用户。'
        });
        steps = cfg.agent.maxSteps; // 逼出循环
        break;
      }

      if (a.signal?.aborted) return;

      const toolCallId = call.id || `tc${steps}_${ci + 1}`;
      yield a.emit('tool_started', {
        step: steps,
        toolCallId,
        tool: name,
        args: rawArgs,
        sourceType: a.sourceType
      } satisfies ToolStartedPayload);

      const t0 = Date.now();
      const exec = await executeTool(name, rawArgs, {
        dataset: a.ds,
        now: a.now,
        actor: a.actor,
        conversationId: a.conversationId ?? null
      });
      const ms = Date.now() - t0;
      toolCalls += 1;

      if (exec.ok) {
        lastToolSummary = exec.summary;
        yield a.emit('tool_result', {
          step: steps,
          toolCallId,
          tool: name,
          ok: true,
          ms,
          sourceType: a.sourceType,
          resultKind: exec.resultKind,
          summary: exec.summary,
          result: exec.result
        } satisfies ToolResultPayload);
        // ops.v1：prepare 工具产出待确认提案 → need_confirm（前端活跃轮渲染提案卡）
        if (exec.resultKind === 'operation_proposal') {
          runTaskStatus = 'awaiting_confirmation';
          yield a.emit('need_confirm', {
            taskId: (exec.result as Proposal).taskId,
            proposal: exec.result as Proposal,
            allowedDecisions: ['confirm', 'reject']
          } satisfies NeedConfirmPayload);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: true,
            summary: exec.summary,
            data: exec.result,
            dataSource: a.ds.sourceLabel,
            reminder: '只能依据本结果作答；本结果未包含的信息一律回答"查不到"；notes 字段必须原样转达给用户。'
          })
        });
      } else {
        yield a.emit('tool_result', {
          step: steps,
          toolCallId,
          tool: name,
          ok: false,
          ms,
          sourceType: a.sourceType,
          summary: exec.summary,
          error: { code: exec.code, message: exec.message }
        } satisfies ToolResultPayload);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: false,
            code: exec.code,
            message: exec.message,
            suggestions: exec.suggestions,
            instruction:
              exec.code === 'unknown_tool'
                ? '这个工具不存在。你只能使用系统声明的工具。请改用可用工具，或直接向用户说明做不到。'
                : exec.code === 'lab_not_found' || exec.suggestions.length
                  ? '这个房间号系统里没有。请从 suggestions 里挑一个最接近的重新调用，若都不合适就直接告诉用户没有这个房间并列出可选项。'
                  : '请修正参数后重试一次；若仍失败，直接告诉用户查不到。'
          })
        });
      }
    }
  }

  // 强制收敛（停止条件①）：还有余地但已到步数上限 → 要求不带工具再答一次
  if (steps >= cfg.agent.maxSteps && !answer) {
    messages.push({
      role: 'system',
      content: '已达到本次任务的工具调用上限。请不要再调用工具，直接依据已有结果给用户一个结论；信息不足就明确说信息不足。'
    });
    for await (const ev of streamChat({ messages, tools: undefined, signal: a.signal }, a.log)) {
      if (ev.type === 'text') {
        answer += ev.text;
        yield a.emit('answer_delta', { text: ev.text } satisfies AnswerDeltaPayload);
      } else if (ev.type === 'usage') {
        usage = ev.usage;
      }
    }
  }

  // 兜底：模型一个字都没给 → 用工具摘要补上，绝不给用户留空白
  if (!answer.trim()) {
    answer = lastToolSummary
      ? `（模型未返回文本，以下为工具查询到的原始摘要）\n${lastToolSummary}`
      : '本次没有得到有效结果。请换一种问法，例如「E310 2026-09-30 有哪些课？」。';
    yield* streamText(answer, a.emit, a.signal);
  }

  // 数据来源一致性检查（便宜但有效的反幻觉护栏）
  if (a.sourceType !== 'live' && /实时(数据)?/.test(answer)) {
    const correction = `\n（说明：本次数据来源为「${a.ds.sourceLabel}」，不是实时数据。请以上方来源标识为准。）`;
    answer += correction;
    yield a.emit('answer_delta', { text: correction } satisfies AnswerDeltaPayload);
    a.log.warn('answer_claimed_live_but_not', { sourceType: a.sourceType });
  }

  if (a.signal?.aborted) return; // N06/B10：取消后不再补发完成终态
  a.log.info('run_completed', {
    engine: 'agnes',
    steps,
    toolCalls,
    ms: a.watch.ms,
    usage,
    answerChars: answer.length
  });

  yield a.emit('run_completed', {
    answer,
    steps,
    toolCalls,
    ms: a.watch.ms,
    sourceType: a.sourceType,
    engine: 'agnes',
    ...(runTaskStatus ? { taskStatus: runTaskStatus } : {}),
    ...(usage ? { usage } : {})
  } satisfies RunCompletedPayload);
}

/** 忽略参数顺序的指纹（用排序后的键构造，避免 {a,b} 与 {b,a} 被判成两次不同调用）。
 *  注意：指纹**必须**包含工具名（由调用方拼接 `${name}::${fnKey(args)}`）——
 *  不同工具给相同参数不是重复调用。 */
function fnKey(args: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
}

// ===========================================================================
//  错误 → run_failed 映射（C4：异常分类：可重试 / 需人工 / 终止）
// ===========================================================================

function toRunFailed(err: unknown, wallClockMs: number): RunFailedPayload {
  if (err instanceof AgnesError) {
    const hint =
      err.code === 'agnes_not_configured'
        ? '在 .env 里配置 AGNES_API_KEY 后重启服务端；未配置时会使用演示引擎。'
        : err.code === 'agnes_auth_failed'
          ? '检查 .env 中的 AGNES_API_KEY 是否有效、是否被撤销。'
          : err.code === 'agnes_model_not_found'
            ? '核对 AGNES_MODEL（应为 agnes-3.0-flash）与 AGNES_BASE_URL。'
            : err.code === 'agnes_rate_limited'
              ? '稍后重试；或降低调用频率。'
              : err.code === 'agnes_timeout'
                ? `可在 .env 里调大 AGNES_TIMEOUT_MS（当前上限参考值 ${wallClockMs} ms）。`
                : '稍后重试；若持续失败，请检查服务端网络与 Agnes 服务状态。';
    return { code: err.code, message: err.message, hint };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'run_internal_error',
    message: `任务执行时发生未预期错误：${message}`,
    hint: '请把 runId 提供给管理员以便定位。'
  };
}

/** 供 /api/agent/health 使用 */
export function runtimeCapabilities(): Record<string, unknown> {
  const ds = loadDataset();
  return {
    engine: isAgnesConfigured() ? 'agnes' : 'demo',
    dataSource: ds.sourceType,
    dataSourceLabel: ds.sourceLabel,
    promptVersion: PROMPT_VERSION,
    tools: toolSpecs().map((t) => t.name),
    rooms: availableRoomNames(ds),
    warnings: ds.warnings
  };
}
