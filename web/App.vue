<script setup lang="ts">
/**
 * 会话工作台 —— 应用外壳（M2：左侧导航 + 连续消息流，F01/F23/F25）
 * ============================================================================
 *  · 左侧导航：新聊天 / 工作会话 / 聊天会话（按模式分区，各自可折叠、可新建）/
 *    我的任务 / 业务工具（折叠区）/ 状态与主题
 *  · 中央：按「轮」渲染的连续消息流（每轮 = 一条提问 + 其回答），
 *    每轮带 hover 操作条：删除本轮（两种模式）/ 回档 + 修改（仅工作模式，0.6.0）
 *  · 房间点击只回填草稿，不自动发请求（F29）；发送后草稿清空（F27）
 *  · 主题：跟随系统 = 显式解析 prefers-color-scheme 并实时响应（F28 已修，保持）
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRunStore } from './stores/run';
import { useSessionStore } from './stores/session';
import type { ChatMessage as ChatMessageData, Round, RoundEffects } from './stores/session';
import { useAgentStream } from './composables/useAgentStream';
import LabMatrix from './components/LabMatrix.vue';
import CommandBar from './components/CommandBar.vue';
import ChatMessage from './components/ChatMessage.vue';
import RoundToolbar from './components/RoundToolbar.vue';
import RoundActionDialog from './components/RoundActionDialog.vue';
import NativeWorkPanel from './components/NativeWorkPanel.vue';
import BusinessConnectionPanel from './components/BusinessConnectionPanel.vue';
import {useBusinessStore} from './stores/business';
import EvidencePanel from './components/EvidencePanel.vue';
import ScheduledJobsPanel from './components/ScheduledJobsPanel.vue';
import LoginView from './components/LoginView.vue';
import SourceBadge from './components/SourceBadge.vue';
import { ACTOR_ROLE_LABELS, actorHeaders, actorRole, setActorRole } from './actor';
import type { ActorRole } from './actor';
import { TASK_STATUS_LABELS } from '@shared/operations-contract';
import type { TaskStatus } from '@shared/operations-contract';

/** 任务中心条目（/api/tasks；字段与 TaskRecord 对齐，前端只读展示） */
interface TaskRow {
  taskId: string;
  conversationId: string | null;
  kind: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
}

const updateViewport=()=>document.documentElement.style.setProperty('--app-height',Math.round(window.visualViewport?.height||window.innerHeight)+'px');
onMounted(()=>{updateViewport();window.visualViewport?.addEventListener('resize',updateViewport);window.addEventListener('resize',updateViewport);});
onUnmounted(()=>{window.visualViewport?.removeEventListener('resize',updateViewport);window.removeEventListener('resize',updateViewport);});
const store = useRunStore();
const session = useSessionStore();
const business=useBusinessStore();
watch(()=>business.scopeKey,(next,old)=>{
  if(old===next)return;
  void store.loadOverview();
  if(store.runStatus!=='running'){
    store.resetRun();
    session.messages={};
    if(session.currentId)void session.openConversation(session.currentId);
  }
});
const authMode = ref<'native'|'demo'>('native');
const authed = ref(false), authLoading = ref(true), authError = ref('');
async function loadWorkspace(conversationId?:string):Promise<void>{
  await business.refresh();
  if(authMode.value==='native'&&business.profile)actor.value=business.profile.identity as ActorRole;
  await Promise.all([store.loadOverview(),loadTasks(),session.loadConversations()]);
  await session.loadCurrentId();
  const id=conversationId||session.currentId;
  if(id&&session.conversations.some(c=>c.id===id))await session.openConversation(id);
  else session.startDraft();
}
async function bootstrapAuth():Promise<void>{
  authLoading.value=true;authError.value='';
  try{
    const fragment=new URLSearchParams(location.hash.slice(1)),ticket=fragment.get('labops-ticket');
    if(ticket)history.replaceState(null,'',location.pathname+location.search);
    const res=await fetch(ticket?'/api/auth/sso/exchange':'/api/auth/session',ticket?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})}:{});
    const data=await res.json();authMode.value=data.mode==='demo'?'demo':'native';
    if(!res.ok)throw new Error(data.message||'登录状态无法验证');
    authed.value=authMode.value==='demo'?sessionStorage.getItem('labops.auth')!==null:Boolean(data.authenticated);
    if(authed.value)await loadWorkspace(data.conversationId||undefined);
  }catch(e){authed.value=false;authError.value=(e as Error).message;}
  finally{authLoading.value=false;}
}
async function onLogin(account: string):Promise<void>{
  sessionStorage.setItem('labops.auth',account);
  if(authMode.value==='demo'){authed.value=true;await loadWorkspace();}
  else await bootstrapAuth();
}
async function logout():Promise<void>{
  cancel();await fetch('/api/auth/logout',{method:'POST'}).catch(()=>undefined);
  sessionStorage.removeItem('labops.auth');session.messages={};session.conversations=[];session.startDraft();store.resetRun();authed.value=false;
}
const { start, cancel } = useAgentStream();

const draft = ref('');
// N21：草稿按会话保存；切回会话时恢复
watch(
  () => session.currentId,
  (id) => {
    draft.value = id ? session.draftFor(id) : session.draftFor('__new');
  }
);
watch(draft, (t) => session.saveDraft(session.currentId ?? '__new', t));
const msgsEl = ref<HTMLElement | null>(null);
const navOpen = ref(false);
/** 右侧房间侧边栏：宽屏默认展开，窄屏默认收起；用户选择持久化（停靠式，可收起为窄轨） */
const roomsOpen = ref(window.innerWidth >= 1280);
try {
  const saved = localStorage.getItem('labops.rooms');
  if (saved === 'open' && window.innerWidth > 900) roomsOpen.value = true;
  else if (saved === 'closed') roomsOpen.value = false;
} catch {
  /* 忽略 */
}
function toggleRooms(open: boolean): void {
  roomsOpen.value = open;
  try {
    localStorage.setItem('labops.rooms', open ? 'open' : 'closed');
  } catch {
    /* 忽略 */
  }
}
let lastViewportWidth = window.innerWidth;
function collapseRailOnMobile(): void {
  if (window.innerWidth <= 900 && lastViewportWidth > 900) roomsOpen.value = false;
  lastViewportWidth = window.innerWidth;
}
onMounted(() => window.addEventListener('resize', collapseRailOnMobile));
onUnmounted(() => window.removeEventListener('resize', collapseRailOnMobile));

// ---- 会话类型（聊天 / 任务）----
// hero（还没有会话）用 draftMode 选择；**会话一旦开始对话，模式即确定**：
// 2026-10-06 用户要求 —— 会话内部不再提供切换入口，服务端同样以 409 拒绝改模式，
// 否则同一条历史会在"只查询"和"可办理"两种语义之间漂移。
type ConvMode = 'chat' | 'task';
const draftMode = ref<ConvMode>('task');
const convMode = computed<ConvMode>(() => session.currentMode());
const modeLabel = (m: ConvMode): string => (m === 'chat' ? '聊天会话' : '工作会话');
const modeLockTip = computed(
  () => `本会话已确定为${modeLabel(convMode.value)}：${convMode.value === 'chat' ? '只查询数据，不准备办理单' : '可查询、可准备办理单并执行'}。开始对话后模式不可更改，需要另一种模式请新建会话。`
);

/** 活跃轮的助手占位消息（直接写入会话消息数组，流式更新同一对象） */
let liveTarget: ChatMessageData | null = null;

type ThemeMode = 'auto' | 'light' | 'dark';
const themeMode = ref<ThemeMode>('auto');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'auto' ? (systemDark.matches ? 'dark' : 'light') : mode;
}

function applyTheme(mode: ThemeMode): void {
  themeMode.value = mode;
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  try {
    localStorage.setItem('labops.theme', mode);
  } catch {
    /* 忽略 */
  }
}

systemDark.addEventListener?.('change', () => {
  if (themeMode.value === 'auto') {
    document.documentElement.setAttribute('data-theme', resolveTheme('auto'));
  }
});

onMounted(() => {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      navOpen.value = false;
    }
  });
  let saved: ThemeMode = 'auto';
  try {
    const v = localStorage.getItem('labops.theme');
    if (v === 'light' || v === 'dark' || v === 'auto') saved = v;
  } catch {
    /* 忽略 */
  }
  applyTheme(saved);
  void bootstrapAuth();
});

// ---- ops.v1：任务中心 + 沙盒演示身份（仅沙盒可切换视角，服务端校验）----
const tasks = ref<TaskRow[]>([]);
const tasksError = ref<string | null>(null);
const actor = ref<ActorRole>(actorRole());

async function loadTasks(): Promise<void> {
  try {
    const res = await fetch('/api/tasks', { headers: actorHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { tasks: TaskRow[] };
    tasks.value = j.tasks ?? [];
    tasksError.value = null;
  } catch (e) {
    tasksError.value = `任务列表载入失败：${(e as Error).message}`;
  }
}

function switchRole(r: ActorRole): void {
  if(store.runStatus==='running'||r===actor.value)return;
  setActorRole(r);
  session.startDraft();
  session.messages={};
  session.conversations=[];
  store.resetRun();
  void business.refresh();
  actor.value = r;
  void session.loadConversations();
  void store.loadOverview();
  void loadTasks();
}

function openTask(t: TaskRow): void {
  if (t.conversationId && session.conversations.some((c) => c.id === t.conversationId)) {
    void session.openConversation(t.conversationId);
    navOpen.value = false;
  }
}

const currentTitle = computed(() => {
  const c = session.conversations.find((x) => x.id === session.currentId);
  return c?.title ?? '新会话';
});

// ---- 活跃轮同步 + 滚动跟随（A33 简化版）----
// 流式期间把 run store 的实时状态写进占位消息对象（同一引用，历史即时可见）
function scrollFollow(): void {
  const el = msgsEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}
watch(
  () => [store.stream, store.toolCalls, store.runStatus, store.elapsedMs] as const,
  () => {
    const live = resolveLive();
    if (!live) return;
    live.text = store.stream;
    live.toolCalls = [...store.toolCalls];
    live.status =
      store.runStatus === 'running'
        ? 'streaming'
        : store.runStatus === 'completed'
          ? 'completed'
          : store.runStatus === 'failed'
            ? 'failed'
            : store.runStatus === 'cancelled'
              ? 'cancelled'
              : 'interrupted';
    live.ms = store.elapsedMs;
  }
);
watch(
  () => session.currentMessages.length + store.stream.length,
  async () => {
    if (!liveTarget) return;
    await nextTick();
    scrollFollow();
  }
);

/** 统一提交入口（F02）：任何来源的提问都走这里，运行中一律拒绝并返回 */
let submitting = ref(false);
/** 本次提交的令牌：回调只处理自己这一次提交的事件（runId 采纳后由服务端生成） */
let activeToken = '';
/** R04：活跃轮按 (会话, 消息 ID) 解析目标 —— 历史刷新替换数组也不会跟丢 */
let liveConvId: string | null = null;
let liveMsgId: string | null = null;

function resolveLive(): ChatMessageData | null {
  if (!liveConvId || !liveMsgId) return null;
  return session.messages[liveConvId]?.find((m) => m.id === liveMsgId) ?? null;
}
async function onSubmit(q: string): Promise<void> {
  // N04：**同步**占用提交锁，覆盖"await 创建会话"的窗口 —— 快速双击/连按 Enter 只发一次
  if (submitting.value || store.inputLocked || !q.trim()) return;
  submitting.value = true;
  navOpen.value = false;
  const clientRequestId = session.uid('req');
  let convId: string | null = session.currentId;
  try {
    convId = await session.ensureConversation(q, convId, clientRequestId, draftMode.value);
  } catch (e) {
    session.listError = `创建会话失败：${(e as Error).message}`;
    submitting.value = false;
    return;
  }
  if (session.messages[convId] && !session.messages[convId]!.some((m) => m.id === `local-u-${clientRequestId}`)) {
    session.appendLocal(convId, {
      id: `local-u-${clientRequestId}`,
      role: 'user',
      text: q,
      status: 'completed',
      toolCalls: [],
      createdAt: new Date().toISOString()
    });
  }
  const rid = store.beginRun(q);
  submitting.value = false;
  activeToken = rid;
  liveConvId = convId;
  // 助手占位：流式更新同一对象，结束后留在历史里（F01）
  // ⚠️ 必须持有响应式代理（从 store 取回），持有原始对象的话 mutation 不触发更新
  session.appendLocal(convId, {
    id: `live-${rid}`,
    role: 'assistant',
    responseMode:session.currentMode(),
    text: '',
    status: 'streaming',
    toolCalls: [],
    createdAt: new Date().toISOString()
  });
  liveMsgId = `live-${rid}`;
  await nextTick();
  scrollFollow();

  void start({
    message: q,
    runId: rid,
    sessionId: store.sessionId ?? undefined,
    conversationId: convId,
    clientRequestId,
    // 每个回调绑定本次提交令牌：旧流的迟到事件/错误/收尾不得触碰新任务（F02/F10/N01）
    onEvent: (ev) => {
      if (activeToken !== rid) return;
      if (ev.type === 'run_accepted') {
        // runId 在事件信封顶层；R04：正式消息 ID 在此对齐临时 ID
        store.adoptRunId(String(ev.runId ?? ''));
        const p = ev.payload as Record<string, unknown>;
        session.adoptIds(
          convId,
          clientRequestId,
          rid,
          String(p['userMessageId'] ?? ''),
          String(p['assistantMessageId'] ?? '')
        );
        if (liveMsgId?.startsWith('live-')) liveMsgId = String(p['assistantMessageId'] ?? liveMsgId);
        return;
      }
      store.ingest(ev);
    },
    onError: (err) => {
      if (activeToken !== rid) return;
      store.failRun(err);
    },
    onClose: () => {
      if (activeToken !== rid) return;
      activeToken = '';
      store.finishRun();
      finalizeLive();
    }
  });

  function finalizeLive(): void {
    const live = resolveLive();
    if (live) {
      live.text = store.stream || (store.runStatus === 'failed' ? '' : live.text);
      live.status =
        store.runStatus === 'completed'
          ? 'completed'
          : store.runStatus === 'failed'
            ? 'failed'
            : store.runStatus === 'cancelled'
              ? 'cancelled'
              : 'interrupted';
      live.toolCalls = [...store.toolCalls];
      live.engine = store.engine;
      live.sourceType = store.sourceType;
      live.ms = store.elapsedMs;
      live.error = store.error ? { ...store.error } : null;
    }
    liveConvId = null;
    liveMsgId = null;
    void session.loadConversations();
    void loadTasks();
  }
}

async function onCancel(): Promise<void> {
  // N06/R06：先送达取消请求（服务端记 cancelled），再断开本地流 —— 次序反了会被记成 interrupted
  if (session.currentId && store.runId) {
    try {
      await Promise.race([
        fetch(`/api/runs/${encodeURIComponent(store.runId)}/cancel`, { method: 'POST', headers: actorHeaders() }),
        new Promise((r) => setTimeout(r, 800))
      ]);
    } catch {
      /* 取消请求失败也照样本地停止 */
    }
  }
  cancel();
}

function onNewChat(mode?: ConvMode): void {
  if (store.inputLocked) return;
  if (mode) draftMode.value = mode;
  session.startDraft();
  navOpen.value = false;
}

function onRetry(msg: ChatMessageData): void {
  const list = session.currentMessages;
  const idx = list.findIndex((m) => m.id === msg.id);
  for (let i = idx - 1; i >= 0; i--) {
    if (list[i]!.role === 'user') {
      void onSubmit(list[i]!.text);
      return;
    }
  }
}

function onRename(id: string, title: string): void {
  const next = window.prompt('重命名会话', title);
  if (next && next.trim() && next.trim() !== title) void session.renameConversation(id, next.trim());
}

function onDelete(id: string, title: string): void {
  // N20/R12：按会话**实际**活跃状态拦截，不按当前选中页判断
  if (store.inputLocked && liveConvId === id) {
    window.alert('该会话正在执行任务，请先停止再删除。');
    return;
  }
  if (window.confirm(`删除会话「${title}」？删除后可在数据库中恢复（软删除）。`)) {
    void session.removeConversation(id);
  }
}

function onPickRoom(q: string): void {
  // F29：房间点击只回填草稿，不自动发送
  draft.value = q;
}

// ---- 侧栏分区：工作会话 / 聊天会话（0.6.0）----
// 折叠态持久化：用户希望"我不关心聊天会话"这件事被记住，而不是每次重新折一遍
const navFolded = ref<{ work: boolean; chat: boolean }>({ work: false, chat: false });
try {
  const raw = localStorage.getItem('labops.nav.folded');
  if (raw) {
    const j = JSON.parse(raw) as Partial<{ work: boolean; chat: boolean }>;
    navFolded.value = { work: j?.work === true, chat: j?.chat === true };
  }
} catch {
  /* 忽略损坏的本地偏好 */
}
function toggleSection(key: 'work' | 'chat'): void {
  navFolded.value = { ...navFolded.value, [key]: !navFolded.value[key] };
  try {
    localStorage.setItem('labops.nav.folded', JSON.stringify(navFolded.value));
  } catch {
    /* 忽略 */
  }
}

// ---- 轮次操作：删除本轮 / 回档 / 修改（0.6.0）----
const rounds = computed<Round[]>(() => session.currentRounds);
const roundDialog = ref<{
  open: boolean;
  kind: 'rollback' | 'edit';
  userMessageId: string;
  index: number;
  question: string;
  business: boolean;
}>({ open: false, kind: 'rollback', userMessageId: '', index: 0, question: '', business: false });
const roundDialogBusy = ref(false);
const roundDialogError = ref('');
/** 操作结果横幅：回档/删除之后必须让用户看到"到底发生了什么"，而不是只弹一个"成功" */
const roundNotice = ref<{ tone: 'ok' | 'warn' | 'danger'; lines: string[] } | null>(null);

/**
 * 该轮是否牵涉业务办理 —— 决定弹窗提示强度。
 * ⚠️ 只看"这一轮有没有产出业务单/原系统方案"，不看结果里的 state：
 * 提案卡是在准备那一刻写进消息 meta 的，用户随后点确认执行并不会回写这里，
 * 拿旧 state 判断会把"已执行的轮次"误判成"没牵涉业务"，正是最危险的方向。
 */
function roundTouchesBusiness(r: Round): boolean {
  return r.messages.some(
    (m) =>
      m.role === 'assistant' &&
      m.toolCalls.some((t) => {
        if (t.resultKind === 'operation_proposal') return Boolean(t.result);
        if (t.resultKind === 'business_plan') {
          const res = t.result as { planId?: string | null; plan?: { state?: string } | null; receipt?: unknown } | null;
          return Boolean(res) && Boolean(res!.planId || res!.receipt || res!.plan);
        }
        return false;
      })
  );
}

/** 把服务端的业务写入报告翻成人话；没有内容就返回空数组（界面不显示空横幅行） */
function effectsLines(effects: RoundEffects | undefined): string[] {
  if (!effects) return [];
  const lines: string[] = [];
  if (effects.reverted.length) {
    lines.push(`已回退沙盒写入 ${effects.reverted.length} 项：${effects.reverted.map((r) => `${r.objectKind} ${r.objectId}`).join('、')}`);
  }
  if (effects.rejectedPlans.length) {
    lines.push(`已作废原系统待确认方案 ${effects.rejectedPlans.length} 个：${effects.rejectedPlans.join('、')}`);
  }
  if (effects.supersededProposals.length) lines.push(`已作废待确认提案 ${effects.supersededProposals.length} 个`);
  if (effects.cancelledTasks.length) lines.push(`已取消任务 ${effects.cancelledTasks.length} 个`);
  if (effects.notReverted.length) {
    lines.push(`未回退的写入 ${effects.notReverted.length} 项：${effects.notReverted.map((r) => `${r.objectKind} ${r.objectId}（${r.reason}）`).join('；')}`);
  }
  if (effects.blocked.length) {
    lines.push(
      `原系统已提交、无法自动撤回 ${effects.blocked.length} 项：${effects.blocked
        .map((b) => `${b.planId}${b.objects.length ? `（${b.objects.map((o) => `${o.kind} ${o.id}`).join('、')}）` : ''}`)
        .join('；')}——需要人工在原系统处理`
    );
  }
  for (const n of effects.notes) lines.push(n);
  return lines;
}

function closeRoundDialog(): void {
  if (roundDialogBusy.value) return;
  roundDialog.value = { ...roundDialog.value, open: false };
  roundDialogError.value = '';
}

function openRoundDialog(kind: 'rollback' | 'edit', r: Round): void {
  if (store.inputLocked || !r.userMessage) return;
  roundDialogError.value = '';
  roundDialog.value = {
    open: true,
    kind,
    userMessageId: r.userMessage.id,
    index: rounds.value.indexOf(r) + 1,
    question: r.userMessage.text,
    business: roundTouchesBusiness(r)
  };
}

function onDeleteRound(r: Round): void {
  const id = session.currentId;
  if (store.inputLocked || !r.userMessage || !id) return;
  const index = rounds.value.indexOf(r) + 1;
  if (!window.confirm(`删除第 ${index} 轮？该轮提问与回答都会移除；已执行的业务写入不会因此回退（需要回退请用「回档」）。`)) return;
  void (async () => {
    const res = await session.deleteRound(id, r.userMessage!.id);
    roundNotice.value = res.ok
      ? { tone: 'ok', lines: [`已删除第 ${index} 轮（移除 ${res.removedCount ?? 0} 条消息）。`, ...effectsLines(res.effects)] }
      : { tone: 'danger', lines: [res.message ?? '删除失败'] };
    if (res.ok) void loadTasks();
  })();
}

/**
 * 回档 / 修改的确认入口。两者共用同一次服务端调用，区别只在"要不要把新内容重新发出去"：
 *   · 回档：截断即结束；
 *   · 修改：截断**成功之后**才重发 —— 顺序反了会让旧轮与新轮并存。
 */
async function onConfirmRoundDialog(payload: { text: string; revertEffects: boolean }): Promise<void> {
  const id = session.currentId;
  if (!id || roundDialogBusy.value) return;
  const { kind, userMessageId, index } = roundDialog.value;
  roundDialogBusy.value = true;
  roundDialogError.value = '';
  roundNotice.value = null;
  try {
    const res = await session.rollbackRound(id, userMessageId, payload.revertEffects);
    if (!res.ok) {
      roundDialogError.value = res.message ?? '回档失败';
      return;
    }
    roundDialog.value = { ...roundDialog.value, open: false };
    roundNotice.value = { tone: 'ok', lines: [`已回档到第 ${index} 轮发起前（移除 ${res.removedCount ?? 0} 条消息）。`, ...effectsLines(res.effects)] };
    void loadTasks();
    if (kind === 'edit') await onSubmit(payload.text);
  } finally {
    roundDialogBusy.value = false;
  }
}

</script>

<template>
  <p v-if="authLoading" class="auth-status" role="status">正在验证主系统登录状态…</p>
  <template v-else-if="!authed"><p v-if="authError" class="auth-status" role="alert">{{authError}}</p><LoginView :mode="authMode" @done="onLogin" /></template>
  <div v-else class="app" :class="{ 'app--railclosed': !roomsOpen }">
    <!-- 左侧导航 -->
    <aside class="nav" :class="{ 'nav--open': navOpen }" aria-label="会话导航">
      <div class="nav__brand">
        <span class="nav__mark" aria-hidden="true">▤</span>
        <b>启真 LabOps</b>
      </div>
      <button type="button" class="nav__new" @click="onNewChat()">＋ 新聊天</button>

      <!-- 工作会话：能查询、能准备办理单并执行（mode=task） -->
      <div class="nav__section">
        <h2 class="nav__h">
          <button
            type="button"
            class="nav__fold"
            :aria-expanded="!navFolded.work"
            aria-controls="nav-work-list"
            title="工作会话可以查询数据、准备办理单并执行"
            @click="toggleSection('work')"
          >
            <span class="nav__chev" aria-hidden="true">{{ navFolded.work ? '▸' : '▾' }}</span>工作会话
          </button>
          <span class="nav__count">{{ session.workConversations.length }}</span>
          <button
            type="button"
            class="nav__add"
            aria-label="新建工作会话"
            title="新建工作会话（可查询、可办理）"
            :disabled="store.inputLocked"
            @click="onNewChat('task')"
          >
            ＋
          </button>
        </h2>
        <template v-if="!navFolded.work">
          <p v-if="session.listError" class="nav__err" role="alert">{{ session.listError }}</p>
          <p v-else-if="session.listLoading && !session.conversations.length" class="nav__hint">载入中…</p>
          <p v-else-if="!session.workConversations.length" class="nav__hint">
            还没有工作会话。发第一条消息即可开始办理事务。
          </p>
          <ul v-else id="nav-work-list" class="nav__convs">
            <li v-for="c in session.workConversations" :key="c.id">
              <button
                type="button"
                class="conv"
                :class="{ 'conv--on': c.id === session.currentId }"
                :title="`${c.title}（${c.messageCount} 条消息 · 工作会话）`"
                @click="session.openConversation(c.id); navOpen = false"
              >
                <span class="conv__title">{{ c.title }}</span>
                <span class="conv__time">{{ session.timeLabel(c.lastActivityAt) }}</span>
              </button>
              <button
                type="button"
                class="conv__del"
                :aria-label="`重命名会话：${c.title}`"
                title="重命名"
                @click="onRename(c.id, c.title)"
              >
                ✎
              </button>
              <button
                type="button"
                class="conv__del"
                :aria-label="`删除会话：${c.title}`"
                title="删除会话"
                @click="onDelete(c.id, c.title)"
              >
                ✕
              </button>
            </li>
          </ul>
        </template>
      </div>

      <!-- 聊天会话：只查询、不办理（mode=chat） -->
      <div class="nav__section">
        <h2 class="nav__h">
          <button
            type="button"
            class="nav__fold"
            :aria-expanded="!navFolded.chat"
            aria-controls="nav-chat-list"
            title="聊天会话只查询数据，不准备办理单"
            @click="toggleSection('chat')"
          >
            <span class="nav__chev" aria-hidden="true">{{ navFolded.chat ? '▸' : '▾' }}</span>聊天会话
          </button>
          <span class="nav__count">{{ session.chatConversations.length }}</span>
          <button
            type="button"
            class="nav__add"
            aria-label="新建聊天会话"
            title="新建聊天会话（只查询，不办理）"
            :disabled="store.inputLocked"
            @click="onNewChat('chat')"
          >
            ＋
          </button>
        </h2>
        <template v-if="!navFolded.chat">
          <p v-if="!session.chatConversations.length" class="nav__hint">还没有聊天会话。聊天只查询，不办理事务。</p>
          <ul v-else id="nav-chat-list" class="nav__convs">
            <li v-for="c in session.chatConversations" :key="c.id">
              <button
                type="button"
                class="conv"
                :class="{ 'conv--on': c.id === session.currentId }"
                :title="`${c.title}（${c.messageCount} 条消息 · 聊天会话）`"
                @click="session.openConversation(c.id); navOpen = false"
              >
                <span class="conv__title">{{ c.title }}</span>
                <span class="conv__time">{{ session.timeLabel(c.lastActivityAt) }}</span>
              </button>
              <button
                type="button"
                class="conv__del"
                :aria-label="`重命名会话：${c.title}`"
                title="重命名"
                @click="onRename(c.id, c.title)"
              >
                ✎
              </button>
              <button
                type="button"
                class="conv__del"
                :aria-label="`删除会话：${c.title}`"
                title="删除会话"
                @click="onDelete(c.id, c.title)"
              >
                ✕
              </button>
            </li>
          </ul>
        </template>
      </div>

      <div class="nav__section">
        <h2 class="nav__h">我的任务</h2>
        <p v-if="tasksError" class="nav__err" role="alert">{{ tasksError }}</p>
        <p v-else-if="!tasks.length" class="nav__hint">
          {{ business.connected ? '原系统办理记录保存在对应会话中，点击最近会话可回查。' : '还没有业务任务。试试「E310 投影没有信号，帮我报修」「发布通知《…》」或「结束值班收尾」。' }}
        </p>
        <ul v-else class="nav__convs">
          <li v-for="t in tasks.slice(0, 12)" :key="t.taskId">
            <button
              type="button"
              class="conv"
              :title="`${t.goal}（${TASK_STATUS_LABELS[t.status]}）`"
              @click="openTask(t)"
            >
              <span class="conv__title">{{ t.goal }}</span>
              <span class="conv__time">{{ TASK_STATUS_LABELS[t.status] }} · {{ session.timeLabel(t.createdAt) }}</span>
            </button>
          </li>
        </ul>
      </div>

      <!-- 业务工具（2026-10-06：原在工作区顶部的横排按钮，按负责人要求移到左侧栏，形态更接近常规 Agent） -->
      <div class="nav__section">
        <h2 class="nav__h">业务工具</h2>
        <div class="nav__tools">
          <ScheduledJobsPanel :readonly="(session.currentId?convMode:draftMode)==='chat'" />
          <EvidencePanel :readonly="(session.currentId?convMode:draftMode)==='chat'" />
        </div>
      </div>

      <div class="nav__foot">
        <div v-if="authMode==='demo'" class="nav__actor" role="group" aria-label="沙盒演示身份">
          <button
            v-for="r in (['admin', 'volunteer', 'student'] as ActorRole[])"
            :key="r"
            type="button"
            class="theme__btn"
            :disabled="store.runStatus==='running'"
            :class="{ 'theme__btn--on': actor === r }"
            :aria-pressed="actor === r"
            :title="`切换沙盒演示视角：${ACTOR_ROLE_LABELS[r]}（能力边界由服务端校验）`"
            @click="switchRole(r)"
          >
            {{ ACTOR_ROLE_LABELS[r].replace('演示', '') }}
          </button>
        </div>
        <button v-if="authMode==='native'" type="button" class="theme__btn" @click="logout">退出登录</button>
        <SourceBadge :source-type="store.sourceType ?? store.overviewSourceType" :engine="store.activeEngine" compact />
        <div class="nav__theme" role="group" aria-label="主题切换">
          <button
            v-for="m in (['auto', 'light', 'dark'] as ThemeMode[])"
            :key="m"
            type="button"
            class="theme__btn"
            :class="{ 'theme__btn--on': themeMode === m }"
            :aria-pressed="themeMode === m"
            @click="applyTheme(m)"
          >
            {{ m === 'auto' ? '跟随系统' : m === 'light' ? '浅色' : '深色' }}
          </button>
        </div>
      </div>
    </aside>
    <div v-if="navOpen" class="nav__mask" @click="navOpen = false"></div>

    <!-- 主区：会话（有消息时列高锁定视口，输入框固定在底部） -->
    <main class="chat" :class="{ 'chat--conv': session.currentId && session.currentMessages.length > 0 }">
      <BusinessConnectionPanel :unified="authMode==='native'" /><div class="workspace-tools"><NativeWorkPanel v-if="(session.currentId?convMode:draftMode)!=='chat'" /></div>

      <!-- 轮次操作结果：回档/删除之后必须让用户看到真实后果（含撤不回来的写入）。
           放在 hero/会话两个分支之前 —— 回档到第一轮会让会话变空，那时更需要这条说明。 -->
      <div v-if="roundNotice" class="chat__notice" :class="`chat__notice--${roundNotice.tone}`" role="status">
        <ul class="chat__noticelist">
          <li v-for="(line, i) in roundNotice.lines" :key="i">{{ line }}</li>
        </ul>
        <button type="button" class="chat__noticedismiss" aria-label="关闭提示" title="关闭" @click="roundNotice = null">✕</button>
      </div>

      <!-- 空会话：欢迎页即输入（保持居中首屏形态） -->
      <div v-if="!session.currentId || session.currentMessages.length === 0" class="hero">
        <button type="button" class="chat__navtoggle hero__navtoggle" @click="navOpen = !navOpen">会话</button>

        <div class="mode-seg mode-seg--hero" role="group" aria-label="会话模式">
          <button
            type="button"
            class="mode-seg__btn"
            :class="{ 'mode-seg__btn--on': draftMode === 'chat' }"
            :aria-pressed="draftMode === 'chat'"
            title="聊天查询：可读取数据，不准备办理单"
            @click="draftMode = 'chat'"
          >
            聊天
          </button>
          <button
            type="button"
            class="mode-seg__btn"
            :class="{ 'mode-seg__btn--on': draftMode === 'task' }"
            :aria-pressed="draftMode === 'task'"
            title="任务工作台：查询数据、生成办理单并执行"
            @click="draftMode = 'task'"
          >
            任务
          </button>
        </div>

        <template v-if="draftMode === 'task'">
          <h1 class="hero__h">交代一件实验室任务</h1>
          <p class="hero__p">
            查课表、看房间开放状态、找空闲实验室。说清房间号与日期即可，例如「E310 2026-09-30 有哪些课？」。
          </p>
          <CommandBar v-model:draft="draft" variant="hero" :submitting="submitting" @submit="onSubmit" @cancel="onCancel" />
          <p class="hero__scope">
            查课表、看房间开放状态、找空闲实验室；也可以直接交办事务：报修、临时停用、站内通知、值班收尾、运营日报
            （连接原系统后，按实际账号权限办理；未连接时为沙盒演示）。
            连接账号后可在消息中比较调课、补全检查、处理工单、发布通知并回查；在室人数按原系统当日有效签到−有效签退给出，
            钥匙台账和预约尚未接入。历史会话在左侧导航找回。
          </p>
        </template>
        <template v-else>
          <h1 class="hero__h">随便聊聊</h1>
          <p class="hero__p">
            聊天模式可以查询课表、状态与操作说明；办理事务请切回「任务」模式。
          </p>
          <CommandBar
            v-model:draft="draft"
            variant="hero"
            :submitting="submitting"
            :examples="false"
            placeholder="随便说点什么，例如：实验室值班要注意哪些事？"
            submit-label="发送"
            @submit="onSubmit"
            @cancel="onCancel"
          />
          <p class="hero__scope">
            聊天模式可以查询真实数据并保存聊天；办理业务请切换「任务」模式并人工确认。
          </p>
        </template>
      </div>

      <!-- 连续消息流 -->
      <template v-else>
        <header class="chat__head">
          <button type="button" class="chat__navtoggle" @click="navOpen = !navOpen">会话</button>
          <h1 class="chat__title">{{ currentTitle }}</h1>
          <span class="chat__count">{{ session.currentMessages.length }} 条消息</span>
          <!-- 模式一旦确定就只读展示：不再提供会话内切换入口 -->
          <span class="chat__mode" :class="`chat__mode--${convMode}`" :title="modeLockTip" :aria-label="modeLockTip">
            {{ modeLabel(convMode) }} · 模式已确定
          </span>
        </header>
        <p v-if="session.currentMessagesError" class="chat__err" role="alert">{{ session.currentMessagesError }}</p>

        <div ref="msgsEl" class="chat__msgs">
          <div v-for="(r, i) in rounds" :key="r.key" class="round" :data-round="i + 1">
            <RoundToolbar
              :index="i + 1"
              :can-rewind="convMode === 'task'"
              :busy="store.inputLocked"
              :actionable="Boolean(r.userMessage)"
              @remove="onDeleteRound(r)"
              @rollback="openRoundDialog('rollback', r)"
              @edit="openRoundDialog('edit', r)"
            />
            <ChatMessage v-for="m in r.messages" :key="m.id" :msg="m" @retry="onRetry(m)" @decided="loadTasks" />
          </div>
        </div>

        <div class="chat__composer">
          <CommandBar
            v-model:draft="draft"
            variant="dock"
            :submitting="submitting"
            :examples="convMode === 'task'"
            :placeholder="convMode === 'chat' ? '随便说点什么（聊天模式不能执行任务操作）' : undefined"
            :submit-label="convMode === 'chat' ? '发送' : undefined"
            @submit="onSubmit"
            @cancel="onCancel"
          />
        </div>
      </template>
    </main>

    <!-- 右侧：房间清单（停靠式侧边栏，可收起为窄轨） -->
    <aside class="side" :class="{ 'side--collapsed': !roomsOpen }" aria-label="实验室房间">
      <template v-if="roomsOpen">
        <header class="side__head">
          <h2 class="side__h">实验室房间</h2>
          <button
            type="button"
            class="side__toggle"
            title="收起房间清单"
            aria-label="收起房间清单"
            @click="toggleRooms(false)"
          >
            »
          </button>
        </header>
        <LabMatrix @ask="onPickRoom" />
      </template>
      <template v-else>
        <button
          type="button"
          class="side__expand"
          title="展开房间清单"
          aria-label="展开房间侧边栏"
          @click="toggleRooms(true)"
        >
          «
        </button>
        <button type="button" class="side__rail-label" @click="toggleRooms(true)">房间清单</button>
      </template>
    </aside>

    <!-- 回档 / 修改：原理相同（截断到本轮发起前），共用一个弹窗 -->
    <RoundActionDialog
      :open="roundDialog.open"
      :kind="roundDialog.kind"
      :round-index="roundDialog.index"
      :question="roundDialog.question"
      :busy="roundDialogBusy"
      :error="roundDialogError"
      :has-business-writes="roundDialog.business"
      @cancel="closeRoundDialog"
      @confirm="onConfirmRoundDialog"
    />
  </div>
</template>

<style scoped>
/* 布局：占满视口宽度（两侧留白最小化），中间对话区拿到全部剩余空间 */
.app {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) auto;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-2) 0;
  min-height: var(--app-height,100dvh);
}

.workspace-tools{display:flex;align-items:center;flex-wrap:wrap;gap:4px;flex-shrink:0;padding:4px 10px;border-bottom:1px solid var(--border)}
.workspace-tools :deep(.native-work-entry),.workspace-tools :deep(.jobs-entry),.workspace-tools :deep(.evidence-entry){padding:2px;border:0;font-size:12px}
.workspace-tools :deep(button){font-size:12px;padding:6px 8px}
@media(max-width:600px){.workspace-tools :deep(.native-work-entry span),.workspace-tools :deep(.jobs-entry span){display:none}}
/* 业务工具（已移入左侧栏）：去掉原有的整宽横排内边距，改为与侧栏一致的竖排按钮 */
.nav__tools{display:flex;flex-direction:column;gap:6px}
.nav__tools :deep(.jobs-entry),.nav__tools :deep(.evidence-entry){display:block;padding:0;border:0;font-size:12px}
.nav__tools :deep(.jobs-entry span){display:block;margin-top:4px;font-size:11px;color:var(--text-dim)}
.nav__tools :deep(button){width:100%;text-align:left;padding:8px 10px;border-radius:8px;font-size:12px}
/* ---- 左侧导航 ---- */
.nav {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4) var(--sp-3);
  position: sticky;
  top: var(--sp-4);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}
.nav__brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 15px;
}
.nav__mark {
  color: var(--primary);
  font-size: 18px;
}
.nav__new {
  border: 1px solid var(--primary);
  background: var(--primary);
  color: var(--primary-contrast);
  border-radius: var(--radius);
  padding: 8px 0;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.nav__new:hover {
  background: var(--primary-hover);
}
.nav__section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  /* 任务中心加入后内容变多：section 保持自然高度，由 nav 整体滚动，
     避免被 flex 压缩后内容溢出叠画（视觉重叠 bug） */
  flex-shrink: 0;
}
.nav__h {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  letter-spacing: 0.05em;
  display: flex;
  align-items: center;
  gap: 4px;
}
/* 分区标题本身是折叠开关：点标题折/展，符合侧栏区块的通用预期 */
.nav__fold {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  letter-spacing: inherit;
  padding: 2px 0;
  cursor: pointer;
  text-align: left;
}
.nav__fold:hover {
  color: var(--text-muted);
}
.nav__chev {
  font-size: 9px;
  width: 9px;
}
.nav__count {
  font-size: 10px;
  color: var(--text-faint);
  background: var(--surface-2);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 15px;
}
.nav__add {
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  cursor: pointer;
}
.nav__add:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary);
}
.nav__add:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.nav__hint,
.nav__err {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.nav__err {
  color: var(--danger);
}
.nav__convs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nav__convs li {
  display: flex;
  align-items: stretch;
  gap: 2px;
}
.conv {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 6px var(--sp-2);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.conv:hover {
  background: var(--surface-2);
}
.conv--on {
  background: var(--surface-3);
  border-color: var(--border-strong);
}
.conv__title {
  width: 100%;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv__time {
  font-size: 11px;
  color: var(--text-faint);
}
.conv__del {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
  padding: 0 4px;
}
.conv__del:hover {
  color: var(--danger);
}
.nav__foot {
  margin-top: auto;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  border-top: 1px solid var(--border);
  padding-top: var(--sp-3);
}
.nav__theme,
.nav__actor {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  align-self: flex-start;
}
.theme__btn {
  border: none;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
}
.theme__btn--on {
  background: var(--primary);
  color: var(--primary-contrast);
}
.nav__mask {
  display: none;
}

/* ---- 主区 ---- */
.chat {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
  min-height: 60vh;
  /* 会话显示区最大宽度：超宽屏上给两侧留白（导航侧与房间侧各让一点），
     一行文字过长会显著降低可读性，卡片也会被拉成难读的横条 */
  width: 100%;
  max-width: var(--chat-max, 1040px);
  margin-inline: auto;
}
/* 会话视图：列高锁定视口（顶部留出 app 的 padding-top），
   消息区内部滚动，composer 恒在视口底部（不随内容下移） */
.chat--conv {
  height: calc(var(--app-height,100dvh) - var(--sp-4));
  min-height: 0;
}
.hero {
  text-align: center;
  padding: clamp(24px, 14vh, 120px) var(--sp-2) 0;
}
.hero__h {
  margin: 0 0 var(--sp-2);
  font-size: clamp(22px, 3.4vw, 30px);
}
.hero__p {
  margin: 0 auto var(--sp-5);
  max-width: 560px;
  color: var(--text-muted);
  font-size: 14px;
}
.hero__navtoggle {
  margin-bottom: var(--sp-4);
}
.hero__scope {
  margin: var(--sp-4) auto 0;
  max-width: 620px;
  font-size: 12px;
  color: var(--text-faint);
}
.chat__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--border);
}
.chat__navtoggle {
  display: none;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12px;
  border-radius: var(--radius-sm);
  padding: 3px 10px;
  cursor: pointer;
}
.chat__title {
  margin: 0;
  font-size: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat__count {
  font-size: 12px;
  color: var(--text-faint);
  flex: 0 0 auto;
}
/* 已确定的会话模式：只读徽标（不是开关，所以不做成按钮外观） */
.chat__mode {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 10px;
  cursor: help;
  white-space: nowrap;
}
.chat__mode--chat {
  color: var(--info, var(--primary));
  border-color: currentColor;
}
.chat__err {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
/* 消息区独立滚动：输入栏在布局内，不悬浮遮挡内容（F26） */
.chat__msgs {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-2) 2px var(--sp-4);
  min-height: 0;
}
/* 轮次容器：一轮 = 一条提问 + 其回答；操作条默认隐形，hover/聚焦浮现。
   触摸设备没有 hover —— 常显（否则功能等于不存在）。 */
.round {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.round .roundtool {
  opacity: 0;
  transition: opacity 0.12s ease-out;
}
.round:hover .roundtool,
.round:focus-within .roundtool {
  opacity: 1;
}
@media (hover: none) {
  .round .roundtool {
    opacity: 1;
  }
}
.chat__notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  border: 1px solid var(--border-strong);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: var(--sp-2) var(--sp-3);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
}
.chat__notice--ok {
  border-left-color: var(--primary);
}
.chat__notice--warn {
  border-left-color: var(--warning, #b8860b);
}
.chat__notice--danger {
  border-left-color: var(--danger);
  color: var(--danger);
}
.chat__noticelist {
  margin: 0;
  padding-left: 16px;
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.chat__noticedismiss {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
  flex: 0 0 auto;
}
.chat__composer {
  border-top: 1px solid var(--border);
  padding-top: var(--sp-3);
  padding-bottom: env(safe-area-inset-bottom);
  flex: 0 0 auto;
}

/* ---- 模式切换（聊天 / 任务）---- */
.mode-seg {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  overflow: hidden;
  background: var(--surface-2);
}
.mode-seg__btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  padding: 4px 14px;
  cursor: pointer;
}
.mode-seg__btn:hover {
  color: var(--text);
}
.mode-seg__btn--on {
  background: var(--primary);
  color: var(--primary-contrast);
  font-weight: 600;
}
.mode-seg--hero {
  margin-bottom: var(--sp-4);
}

/* ---- 右侧房间清单：停靠式侧边栏（可收起为窄轨） ---- */
.side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: 300px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4) var(--sp-3);
  position: sticky;
  top: var(--sp-4);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  min-width: 0;
  align-self: start;
  transition: width 0.18s ease-out;
  overflow-x: hidden;
}
.side--collapsed {
  width: 44px;
  padding: var(--sp-3) 4px;
  align-items: center;
  overflow-y: hidden;
}
.side__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.side__h {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.side__toggle,
.side__expand {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 13px;
  border-radius: var(--radius-sm);
  width: 24px;
  height: 22px;
  line-height: 1;
  cursor: pointer;
  flex: 0 0 auto;
}
.side__toggle:hover,
.side__expand:hover {
  color: var(--text);
  background: var(--surface-3);
}
.side__expand {
  width: 28px;
  height: 26px;
  font-size: 14px;
}
.side__rail-label {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
  letter-spacing: 0.2em;
  writing-mode: vertical-rl;
  padding: var(--sp-2) 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.side__rail-label:hover {
  color: var(--text);
  background: var(--surface-2);
}

@media (max-width: 900px) {
  .app {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--sp-2);
  }
  .nav {
    position: fixed;
    inset: 0 auto 0 0;
    width: min(320px, 86vw);
    z-index: 20;
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
    transform: translateX(-102%);
    transition: transform 0.18s ease-out;
    max-height: none;
  }
  .nav--open {
    transform: translateX(0);
  }
  .nav--open + .nav__mask {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 10;
  }
  .chat__navtoggle {
    display: inline-block;
  }
  /* 房间侧边栏：窄屏收起时为右侧窄轨，展开时为抽屉 */
  .side {
    position: fixed;
    inset: 0 0 0 auto;
    width: min(320px, 86vw);
    z-index: 20;
    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
    max-height: none;
    transition: transform 0.18s ease-out;
  }
  .side--collapsed {
    width: 44px;
    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
  }
  /* 收起轨道是有意悬浮的控件：正文给右侧让出等宽，避免文字被盖住 */
  .app--railclosed .chat,
  .app--railclosed .hero {
    padding-right: 52px;
  }
  .hero {
    padding-top: 8vh;
  }
}
</style>
