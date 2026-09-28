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
  createdAt: string;
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
      const res = await fetch('/api/conversations');
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
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
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
    const res = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    if (!res.ok) throw new Error(`创建会话失败：HTTP ${res.status}`);
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
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    delete messages.value[id];
    delete messagesErrors.value[id];
    if (currentId.value === id) saveCurrentId(null);
    await loadConversations();
  }

  /** 切换会话类型（聊天 ⇄ 任务）：服务端 PATCH 为权威，本地缓存同步更新 */
  async function setConversationMode(id: string, mode: 'chat' | 'task'): Promise<void> {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (!res.ok) throw new Error(`切换模式失败：HTTP ${res.status}`);
    setCurrentMode(id, mode);
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    await loadConversations();
  }

  return {
    conversations,
    currentId,
    currentMessages,
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
    renameConversation,
    setConversationMode,
    timeLabel,
    uid
  };
});
