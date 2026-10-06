import {responseError} from '../http';
import { actorHeaders } from '../actor';
/**
 * 会话 store —— 持久化会话与连续消息（M1/M2，F01·F08·F23）
 * ============================================================================
 *  · 服务端是历史权威：列表/消息全部来自 /api/conversations*
 *  · 消息按会话累积：新一轮提问追加 user + assistant 占位，绝不覆盖上一轮（F01）
 *  · currentId 存 sessionStorage：同源多标签页各自持有当前会话（F08）
 *  · 活跃轮的渲染仍由 run store 驱动；流结束（finishRun）时由 App 提交为本 store
 *    的一条 assistant 消息，成为历史的一部分
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export interface ConvSummary {
  id: string;
  title: string;
  lastActivityAt: string;
  messageCount: number;
  preview: string;
  /** 会话类型：task=任务工作台（默认）；chat=纯聊天（不能执行任务操作） */
  mode?: 'chat' | 'task';
}

export interface ToolCallRecord {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean | null;
  ms?: number;
  summary?: string;
  resultKind?: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'streaming';
  toolCalls: ToolCallRecord[];
  engine?: string | null;
  sourceType?: string | null;
  ms?: number;
  error?: { code: string; message: string } | null;
  responseMode?: 'chat'|'task';
  queriedAt?:string;
  scope?:string;
  createdAt: string;
}

/**
 * 一轮对话：一条 user 消息 + 紧随其后直到下一条 user 之前的全部 assistant 消息。
 * 删除/回档/修改都以「轮」为最小单位 —— 单删 assistant 会留下无主的回答。
 */
export interface Round {
  key: string;
  /** 起始 user 消息；历史上不应出现"首个消息就是 assistant"，真出现时给 null 并禁用操作 */
  userMessage: ChatMessage | null;
  /** 本轮全部消息（含起始 user），按会话顺序 */
  messages: ChatMessage[];
  /** 本轮中是否还有正在生成的回答 */
  streaming: boolean;
}

/** 把扁平消息流切成轮次。纯函数，便于单测与复用。 */
export function roundsOf(list: ChatMessage[]): Round[] {
  const out: Round[] = [];
  let cur: Round | null = null;
  for (const m of list) {
    if (m.role === 'user') {
      cur = { key: m.id, userMessage: m, messages: [m], streaming: false };
      out.push(cur);
    } else if (cur) {
      cur.messages.push(m);
      if (m.status === 'streaming') cur.streaming = true;
    } else {
      // 防御：没有起始 user 的孤儿回答单独成轮，但不提供任何破坏性操作
      cur = { key: `orphan-${m.id}`, userMessage: null, messages: [m], streaming: m.status === 'streaming' };
      out.push(cur);
    }
  }
  return out;
}

/** 服务端回档/删除返回的业务写入报告 —— 界面必须原样展示，不允许只显示"成功" */
export interface RoundEffects {
  reverted: Array<{ operationId: string; objectKind: string; objectId: string; action: string; detail: string }>;
  notReverted: Array<{ operationId: string; objectKind: string; objectId: string; reason: string }>;
  blocked: Array<{ planId: string; reason: string; objects: Array<{ kind: string; id: string }> }>;
  rejectedPlans: string[];
  supersededProposals: string[];
  cancelledTasks: string[];
  notes: string[];
}

export interface RoundActionResult {
  ok: boolean;
  message?: string;
  effects?: RoundEffects;
  removedCount?: number;
}

function uid(prefix: string): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? `${prefix}-${c.randomUUID()}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export const useSessionStore = defineStore('session', () => {
  const conversations = ref<ConvSummary[]>([]);
  const currentId = ref<string | null>(null);
  const messages = ref<Record<string, ChatMessage[]>>({});
  const listLoading = ref(false);
  const listError = ref<string | null>(null);
  const messagesLoading = ref(false);
  // R11：加载/错误状态按会话隔离 —— A 的失败不得显示在 B 上
  const messagesErrors = ref<Record<string, string>>({});
  const loadGen = new Map<string, number>();

  /** 当前会话的加载错误（R11：从当前实体派生，而不是全局单槽） */
  const currentMessagesError = computed<string | null>(() =>
    currentId.value ? messagesErrors.value[currentId.value] ?? null : null
  );

  const currentMessages = computed<ChatMessage[]>(() => (currentId.value ? messages.value[currentId.value] ?? [] : []));

  /** 当前会话的轮次切分（删除/回档/修改的作用单位） */
  const currentRounds = computed<Round[]>(() => roundsOf(currentMessages.value));

  /**
   * 侧栏按模式分区：工作会话（task，默认）与聊天会话（chat）。
   * 服务端的 listConversations 保证 mode 必有值，这里只做防御性兜底。
   */
  const workConversations = computed<ConvSummary[]>(() => conversations.value.filter((c) => c.mode !== 'chat'));
  const chatConversations = computed<ConvSummary[]>(() => conversations.value.filter((c) => c.mode === 'chat'));

  // ---- 会话类型（聊天/任务）：服务端存储为权威，这里缓存供界面切换与展示 ----
  const convModes = ref<Record<string, 'chat' | 'task'>>({});

  function currentMode(): 'chat' | 'task' {
    return (currentId.value ? convModes.value[currentId.value] : undefined) ?? 'task';
  }

  function setCurrentMode(id: string, mode: 'chat' | 'task'): void {
    convModes.value[id] = mode;
    const c = conversations.value.find((x) => x.id === id);
    if (c) c.mode = mode;
  }

  // ---- 每标签页独立的当前会话（F08）----
  function loadCurrentId(): string | null {
    try {
      currentId.value = sessionStorage.getItem('labops.conv');
    } catch {
      /* 忽略 */
    }
    return currentId.value;
  }

  function saveCurrentId(id: string | null): void {
    currentId.value = id;
    try {
      if (id) sessionStorage.setItem('labops.conv', id);
      else sessionStorage.removeItem('labops.conv');
    } catch {
      /* 忽略 */
    }
  }

  async function loadConversations(): Promise<void> {
    listLoading.value = true;
    listError.value = null;
    try {
      const res = await fetch('/api/conversations', {headers: actorHeaders()});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { conversations: ConvSummary[] };
      conversations.value = j.conversations ?? [];
      for (const c of conversations.value) {
        if (c.mode) convModes.value[c.id] = c.mode;
      }
      // 当前会话被（别处）删除时回落到最近一个
      if (currentId.value && !conversations.value.some((c) => c.id === currentId.value)) {
        saveCurrentId(null);
      }
    } catch (e) {
      listError.value = `会话列表载入失败：${(e as Error).message}`;
    } finally {
      listLoading.value = false;
    }
  }

  // N21：草稿按会话保存
  const drafts = ref<Record<string, string>>({});
  function draftFor(key: string): string {
    return drafts.value[key] ?? '';
  }
  function saveDraft(key: string, text: string): void {
    drafts.value[key] = text;
  }

  async function openConversation(id: string): Promise<void> {
    saveCurrentId(id);
    // N15：已有缓存先展示，但**始终**后台重新核对 —— 跨标签页变更、中途 streaming 终态都能收敛
    const gen = (loadGen.get(id) ?? 0) + 1;
    loadGen.set(id, gen);
    const hadCache = Boolean(messages.value[id]);
    if (!hadCache) messagesLoading.value = true;
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {headers: actorHeaders()});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        mode?: 'chat' | 'task';
        messages: Array<Record<string, unknown>>;
      };
      if (gen !== loadGen.get(id)) return; // 旧响应不得覆盖新会话状态（N15）
      if (j.mode) setCurrentMode(id, j.mode);
      // R04：历史快照与本地活跃增量按 ID 合并 —— 本地已有的消息保留（较新），只追加本地没有的
      const local = messages.value[id] ?? [];
      const serverMsgs = (j.messages ?? []) as Array<Record<string, unknown>>;
      const localIds = new Set(local.map((m) => m.id));
      const merged = [...local];
      for (const m of serverMsgs) {
        if (!localIds.has(String(m['id']))) {
          merged.push({
            id: String(m['id']),
            role: m['role'] as 'user' | 'assistant',
            text: String(m['text'] ?? ''),
            status: (m['status'] as ChatMessage['status']) ?? 'completed',
            toolCalls: ((m['meta'] as Record<string, unknown> | null)?.['toolCalls'] as ToolCallRecord[]) ?? [],
            engine: (m['meta'] as Record<string, unknown> | null)?.['engine'] != null ? String((m['meta'] as Record<string, unknown>)['engine']) : null,
            sourceType: (m['meta'] as Record<string, unknown> | null)?.['sourceType'] != null ? String((m['meta'] as Record<string, unknown>)['sourceType']) : null,
            ms: Number((m['meta'] as Record<string, unknown> | null)?.['ms'] ?? 0) || undefined,
            error: ((m['meta'] as Record<string, unknown> | null)?.['error'] as ChatMessage['error']) ?? null,
            responseMode:(m['meta'] as Record<string,unknown>)?.['responseMode'] as 'chat'|'task'|undefined,
            queriedAt:(m['meta'] as Record<string,unknown>)?.['queriedAt'] as string|undefined,
            scope:(m['meta'] as Record<string,unknown>)?.['scope'] as string|undefined,
            createdAt: String(m['createdAt'] ?? '')
          });
        }
      }
      messages.value[id] = merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    } catch (e) {
      if (gen === loadGen.get(id)) messagesErrors.value[id] = `消息载入失败：${(e as Error).message}`;
    } finally {
      if (gen === loadGen.get(id)) messagesLoading.value = false;
    }
  }

  /** 新聊天：先只切到空会话；第一次发送成功后才落库建会话（避免一排空白会话） */
  function startDraft(): void {
    saveCurrentId(null);
  }

  function appendLocal(conversationKey: string, msg: ChatMessage): void {
    if (!messages.value[conversationKey]) messages.value[conversationKey] = [];
    messages.value[conversationKey].push(msg);
  }

  /**
   * 发送一条消息：无会话则先建会话（mode 决定会话类型：chat=纯聊天）；返回实际 conversationId 与 clientRequestId。
   * 幂等键 clientRequestId 由调用方在重试间复用。
   */
  async function ensureConversation(question: string, existingId: string | null, clientRequestId: string, mode: 'chat' | 'task' = 'task'): Promise<string> {
    if (existingId) return existingId;
    const res = await fetch('/api/conversations', { method: 'POST', headers: { ...actorHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    if (!res.ok) throw await responseError(res);
    const { id } = (await res.json()) as { id: string };
    saveCurrentId(id);
    setCurrentMode(id, mode);
    messages.value[id] = [];
    // 本地先占位 user 消息（服务端同一 clientRequestId 幂等）
    appendLocal(id, { id: `local-u-${clientRequestId}`, role: 'user', text: question, status: 'completed', toolCalls: [], createdAt: new Date().toISOString() });
    await loadConversations();
    return id;
  }

  /**
   * R04/C06：run_accepted 到达 —— 临时 ID 对齐服务端正式 ID。
   * 同一消息实体只换身份，不换引用，活跃流的更新不中断。
   */
  function adoptIds(convId: string, clientRequestId: string, clientRunId: string, userMessageId: string, assistantMessageId: string): void {
    const list = messages.value[convId];
    if (!list) return;
    for (const m of list) {
      if (m.id === `local-u-${clientRequestId}`) m.id = userMessageId;
      else if (m.id === `live-${clientRunId}`) m.id = assistantMessageId;
    }
  }

  /** 活跃轮结束：把 run store 的结果固化为一条历史消息 */
  function commitRun(payload: { role: 'user' | 'assistant'; text: string; status: ChatMessage['status']; toolCalls: ToolCallRecord[]; engine?: string | null; sourceType?: string | null; ms?: number; error?: ChatMessage['error']; clientRequestId: string }): void {
    const id = currentId.value;
    if (!id) return;
    appendLocal(id, {
      id: uid(payload.role === 'user' ? 'm-u' : 'm-a'),
      role: payload.role,
      text: payload.text,
      status: payload.status,
      toolCalls: payload.toolCalls,
      engine: payload.engine ?? null,
      sourceType: payload.sourceType ?? null,
      ms: payload.ms,
      error: payload.error ?? null,
      createdAt: new Date().toISOString()
    });
    void loadConversations();
  }

  async function removeConversation(id: string): Promise<void> {
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', headers: actorHeaders() });
    delete messages.value[id];
    delete messagesErrors.value[id];
    if (currentId.value === id) saveCurrentId(null);
    await loadConversations();
  }

  /**
   * 删除本轮 / 回档 —— 两者共用一条"服务端权威 → 本地缓存整体重建"的收敛路径。
   * ⚠️ 不能只调 openConversation：R04 的合并策略是"本地已有优先"，
   * 服务端删掉的消息会被本地缓存原样保留，界面看起来"删了又回来"。
   * 所以先把该会话的本地缓存清空，再以服务端结果重建。
   */
  async function applyRoundAction(id: string, path: string, init: RequestInit): Promise<RoundActionResult> {
    let payload: Record<string, unknown>;
    try {
      const res = await fetch(path, init);
      payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return { ok: false, message: String(payload['message'] ?? `HTTP ${res.status}`) };
      }
    } catch (e) {
      return { ok: false, message: `网络请求失败：${(e as Error).message}` };
    }
    messages.value[id] = [];
    delete messagesErrors.value[id];
    await openConversation(id);
    await loadConversations();
    return {
      ok: true,
      effects: payload['effects'] as RoundEffects | undefined,
      removedCount: Array.isArray(payload['removedMessageIds']) ? (payload['removedMessageIds'] as unknown[]).length : 0
    };
  }

  /** 删除本轮：只移除这一轮的提问与回答，其余轮次保持不动 */
  async function deleteRound(conversationId: string, userMessageId: string): Promise<RoundActionResult> {
    return applyRoundAction(conversationId, `/api/conversations/${encodeURIComponent(conversationId)}/rounds/${encodeURIComponent(userMessageId)}`, {
      method: 'DELETE',
      headers: actorHeaders()
    });
  }

  /** 回档：截断到本轮发起前；revertEffects=true 时同时回退本轮产生的业务写入 */
  async function rollbackRound(conversationId: string, userMessageId: string, revertEffects: boolean): Promise<RoundActionResult> {
    return applyRoundAction(conversationId, `/api/conversations/${encodeURIComponent(conversationId)}/rollback`, {
      method: 'POST',
      headers: { ...actorHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageId, revertEffects })
    });
  }

  /** 切换会话类型（聊天 ⇄ 任务）：服务端 PATCH 为权威，本地缓存同步更新 */
  async function setConversationMode(id: string, mode: 'chat' | 'task'): Promise<void> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...actorHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (!res.ok) throw new Error(`切换模式失败：HTTP ${res.status}`);
    setCurrentMode(id, mode);
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...actorHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    await loadConversations();
  }

  return {
    conversations,
    currentId,
    currentMessages,
    currentRounds,
    workConversations,
    chatConversations,
    messages,
    listLoading,
    listError,
    messagesLoading,
    messagesErrors,
    currentMessagesError,
    convModes,
    currentMode,
    setCurrentMode,
    adoptIds,
    draftFor,
    saveDraft,
    loadCurrentId,
    loadConversations,
    openConversation,
    startDraft,
    ensureConversation,
    appendLocal,
    commitRun,
    removeConversation,
    deleteRound,
    rollbackRound,
    renameConversation,
    setConversationMode,
    timeLabel,
    uid,
    roundsOf
  };
});
