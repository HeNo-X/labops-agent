import {clientFetch} from '../client';
import {auth} from '../auth/bootstrap';import {actorRole} from '../actor';
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
import type { TaskPlanStep } from '@shared/types';

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
  /** 实际产出这条回答的模型（如 agnes-3.0-flash / deepseek-v4-flash-0731）；规则引擎为空 */
  model?: string | null;
  sourceType?: string | null;
  ms?: number;
  /** A6：provider 上报的真实 token 用量（run_completed.usage 落库进 meta）；拿不到为 null，不估数冒充 */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  /** A5：该轮最后登记的任务计划（meta.plan）；没有登记过就是 null */
  plan?: TaskPlanStep[] | null;
  error?: { code: string; message: string; hint?: string } | null;
  responseMode?: 'chat'|'task';
  queriedAt?:string;
  scope?:string;
  createdAt: string;
  ordinal?:number;
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
  let epoch=0,listGeneration=0;
  const requests=new Map<string,AbortController>(),syncCursors=new Map<string,{cursor:string;revision:string}>();
  const activeRuns=ref<Record<string,string|null>>({});
  function clearPrivate(){epoch++;listGeneration++;for(const c of requests.values())c.abort();requests.clear();syncCursors.clear();loadGen.clear();messages.value={};conversations.value=[];messagesErrors.value={};convModes.value={};drafts.value={};try{for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith('labops.chat-drafts:'))sessionStorage.removeItem(key);}}catch{}activeRuns.value={};saveCurrentId(null);}


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
    const generation=++listGeneration,identity=epoch;
    listLoading.value = true;
    listError.value = null;
    try {
      const res = await clientFetch('/api/conversations', {headers: actorHeaders()});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { conversations: ConvSummary[] };
      if(generation!==listGeneration||identity!==epoch)return;
      conversations.value = j.conversations ?? [];
      for (const c of conversations.value) {
        if (c.mode) convModes.value[c.id] = c.mode;
      }
      // 当前会话被（别处）删除时回落到最近一个
      if (currentId.value && !conversations.value.some((c) => c.id === currentId.value)) {
        saveCurrentId(null);
      }
    } catch (e) {
      if(generation!==listGeneration||identity!==epoch)return;
      listError.value = `会话列表载入失败：${(e as Error).message}`;
    } finally {
      listLoading.value = false;
    }
  }

  // N21：草稿按会话保存
  const drafts = ref<Record<string, string>>({});
  function draftKey(){const profile=auth.profile.value;return 'labops.chat-drafts:'+(profile?profile.identity+':'+profile.username:'demo:'+actorRole()+':'+(sessionStorage.getItem('labops.auth')||''));}
  function draftFor(key: string): string {
    if(drafts.value[key]!==undefined)return drafts.value[key]!;
    try{const saved=JSON.parse(sessionStorage.getItem(draftKey())||'{}'),text=saved?.[key];return typeof text==='string'?text.slice(0,3000):'';}catch{return '';}
  }
  function saveDraft(key: string, text: string): void {
    drafts.value[key] = text;
    try{let saved:Record<string,unknown>={};try{const raw=JSON.parse(sessionStorage.getItem(draftKey())||'{}');if(raw&&typeof raw==='object'&&!Array.isArray(raw))saved=raw;}catch{}
      if(text)saved[key]=text.slice(0,3000);else delete saved[key];
      const entries=Object.entries(saved).filter(([k,v])=>k.length<150&&typeof v==='string').slice(-100);
      if(entries.length)sessionStorage.setItem(draftKey(),JSON.stringify(Object.fromEntries(entries)));else sessionStorage.removeItem(draftKey());
    }catch{}
  }

  function fromServer(m:Record<string,unknown>):ChatMessage{
    const meta=(m['meta']||{}) as Record<string,unknown>;
    return {id:String(m['id']),role:m['role'] as ChatMessage['role'],text:String(m['text']||''),status:(m['status'] as ChatMessage['status'])||'completed',toolCalls:(meta['toolCalls'] as ToolCallRecord[])||[],engine:meta['engine'] as string|null,model:meta['model'] as string|null,sourceType:meta['sourceType'] as string|null,ms:Number(meta['ms'])||undefined,usage:(meta['usage'] as ChatMessage['usage'])??null,plan:(meta['plan'] as TaskPlanStep[]|null)??null,error:meta['error'] as ChatMessage['error'],responseMode:meta['responseMode'] as 'chat'|'task'|undefined,queriedAt:meta['queriedAt'] as string|undefined,scope:meta['scope'] as string|undefined,createdAt:String(m['createdAt']||''),ordinal:Number(m['ordinal'])};
  }
  async function syncConversation(id:string,select=false):Promise<void>{
    if(select)saveCurrentId(id);
    if(requests.has(id))return;
    const controller=new AbortController(),identity=epoch;requests.set(id,controller);
    if(!messages.value[id])messagesLoading.value=true;
    try{
      const cursor=syncCursors.get(id),q=cursor?'?'+new URLSearchParams(cursor):'';
      const res=await clientFetch(`/api/conversations/${encodeURIComponent(id)}${q}`,{headers:actorHeaders(),signal:controller.signal});
      if(!res.ok)throw await responseError(res);
      const data=await res.json() as {mode?:'chat'|'task';messages:Record<string,unknown>[];messageIds?:string[];cursor?:string;revision?:string;reset?:boolean;activeRunId?:string|null};
      if(identity!==epoch)return;
      if(data.mode)setCurrentMode(id,data.mode);
      const local=messages.value[id]||[],ids=data.messageIds?new Set(data.messageIds):null,map=new Map(local.filter(m=>!ids||ids.has(m.id)||Boolean(activeRuns.value[id])&&(m.status==='streaming'||m.id.startsWith('local-u-'))).map(m=>[m.id,m]));
      for(const raw of data.messages||[]){const m=fromServer(raw),old=map.get(m.id);if(old){if(old.status!=='streaming'||m.status!=='streaming')Object.assign(old,m);}else map.set(m.id,m);}
      messages.value[id]=Array.from(map.values()).sort((a,b)=>(a.ordinal??Infinity)-(b.ordinal??Infinity)||a.createdAt.localeCompare(b.createdAt));
      if(data.cursor&&data.revision)syncCursors.set(id,{cursor:data.cursor,revision:data.revision});
      activeRuns.value[id]=data.activeRunId||null;delete messagesErrors.value[id];
    }catch(e){if(identity===epoch&&(e as Error).name!=='AbortError')messagesErrors.value[id]='消息载入失败：'+(e as Error).message;}
    finally{if(identity===epoch){requests.delete(id);messagesLoading.value=false;}}
  }
  async function openConversation(id:string):Promise<void>{await syncConversation(id,true);}

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
    const res = await clientFetch('/api/conversations', { method: 'POST', headers: { ...actorHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
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
  function commitRun(payload: { role: 'user' | 'assistant'; text: string; status: ChatMessage['status']; toolCalls: ToolCallRecord[]; engine?: string | null; model?: string | null; sourceType?: string | null; ms?: number; error?: ChatMessage['error']; clientRequestId: string }): void {
    const id = currentId.value;
    if (!id) return;
    appendLocal(id, {
      id: uid(payload.role === 'user' ? 'm-u' : 'm-a'),
      role: payload.role,
      text: payload.text,
      status: payload.status,
      toolCalls: payload.toolCalls,
      engine: payload.engine ?? null,
      model: payload.model ?? null,
      sourceType: payload.sourceType ?? null,
      ms: payload.ms,
      error: payload.error ?? null,
      createdAt: new Date().toISOString()
    });
    void loadConversations();
  }

  async function removeConversation(id: string): Promise<void> {
    const response=await clientFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', headers: actorHeaders() });
    if(!response.ok)throw await responseError(response);
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
      const res = await clientFetch(path, init);
      payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return { ok: false, message: String(payload['message'] ?? `HTTP ${res.status}`) };
      }
    } catch (e) {
      return { ok: false, message: `网络请求失败：${(e as Error).message}` };
    }
    syncCursors.delete(id);
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

  // A8（2026-10-31 用户要求）：恢复会话模式切换——服务端锁定已解除，模式随
  // 发送时刻生效，历史消息语义不变。改名照常走 renameConversation。
  async function renameConversation(id: string, title: string): Promise<void> {
    const response=await clientFetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...actorHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if(!response.ok)throw await responseError(response);
    await loadConversations();
  }

  /** 切换会话模式（chat↔task）：PATCH 成功后同步本地两处状态（当前模式 + 会话列表） */
  async function changeConversationMode(id: string, mode: 'chat' | 'task'): Promise<void> {
    const response=await clientFetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...actorHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if(!response.ok)throw await responseError(response);
    setCurrentMode(id, mode);
    await loadConversations();
  }

  return {
    clearPrivate,syncConversation,activeRuns,saveCurrentId,
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
    changeConversationMode,
    timeLabel,
    uid,
    roundsOf
  };
});
