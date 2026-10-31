import {businessScope,isBusinessConnected,businessRequest} from '../business/bridge.ts';
import crypto from 'node:crypto';
import {nativeDelegation} from '../security/context.ts';
/**
 * 会话 API —— 持久化会话/消息/运行的 REST 与 SSE（M0/M1 加固版）
 * ============================================================================
 *  本轮加固（对应任务书 N01/N02/N04/N05/N06/N07/N17）：
 *    · 路由可 await、统一异常边界 —— 任何异步失败返回明确 HTTP 错误，不炸进程
 *    · runId 由**服务端生成**（客户端 runId 仅旧接口兼容）；user+assistant+run 三件套
 *      在一个短事务内创建，冲突/约束失败整组回滚，绝不半写入
 *    · 同会话最多一个活跃 run（事务内预检 + 部分唯一索引兜底），冲突返回 409 与活跃 runId
 *    · 显式取消接口 POST /api/runs/:id/cancel：服务端记 cancelled（区别于断连的 interrupted）
 *    · 终态**先落库成功再发 end**；落库失败发 save_failed 事件，绝不静默承诺已保存
 *    · run_failed 的错误码/说明落库（meta.error），刷新后失败仍有原因
 *    · 增量刷写：32 个 delta **或 1.5 秒**（取先到者）—— 慢速短回答也有恢复点
 *    · 会话上下文（房间/日期/任务类型）在终态事务中持久化，重启后承接不丢（N07）
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { runAgent } from '../agent/run.ts';
import { newTraceId } from '../obs/trace.ts';
import { MAX_QUESTION_CHARS } from '../agent/prompts.ts';
import { resolveActor } from '../operations/identity.ts';
import { readJsonBody, sseHeaders } from './agent-chat.ts';
import {
  getDb,
  dbReady,
  dbLastError,
  listConversations,
  createConversation,
  getConversationMeta,
  getMessages,
  renameConversation,
  updateConversationMode,
  countMessages,
  deleteConversation,
  createMessageWithRun,
  RunConflictError,
  trackActiveRun,
  releaseActiveRun,
  requestCancel,
  updateAssistantPartial,
  finalizeAssistantMessage,
  hasActiveRunForConversation,
  selectRound,
  deleteMessagesAndRuns,
  recomputeConversationContext,
  supersedePendingProposals,
  cancelOpsTasks,
  listAwaitingProposalsForConversation
} from '../persistence/db.ts';
import type { RunSnapshot } from '@shared/types';
import { collectRoundRefs, revertRoundEffects } from '../operations/revert.ts';
import type { EffectsReport } from '../operations/revert.ts';
import { forgetSession } from '../agent/session.ts';

/** 会话类型白名单：task=任务工作台；chat=纯聊天（不执行任务操作） */
function parseMode(v: unknown): 'chat' | 'task' | null {
  if (v === undefined || v === null || v === '') return null;
  if (v === 'chat' || v === 'task') return v;
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 由**已落库事实**拼出运行快照（只读投影）。
 * 规则：取不到就 null / 空数组 —— 不推测、不补默认值（R4）。
 * 相位只在能确定时给值：终态直接映射；仍有未确认提案 → awaiting_confirm；其余 null。
 */
function buildRunSnapshot(conversationId: string, run: Record<string, unknown>): RunSnapshot {
  const status = String(run['status'] ?? '');
  const terminal: RunSnapshot['terminal'] =
    status === 'completed'
      ? 'completed'
      : status === 'cancelled'
        ? 'cancelled'
        : status === 'failed' || status === 'save_failed'
          ? 'failed'
          : status === 'interrupted'
            ? 'interrupted'
            : null;

  const assistant = getMessages(conversationId).find((m) => m.id === String(run['assistantMessageId'] ?? '')) ?? null;
  const meta = (assistant?.meta ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(meta['toolCalls']) ? (meta['toolCalls'] as Array<Record<string, unknown>>) : [];
  const toolCalls: RunSnapshot['toolCalls'] = rawCalls.map((t) => ({
    toolCallId: String(t['toolCallId'] ?? ''),
    tool: String(t['tool'] ?? ''),
    args: (t['args'] as Record<string, unknown>) ?? {},
    ok: typeof t['ok'] === 'boolean' ? (t['ok'] as boolean) : null,
    ...(typeof t['ms'] === 'number' ? { ms: t['ms'] as number } : {}),
    ...(typeof t['summary'] === 'string' ? { summary: t['summary'] as string } : {}),
    ...(typeof t['resultKind'] === 'string' ? { resultKind: t['resultKind'] as string } : {}),
    ...(t['error'] ? { error: t['error'] as { code: string; message: string } } : {})
  }));

  const proposals = listAwaitingProposalsForConversation(conversationId);
  const phase: RunSnapshot['phase'] = terminal ?? (proposals.length ? 'awaiting_confirm' : null);

  return {
    runId: String(run['id'] ?? ''),
    conversationId,
    phase,
    toolCalls,
    // 增量刷写的最新正文；仍在流式时它**不是最终全文**，UI 不得当成已定稿
    answerText: String(assistant?.text ?? ''),
    proposals,
    sourceType: (meta['sourceType'] as RunSnapshot['sourceType']) ?? null,
    engine: (meta['engine'] as RunSnapshot['engine']) ?? null,
    model: (meta['model'] as string | null) ?? null,
    lastSeq: null,
    terminal,
    // 正文是否已落为终态（streaming = 还在写库；没有消息行 = 未落库）
    saved: assistant !== null && assistant.status !== 'streaming',
    startedAt: (run['startedAt'] as string | null) ?? null,
    endedAt: (run['endedAt'] as string | null) ?? null,
    assistantMessageId: assistant?.id ?? null,
    // A5：meta.plan 回放（没有登记过计划就是 null）
    plan: Array.isArray(meta['plan']) ? (meta['plan'] as RunSnapshot['plan']) : null
  };
}

/** 统一异步边界：路由层 await 本函数，任何异常都变成 500 而不是进程退出（N01） */
export async function handleConversations(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  try {
    return await routeConversations(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) {
      json(res, 500, {
        error: 'internal_error',
        message: `会话服务内部错误：${err instanceof Error ? err.message : String(err)}`
      });
    } else if (!res.writableEnded) {
      res.end();
    }
    return true;
  }
}

async function routeConversations(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();

  // R01：持久层初始化失败时明确 503 + 恢复说明，健康检查不再谎报就绪
  if (!dbReady()) {
    json(res, 503, {
      error: 'persistence_unavailable',
      message: '会话存储不可用，请检查磁盘与数据库文件后重启服务',
      detail: dbLastError() ?? ''
    });
    return true;
  }

  // ---- 显式取消（N06）：幂等；只作用于目标 run ----
  const cancelMatch = /^\/api\/runs\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelMatch && method === 'POST') {
    const runId = decodeURIComponent(cancelMatch[1]!);
    const { getRun } = await import('../persistence/db.ts');
    const target = getRun(runId);
    if (!target || !getConversationMeta(String(target['conversationId']))) return json(res, 404, {error:'run_not_found'}), true;
    const outcome = requestCancel(runId);
    if (outcome === 'not_found') {
      // R06：内存活跃表没有 ≠ 运行不存在 —— 查持久 Run，已终态返回既有状态
      const { getRun } = await import('../persistence/db.ts');
      const run = getRun(runId);
      if (run) {
        return json(res, 200, { runId, outcome: 'already_finished', status: String(run['status']) }), true;
      }
    }
    json(res, 200, { runId, outcome });
    return true;
  }
  // ---- 权威运行状态（B09/B12 用） ----
  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  if (runMatch && method === 'GET') {
    const { getRun } = await import('../persistence/db.ts');
    const run = getRun(decodeURIComponent(runMatch[1]!));
    if (!run || !getConversationMeta(String(run['conversationId']))) return json(res, 404, { error: 'run_not_found' }), true;
    return json(res, 200, run), true;
  }

  // ---- 运行快照（只读投影）：断线后前端据此把一轮收敛到真实终态 ----
  //  设计约束：字段只能来自已落库事实（runs 行 + assistant 消息 meta + 待确认提案），
  //  取不到就返回 null / 空数组，**禁止推测填充**；GET 无副作用，不重发任何消息。
  const snapshotMatch = /^\/api\/conversations\/([^/]+)\/run-snapshot$/.exec(pathname);
  if (snapshotMatch && method === 'GET') {
    const conversationId = decodeURIComponent(snapshotMatch[1]!);
    const meta = getConversationMeta(conversationId);
    if (!meta) return json(res, 404, { error: 'conversation_not_found', message: '会话不存在或当前账户不可见' }), true;
    if (nativeDelegation.getStore()?.sharedChat && meta.mode !== 'chat') {
      return json(res, 403, { message: '悬浮窗不能读取任务会话的运行快照' }), true;
    }
    const query = new URL(req.url || '/', 'http://localhost').searchParams;
    const runId = (query.get('runId') ?? '').trim();
    if (!runId) return json(res, 400, { error: 'missing_run_id', message: '需要 ?runId=<运行编号>' }), true;
    const { getRun } = await import('../persistence/db.ts');
    const run = getRun(runId);
    // 会话隔离：runId 必须属于这个会话，否则一律当作不存在（不泄露别处运行是否存在）
    if (!run || String(run['conversationId']) !== conversationId) {
      return json(res, 404, { error: 'run_not_found', message: '该运行编号不属于此会话，或已被清理' }), true;
    }
    const snapshot = buildRunSnapshot(conversationId, run);
    return json(res, 200, snapshot), true;
  }

  if (pathname === '/api/conversations' && method === 'GET') {
    json(res, 200, { conversations: listConversations().filter(c=>!nativeDelegation.getStore()?.sharedChat||c.mode==='chat') });
    return true;
  }
  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.ok) return json(res, body.status, { error: body.code, message: body.message }), true;
    const raw = (body.value as Record<string, unknown>) ?? {};
    const rawTitle = raw['title'];
    if (rawTitle !== undefined && typeof rawTitle !== 'string') {
      return json(res, 400, { error: 'bad_title', message: 'title 必须是字符串' }), true;
    }
    if(nativeDelegation.getStore()?.sharedChat&&raw['mode']&&raw['mode']!=='chat')return json(res,403,{message:'悬浮窗只能使用聊天模式'}),true;
    const mode = nativeDelegation.getStore()?.sharedChat?'chat':parseMode(raw['mode']) ?? 'task';
    return json(res, 200, createConversation(typeof rawTitle === 'string' ? rawTitle : '', mode)), true;
  }

  // ---- 轮次（round）：删除本轮 / 回档到本轮发起前（0.6.0）----
  //  一轮 = 一条 user 消息 + 紧随其后直到下一条 user 之前的全部 assistant 消息。
  //  守卫与既有删除一致：活跃 run 一律 409（不能一边执行一边截断历史）。
  const roundMatch = /^\/api\/conversations\/([^/]+)\/rounds\/([^/]+)$/.exec(pathname);
  const rollbackMatch = /^\/api\/conversations\/([^/]+)\/rollback$/.exec(pathname);
  if ((roundMatch && method === 'DELETE') || (rollbackMatch && method === 'POST')) {
    const target = roundMatch ?? rollbackMatch!;
    const conversationId = decodeURIComponent(target[1]!);
    const meta = getConversationMeta(conversationId);
    if (!meta) return json(res, 404, { error: 'conversation_not_found',message:'会话不存在或当前账户不可见' }), true;
    if (nativeDelegation.getStore()?.sharedChat && meta.mode !== 'chat') {
      return json(res, 403, { message: '悬浮窗不能读取或操作任务会话' }), true;
    }
    if (hasActiveRunForConversation(conversationId)) {
      return json(res, 409, { error: 'conversation_busy', message: '该会话正在执行任务，请先停止再操作轮次' }), true;
    }
    let userMessageId = '';
    let revertEffects = false;
    if (rollbackMatch) {
      const body = await readJsonBody(req);
      if (!body.ok) return json(res, body.status, { error: body.code, message: body.message }), true;
      const raw = (body.value as Record<string, unknown>) ?? {};
      userMessageId = typeof raw['userMessageId'] === 'string' ? raw['userMessageId'].trim() : '';
      revertEffects = raw['revertEffects'] === true;
      if (!userMessageId) return json(res, 400, { error: 'missing_user_message', message: '需要 { "userMessageId": "..." }' }), true;
    } else {
      userMessageId = decodeURIComponent(target[2]!);
    }
    const slice = selectRound(conversationId, userMessageId);
    if (!slice) {
      return json(res, 404, { error: 'message_not_found', message: '该轮次不存在，或目标不是本会话的用户消息' }), true;
    }
    // refs 必须在删除前解析 —— 删除后就再也读不到该轮的 toolCalls 了
    const refs = collectRoundRefs(rollbackMatch ? slice.fromHere : slice.round);
    const doomed = rollbackMatch ? slice.fromHere : slice.round;
    const removed = deleteMessagesAndRuns(conversationId, doomed.map((m) => m.id));
    const context = recomputeConversationContext(conversationId);
    // 内存意图与服务端历史必须一致：否则下一轮会拿着已回档的上下文继续答
    forgetSession(conversationId);

    let effects: EffectsReport;
    if (rollbackMatch) {
      effects = await revertRoundEffects({ conversationId, userMessageId, actorId: resolveActor(undefined).id, refs, includeExecuted: revertEffects });
    } else {
      // 删除本轮只作废该轮的待确认方案，**不回退**已执行写入（删除≠回档）
      effects = {
        reverted: [],
        notReverted: [],
        blocked: [],
        rejectedPlans: [],
        supersededProposals: supersedePendingProposals(refs.proposals.map((p) => p.proposalId)),
        cancelledTasks: cancelOpsTasks(refs.proposals.map((p) => p.taskId ?? '').filter(Boolean)),
        notes: ['「删除本轮」只移除对话记录并作废该轮待确认方案；已执行到业务系统的写入不会因此回退。需要回退请使用「回档」。']
      };
    }
    if (!removed.removedMessageIds.length) {
      return json(res, 404, { error: 'message_not_found', message: '目标消息不存在或已被删除' }), true;
    }
    json(res, 200, {
      ok: true,
      mode: rollbackMatch ? 'rollback' : 'delete_round',
      removedMessageIds: removed.removedMessageIds,
      removedRunIds: removed.removedRunIds,
      context,
      conversation: getConversationMeta(conversationId),
      effects
    });
    return true;
  }

  const convMatch = /^\/api\/conversations\/([^/]+)(\/messages)?$/.exec(pathname);
  if (convMatch) {
    const conversationId = decodeURIComponent(convMatch[1]!);
    const isMessages = Boolean(convMatch[2]);
    if (!getConversationMeta(conversationId)) return json(res, 404, {error:'conversation_not_found'}), true;
    if(nativeDelegation.getStore()?.sharedChat&&getConversationMeta(conversationId)?.mode!=='chat')return json(res,403,{message:'悬浮窗不能读取或操作任务会话'}),true;

    if (!isMessages && method === 'GET') {
      const meta = getConversationMeta(conversationId);
      if (!meta) {
        json(res, 404, { error: 'conversation_not_found',message:'会话不存在或当前账户不可见' });
        return true;
      }
      if(isBusinessConnected()){try{await businessRequest('/context');}catch{/* expired credentials are invalidated; scoped history is redacted below */}}
      const scope=businessScope().scopeKey;
      const messages=getMessages(conversationId).map(m=>m.meta?.['authorityScope']&&m.meta['authorityScope']!==scope?{...m,text:'此条原系统历史结果属于其他账号或已失效授权范围。请重新连接相应账号并查询。',meta:{...m.meta,toolCalls:[]}}:m);
      const query=new URL(req.url||'/', 'http://localhost').searchParams;
      if([...query].some(([k,v])=>!['cursor','revision'].includes(k)||v.length>100||query.getAll(k).length!==1)||query.has('cursor')&&!/^\d{1,16}$/.test(query.get('cursor')!))return json(res,400,{error:'bad_cursor',message:'会话查询参数无效'}),true;
      const db=getDb(),cursor=Number((db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM message_changes').get() as {n:number}).n),since=query.has('cursor')?Number(query.get('cursor')):null;
      const revision=crypto.createHash('sha256').update(JSON.stringify([meta.mode,meta.title,scope,messages])).digest('hex');
      const changed=since===null?new Set<string>():new Set((db.prepare('SELECT DISTINCT messageId FROM message_changes WHERE conversationId=? AND seq>?').all(conversationId,since) as Array<{messageId:string}>).map(r=>r.messageId));
      const reset=since===null||since>cursor||since<Math.max(0,cursor-20000)||query.get('revision')!==revision&&!changed.size;
      const active=getDb().prepare("SELECT id FROM runs WHERE conversationId=? AND status='running' LIMIT 1").get(conversationId) as {id:string}|undefined;
      json(res, 200, { ...meta, messages:reset?messages:query.get('revision')===revision?[]:messages.filter(m=>changed.has(m.id)),messageIds:messages.map(m=>m.id),cursor:String(cursor),revision,reset,activeRunId:active?.id||null });
      return true;
    }
    if (!isMessages && method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) return json(res, body.status, { error: body.code, message: body.message }), true;
      const raw = (body.value as Record<string, unknown>) ?? {};
      const title = raw['title'];
      const mode = parseMode(raw['mode']);
      if(nativeDelegation.getStore()?.sharedChat&&mode&&mode!=='chat')return json(res,403,{message:'悬浮窗不能切换到任务模式'}),true;
      if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
        return json(res, 400, { error: 'missing_title', message: 'title 必须是非空字符串' }), true;
      }
      if (mode) {
        // 模式锁定（2026-10-06 用户要求）：会话一旦开始对话，模式即确定，不可再改。
        //   理由：模式决定消息路由与业务办理权限（bridge 按 mode 拒单），
        //   允许中途切换等于让同一条历史在两种语义之间漂移；要换模式就新建会话。
        //   尚未发过消息的空会话不算"已确定"，仍可改（前端建会话与首条消息之间就是这一瞬）。
        const current = getConversationMeta(conversationId)!;
        if (mode !== current.mode && countMessages(conversationId) > 0) {
          return json(res, 409, {
            error: 'mode_locked',
            mode: current.mode,
            message: `该会话已确定为${current.mode === 'chat' ? '聊天' : '工作'}模式，开始对话后不可更改；需要其他模式请新建会话`
          }), true;
        }
        updateConversationMode(conversationId, mode);
      }
      if (typeof title === 'string') renameConversation(conversationId, title.trim());
      const meta = getConversationMeta(conversationId);
      if (!meta) {
        json(res, 404, { error: 'conversation_not_found',message:'会话不存在或当前账户不可见' });
        return true;
      }
      json(res, 200, { ok: true, mode: meta.mode, title: meta.title });
      return true;
    }
    if (!isMessages && method === 'DELETE') {
      // R12：会话仍有活跃 run 时拒绝软删除（前后端一致），不能隐藏正在执行的工作
      if (hasActiveRunForConversation(conversationId)) {
        json(res, 409, { error: 'conversation_busy', message: '该会话仍有正在执行的任务，请先停止再删除' });
        return true;
      }
      json(res, 200, { ok: deleteConversation(conversationId) });
      return true;
    }
    if (isMessages && method === 'POST') {
      await handleConversationMessage(req, res, conversationId);
      return true;
    }
  }
  return false;
}

async function handleConversationMessage(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
  const meta = getConversationMeta(conversationId);
  if (!meta) {
    json(res, 404, { error: 'conversation_not_found',message:'会话不存在或当前账户不可见' });
    return;
  }
  const body = await readJsonBody(req);
  if (!body.ok) {
    json(res, body.status, { error: body.code, message: body.message });
    return;
  }
  const payload = (body.value ?? {}) as Record<string, unknown>;
  const rawMessage = payload['message'] ?? payload['question'];
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
    json(res, 400, { error: 'missing_message', message: `需要 { "message": "..." }，最长 ${MAX_QUESTION_CHARS} 字` });
    return;
  }
  const message = rawMessage.trim();
  if (message.length > MAX_QUESTION_CHARS) {
    json(res, 413, { error: 'message_too_long', message: `问题最长 ${MAX_QUESTION_CHARS} 字（当前 ${message.length} 字），请拆分或精简` });
    return;
  }
  const rawClientRequestId =
    typeof payload['clientRequestId'] === 'string' && payload['clientRequestId'] ? payload['clientRequestId'] : newTraceId('req');
  const clientRequestId = `${resolveActor(undefined).id}:${conversationId}:${rawClientRequestId.slice(0,128)}`;
  // N01：正式 runId 一律由服务端生成（客户端 runId 只在旧 /api/agent/chat 兼容）
  const runId = newTraceId('run');

  // N01/N04：三件套短事务创建；重复 → 引用既有执行；并发 → 409 + 活跃 runId
  let created;
  try {
    created = createMessageWithRun(conversationId, message, clientRequestId, runId);
  } catch (err) {
    if (err instanceof RunConflictError) {
      json(res, 409, { error: 'run_conflict', activeRunId: err.activeRunId, message: err.message });
      return;
    }
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      json(res, 409, { error: 'duplicate_request', clientRequestId, message: '该请求已处理过，未重复执行' });
      return;
    }
    throw err;
  }
  if ('duplicate' in created) {
    json(res, 409, { error: 'duplicate_request', clientRequestId, message: '该请求已处理过，未重复执行' });
    return;
  }
  const { userMessage, assistant } = created;

  sseHeaders(res);
  // N01：接受确认事件携带全部正式 ID（前端据此对齐乐观消息）
  send(res, 'run_accepted', {
    seq: -1,
    v: 1,
    runId,
    type: 'run_accepted',
    ts: new Date().toISOString(),
    payload: {
      conversationId,
      clientRequestId,
      userMessageId: userMessage.id,
      assistantMessageId: assistant.id
    }
  });

  let authorityScope=isBusinessConnected()?businessScope().scopeKey:null;
  const ac = new AbortController();
  let aborted = false;
  // F03/N06：客户端断开在 req/res 两个对象上都可能表现为 close —— 任一触发即中止
  // 执行（模型请求停止、不再产生事件）；断连未终态由 finally 记为 interrupted。
  const onDisconnect = (): void => {
    if (aborted) return;
    aborted = true;
    if (!res.writableEnded) ac.abort();
  };
  req.on('close', onDisconnect);
  res.on('close', onDisconnect);

  // N06：取消接口需要能中止本 run
  const runHandle = trackActiveRun(runId, conversationId);
  runHandle.setAbort(() => ac.abort());

  let lastSeq = 0;
  let answerText = '';
  let deltaSinceFlush = 0;
  let lastFlushAt = Date.now();
  let terminal = false;
  let cancelRequested = false;
  let finalStatus = 'interrupted';
  let engine: string | null = null;
  /** 实际产出本次回答的模型（fallback 后是真正生效的那个）；规则引擎时为空 */
  let model: string | null = null;
  let sourceType: string | null = null;
  let elapsedMs = 0;
  let failedError: { code: string; message: string; hint?: string } | null = null;
  const toolCalls: Array<Record<string, unknown>> = [];
  /** A5：本轮最后一次登记的任务计划（plan_updated 事件载荷；终态随 meta 落库） */
  let planSteps: Array<Record<string, unknown>> | null = null;
  let completedPayload: Record<string, unknown> | null = null;
  let cancelEventSent = false;
  const lastContext: { labName: string | null; date: string | null; task: string | null } = {
    labName: null,
    date: null,
    task: null
  };

  const flush = (withToolCalls = false): void => {
    try {
      updateAssistantPartial(assistant.id, answerText, withToolCalls ? toolCalls : undefined);
      lastFlushAt = Date.now();
      deltaSinceFlush = 0;
    } catch {
      /* 刷写失败不中断流；终态会再尝试完整落库（失败则发 save_failed） */
    }
  };
  // R07：真正的定时快照 —— 上游停顿时也按时间上限落盘，不再依赖下一个 delta 才检查
  const flushTimer = setInterval(() => {
    if (deltaSinceFlush > 0 && Date.now() - lastFlushAt > 700) flush();
  }, 700);

  try {
    for await (const ev of runAgent({
      question: message,
      runId,
      sessionId: conversationId,
      // 会话类型由服务端存储决定：chat=纯聊天（无工具）；task=任务工作台（默认）
      mode: meta.mode,
      // ops.v1：服务端解析的沙盒演示身份（写操作准备必需；模型参数不采信）
      actor: resolveActor(req.headers['x-labops-sandbox-role']),
      signal: ac.signal,
      // N07：本轮最终可信上下文由 runAgent 回传，终态事务一并落库
      onContext: (ctx) => {
        lastContext.labName = ctx.labName;
        lastContext.date = ctx.date;
        lastContext.task = ctx.task;
      }
    })) {
      // N06/B10：本地断连或显式取消（abort 信号）都立即停止消费 ——
      // 取消必须压过随后到达的 run_completed，否则"已完成"会覆盖"已取消"
      if (aborted || ac.signal.aborted) break;
      lastSeq = ev.seq;
      if (!['run_completed','run_failed','run_cancelled'].includes(ev.type)) send(res, ev.type, ev);
      if (ev.type === 'run_started') {
        // 原系统数据请求可能刚检测到角色变化；采用已验证后的范围。
        authorityScope=isBusinessConnected()?businessScope().scopeKey:null;
        engine = String((ev.payload as Record<string, unknown>)['engine'] ?? '');
        const planned = (ev.payload as Record<string, unknown>)['model'];
        if (typeof planned === 'string' && planned) model = planned;
        sourceType = String((ev.payload as Record<string, unknown>)['sourceType'] ?? '');
      } else if (ev.type === 'answer_delta') {
        answerText += String((ev.payload as Record<string, unknown>)['text'] ?? '');
        deltaSinceFlush += 1;
        // N02：32 个增量或 1.5 秒（先到者，另有 700ms 定时兜底）
        if (deltaSinceFlush >= 32 || Date.now() - lastFlushAt > 1500) flush();
      } else if (ev.type === 'tool_started') {
        const p = ev.payload as Record<string, unknown>;
        toolCalls.push({ toolCallId: p['toolCallId'], tool: p['tool'], args: p['args'], ok: null });
        flush(true);
      } else if (ev.type === 'tool_result') {
        const p = ev.payload as Record<string, unknown>;
        const cur = toolCalls.find((t) => t['toolCallId'] === p['toolCallId']);
        if (cur) {
          cur['ok'] = p['ok'];
          cur['ms'] = p['ms'];
          cur['summary'] = p['summary'];
          cur['resultKind'] = p['resultKind'];
          cur['result'] = p['result'] ?? null;
          cur['error'] = p['error'] ?? null;
        }
        flush(true);
      } else if (ev.type === 'plan_updated') {
        // A5：计划落 meta.plan（流式期间即时刷写，刷新后仍能看到）
        const p = ev.payload as { steps?: unknown };
        if (Array.isArray(p.steps)) {
          planSteps = p.steps as Array<Record<string, unknown>>;
          try {
            updateAssistantPartial(assistant.id, answerText, undefined, planSteps);
            lastFlushAt = Date.now();
          } catch {
            /* 刷写失败不中断流；终态 finalize 会带全量 meta 再写一次 */
          }
        }
      } else if (ev.type === 'run_completed') {
        terminal = true;
        finalStatus = 'completed';
        const p = ev.payload as Record<string, unknown>;
        // R03：权威全文在此对齐（delta 可能漏块）；确认事件在保存成功后才发给浏览器
        answerText = String(p['answer'] ?? answerText);
        elapsedMs = Number(p['ms'] ?? 0);
        completedPayload = p;
        // 完成事件里的 model 是 fallback 之后真正生效的那个，比 run_started 的计划值更权威
        if (typeof p['model'] === 'string' && p['model']) model = String(p['model']);
      } else if (ev.type === 'run_failed') {
        terminal = true;
        finalStatus = 'failed';
        const p = ev.payload as { code: string; message: string; hint?: string };
        // N05：失败原因落库，刷新后仍有原因；hint 是"下一步怎么办"，同样必须留痕（否则刷新后就只剩错误码）
        failedError = { code: p.code, message: p.message, ...(p.hint ? { hint: p.hint } : {}) };
        send(res, ev.type, ev);
      } else if (ev.type === 'run_cancelled') {
        terminal = true;
        finalStatus = 'cancelled';
        send(res, ev.type, ev);
        cancelEventSent = true;
      }
    }
  } catch (err) {
    if (!aborted && !runHandle.cancelRequested()) {
      lastSeq += 1;
      send(res, 'run_failed', {
        seq: lastSeq,
        v: 1,
        runId,
        type: 'run_failed',
        ts: new Date().toISOString(),
        payload: { code: 'stream_error', message: `事件流中断：${err instanceof Error ? err.message : String(err)}` }
      });
      terminal = true;
      finalStatus = 'failed';
      failedError = { code: 'stream_error', message: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    clearInterval(flushTimer);
    cancelRequested = runHandle.cancelRequested();
    if (cancelRequested) {
      // N06：用户显式取消（经取消接口）→ cancelled；单纯断连 → interrupted
      finalStatus = 'cancelled';
      terminal = true;
    }
    if (aborted && !terminal) finalStatus = 'interrupted';

    // R02/R03：终态单事务（Message+Run+Context+会话时间）成功后，才发权威确认。
    // 失败必须让用户知道"执行已结束但保存失败"，保留可见内容，不静默承诺已保存。
    let saved = true;
    let saveError = '';
    try {
      finalizeAssistantMessage(assistant.id, runId, finalStatus, answerText, {
        conversationId,
        authorityScope,
        responseMode:meta.mode,
        queriedAt:new Date().toISOString(),
        scope:authorityScope,
        runId,
        engine:completedPayload?.['engine']||engine,
        model,
        sourceType,
        ms: elapsedMs,
        toolCalls,
        // U07：一行结论摘要（工具 summary），会话列表预览优先取它，避免拼入业务口径长文
        headline:(toolCalls as Array<{ok?:boolean|null;summary?:string}>).filter(t=>t.ok&&typeof t.summary==='string'&&t.summary).at(-1)?.summary??null,
        error: failedError,
        clientRequestId,
        usage: completedPayload?.['usage'] ?? null,
        plan: planSteps,
        context: lastContext
      });
    } catch (err) {
      saved = false;
      saveError = err instanceof Error ? err.message : String(err);
    }
    if (saved && finalStatus === 'completed' && completedPayload) {
      // R03：权威完成事件在事务提交后发出（携带最终全文，durable 标记）
      lastSeq += 1;
      send(res, 'run_completed', {
        seq: lastSeq,
        v: 1,
        runId,
        type: 'run_completed',
        ts: new Date().toISOString(),
        payload: { ...completedPayload, durable: true }
      });
    }
    if (cancelRequested && !cancelEventSent) {
      lastSeq += 1;
      send(res, 'run_cancelled', {
        seq: lastSeq, v: 1, runId, type: 'run_cancelled', ts: new Date().toISOString(),
        payload: { ms: elapsedMs, message: '你取消了本次任务。' }
      });
    }
    if (!saved) {
      // R02：终态写入失败 → 尽力把 run 标为 save_failed，避免悬挂的假 running 锁；
      // 连这步都失败时保留活跃登记（createMessageWithRun 冲突时会对 finalizeFailed 修复）
      lastSeq += 1;
      send(res, 'save_failed', {
        seq: lastSeq,
        v: 1,
        runId,
        type: 'save_failed',
        ts: new Date().toISOString(),
        payload: {
          status: finalStatus,
          answer: answerText,
          message: '本轮结果已生成，但写入会话历史失败——刷新后可能丢失，请复制保留重要内容'
        }
      });
      const repaired = runHandle.markUnrecoverable();
      if (repaired) {
        releaseActiveRun(runId);
      }
    } else {
      releaseActiveRun(runId);
    }
    send(res, 'end', {
      seq: lastSeq + 1,
      v: 1,
      runId,
      type: 'end',
      ts: new Date().toISOString(),
      payload: { runId, status: saved ? finalStatus : cancelRequested ? 'cancelled' : 'failed', saved, ...(saved ? {} : { saveError: saveError.slice(0, 200) }) }
    });
    if (!res.writableEnded) res.end();
  }
}

function send(res: ServerResponse, type: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
