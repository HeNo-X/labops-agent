<script setup lang="ts">
import {clientFetch} from './client';

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
import {auth,bootstrapAuth as sharedBootstrap,switchEdition,clearAuth} from './auth/bootstrap';
import Targets from '@shared/labops-targets.js';
import {useEvidenceUpload} from './stores/evidence-upload';
import {useVisibleRefresh} from './composables/useVisibleRefresh';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRunStore } from './stores/run';
import { useSessionStore } from './stores/session';
import { usePendingInputStore } from './stores/pending-input';
import { resolvePendingOnTerminal, resolvePendingOnSwitchAway, mergeDraft } from './lib/pending-input';
import { fetchRunSnapshot, snapshotMs, messageStatusOf, isConverged } from './lib/run-snapshot';
import type { RunSnapshot } from '@shared/types';
import type { ChatMessage as ChatMessageData, Round, RoundEffects } from './stores/session';
import { useAgentStream } from './composables/useAgentStream';
import LabMatrix from './components/LabMatrix.vue';
import AgentSidebar from './components/AgentSidebar.vue';
import PlanPane from './components/PlanPane.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import {preferences} from './preferences';
import {t as tr} from './i18n';
import CommandBar from './components/CommandBar.vue';
import CommandPalette from './components/CommandPalette.vue';
import { requestSidebarSearchFocus } from './lib/sidebar-focus';
import ChatMessage from './components/ChatMessage.vue';
import RoundToolbar from './components/RoundToolbar.vue';
import RoundActionDialog from './components/RoundActionDialog.vue';
import {useBusinessStore} from './stores/business';
import LoginView from './components/LoginView.vue';
import { actorHeaders, actorRole, setActorRole } from './actor';
import type { ActorRole } from './actor';
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
  if(!business.connected||!authed.value){store.clearOverview();session.clearPrivate();return;}
  void store.loadOverview();
  if(store.runStatus!=='running'){
    store.resetRun();
    session.messages={};
    if(session.currentId)void session.openConversation(session.currentId);
  }
});
const authMode = ref<'native'|'demo'>('native');
const authed = ref(false), authLoading = ref(true), authError = ref(''),workspaceReady=ref(false);
async function loadWorkspace(conversationId?:string):Promise<void>{
  workspaceReady.value=false;
  await business.refresh();
  if(authMode.value==='native'&&business.profile)actor.value=business.profile.identity as ActorRole;
  await Promise.all([store.loadOverview(),loadTasks(),session.loadConversations()]);
  await session.loadCurrentId();
  const id=conversationId||session.currentId;
  if(id&&session.conversations.some(c=>c.id===id))await session.openConversation(id);
  else session.startDraft();
  workspaceReady.value=true;
}
watch(()=>session.currentId,id=>{if(!authed.value||!workspaceReady.value)return;if(!id&&auth.target.value.view!=='conversation')return;const target=id?{view:'conversation',conversationId:id}:{view:'home'};auth.target.value=target;history.replaceState(history.state,'','/index.html?'+Targets.search(target));});
async function bootstrapAuth(force=false):Promise<void>{
  await sharedBootstrap(force);authMode.value=auth.mode.value;authLoading.value=auth.loading.value;authError.value=auth.error.value;authed.value=auth.authenticated.value;
  if(authed.value){const target=auth.target.value;await loadWorkspace(target.conversationId);await nextTick();if(target.jobId||target.view==='automation')window.dispatchEvent(new CustomEvent('labops-target',{detail:target}));else if(target.view==='settings')settingsOpen.value=true;else if(target.roomId||target.taskId)window.dispatchEvent(new CustomEvent('labops-target',{detail:target}));}
}
useVisibleRefresh(async()=>{await session.loadConversations();if(session.currentId)await session.syncConversation(session.currentId);},()=>authed.value&&store.runStatus!=='running');
async function onLogin(account: string):Promise<void>{
  sessionStorage.removeItem('labops.manual-logout');sessionStorage.setItem('labops.auth',account);
  if(authMode.value==='demo'){authed.value=true;await loadWorkspace();}
  else await bootstrapAuth(true);
}
async function logout():Promise<void>{
  sessionStorage.setItem('labops.manual-logout','1');activeToken='';cancel();session.clearPrivate();useEvidenceUpload().clearPrivate();business.clearPrivate();tasks.value=[];store.resetRun();store.clearOverview();for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith('labops.native-draft:'))localStorage.removeItem(key);}clearAuth();await clientFetch('/api/auth/logout',{method:'POST'}).catch(()=>undefined);
  sessionStorage.removeItem('labops.auth');session.messages={};session.conversations=[];session.startDraft();store.resetRun();authed.value=false;
}
const { start, cancel } = useAgentStream();

const draft = ref(session.draftFor('__new'));
// N21：草稿按会话保存；切回会话时恢复
watch(
  () => session.currentId,
  (id) => {
    draft.value = id ? session.draftFor(id) : session.draftFor('__new');
  }
);
watch(draft, (t) => session.saveDraft(session.currentId ?? '__new', t));

// ---- 运行中待发送（T3）：单条、按会话隔离；只是暂存意图，不构成第二条并发流 ----
const pendingInput = usePendingInputStore();
/** 一次性提示（草稿冲突填回等），几秒后自动消失 */
const pendingNotice = ref<string | null>(null);
let pendingNoticeTimer: number | null = null;
function flashPendingNotice(msg: string): void {
  pendingNotice.value = msg;
  if (pendingNoticeTimer !== null) window.clearTimeout(pendingNoticeTimer);
  pendingNoticeTimer = window.setTimeout(() => (pendingNotice.value = null), 6000);
}
/** 只有属于当前会话的待发送才在输入区显示 */
const pendingTextForCurrent = computed(() =>
  pendingInput.pending && pendingInput.pending.conversationId === session.currentId ? pendingInput.pending.text : null
);

function onQueueInput(q: string): void {
  const convId = session.currentId;
  if (!convId) return;
  pendingInput.enqueue(convId, session.currentMode(), q);
}
function onCancelPending(): void {
  pendingInput.clear();
  pendingNotice.value = null;
}
/**
 * 本轮进入终态后的消费时机（与 finishRun 同一处）：草稿为空才自动发出；
 * 草稿已有内容就填回草稿让用户确认 —— 不覆盖、不猜测。
 */
function consumePendingOnTerminal(convId: string | null): void {
  const cur = pendingInput.pending;
  if (!cur || !convId || cur.conversationId !== convId) return;
  // 用户已经切走：不把待发送偷偷发回原会话，折回该会话自己的草稿，切回去还能看到
  const folded = resolvePendingOnSwitchAway({ pending: cur, activeConversationId: session.currentId });
  if (folded.action === 'fold_to_draft') {
    const taken = pendingInput.takeFor(folded.conversationId);
    if (taken) session.saveDraft(folded.conversationId, mergeDraft(session.draftFor(folded.conversationId), taken.text));
    return;
  }
  const outcome = resolvePendingOnTerminal({
    pending: pendingInput.pending,
    conversationId: convId,
    running: store.inputLocked,
    draft: draft.value
  });
  if (outcome.action === 'none') return;
  const taken = pendingInput.takeFor(convId);
  if (!taken) return;
  if (outcome.action === 'send') {
    void onSubmit(outcome.text);
    return;
  }
  // refill：不发送，把文本交给用户确认（保留其原有草稿）
  draft.value = mergeDraft(draft.value, outcome.text);
  flashPendingNotice('待发送已填回输入框，请确认后发送');
}
const msgsEl = ref<HTMLElement | null>(null);
const nearBottom=ref(true),newMessages=ref(false);
function trackScroll(){const el=msgsEl.value;if(el){nearBottom.value=el.scrollHeight-el.scrollTop-el.clientHeight<100;if(nearBottom.value)newMessages.value=false;}}
function showLatest(){nearBottom.value=true;newMessages.value=false;scrollFollow();}

const navOpen = ref(false);
/** 右侧房间侧边栏：宽屏默认展开，窄屏默认收起；用户选择持久化（停靠式，可收起为窄轨） */
const roomsOpen = ref(window.innerWidth >= 1280);
// PC-2 右栏视图互斥：'rooms'=房间清单（默认），'plan'=办理单钉住面板
const sideView = ref<'rooms' | 'plan'>('rooms');
watch(sideView, (v) => {
  if (v === 'plan' && !roomsOpen.value) toggleRooms(true);
});
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
// T5：切回前台且该轮长时间无新事件 → 主动回查快照（不静默停在假"运行中"）
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange));
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (recoverPollTimer !== null) window.clearTimeout(recoverPollTimer);
});

// ---- 命令面板（T7）：Ctrl/Cmd+K 的唯一监听者在其自身组件内 ----
/**
 * 命令面板的命令集**全部复用既有入口**：
 * 视觉 / 自动化 / 工作台都走既有的 window 'labops-target' 事件通道（App 内部本来
 * 就用它打开这些面板），不新增任何一套开关机制。
 */
const commandContext = computed(() => ({
  busy: store.inputLocked || Boolean(submitting.value),
  focusSidebarSearch: () => requestSidebarSearchFocus(),
  newChat: (mode?: ConvMode) => onNewChat(mode),
  openOperations: () => window.open('/operations.html?bridge=1', '_blank', 'noopener'),
  openVision: () => window.dispatchEvent(new CustomEvent('labops-target', { detail: { view: 'vision' } })),
  openAutomation: () => window.dispatchEvent(new CustomEvent('labops-target', { detail: { view: 'automation' } })),
  openSettings: () => (settingsOpen.value = true),
  stopRun: () => void onCancel(),
  actorRole: actor.value,
  actorOptions: authMode.value === 'demo'
    ? [{ role: 'admin', label: '管理员' }, { role: 'volunteer', label: '志愿者' }, { role: 'student', label: '学生' }]
    : [],
  switchActor: (role: string) => switchRole(role as ActorRole),
  recentSessions: session.conversations.slice(0, 3).map((c) => ({ id: c.id, title: c.title })),
  openSession: (id: string) => {
    void session.openConversation(id);
    navOpen.value = false;
  }
}));

// ---- 会话类型（聊天 / 任务）----
// hero（还没有会话）用 draftMode 选择；**会话一旦开始对话，模式即确定**：
// 2026-10-06 用户要求 —— 会话内部不再提供切换入口，服务端同样以 409 拒绝改模式，
// 否则同一条历史会在"只查询"和"可办理"两种语义之间漂移。
type ConvMode = 'chat' | 'task';
const draftMode = ref<ConvMode>(preferences.value.defaultMode);
watch(()=>preferences.value.defaultMode,value=>{if(!session.currentId)draftMode.value=value;});
const convMode = computed<ConvMode>(() => session.currentMode());
const modeLabel = (m: ConvMode): string => (m === 'chat' ? '聊天会话' : '工作会话');
const modeLockTip = computed(
  () => `本会话已确定为${modeLabel(convMode.value)}：${convMode.value === 'chat' ? '只查询数据，不准备办理单' : '可查询、可准备办理单并执行'}。开始对话后模式不可更改，需要另一种模式请新建会话。`
);

/** 活跃轮的助手占位消息（直接写入会话消息数组，流式更新同一对象） */


const settingsOpen=ref(false);
function closeSettings(){settingsOpen.value=false;void nextTick(()=>document.querySelector<HTMLButtonElement>('.sidebar-account')?.focus());}
onMounted(()=>{void bootstrapAuth();});

// ---- ops.v1：任务中心 + 沙盒演示身份（仅沙盒可切换视角，服务端校验）----
const tasks = ref<TaskRow[]>([]);
const tasksError = ref<string | null>(null);
const actor = ref<ActorRole>(actorRole());

async function loadTasks(): Promise<void> {
  const owner=business.scopeKey;try {
    const res = await clientFetch('/api/tasks', { headers: actorHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { tasks: TaskRow[] };
    if(owner!==business.scopeKey||!authed.value)return;tasks.value = j.tasks ?? [];
    tasksError.value = null;
  } catch (e) {
    if(owner===business.scopeKey&&authed.value)tasksError.value = `任务列表载入失败：${(e as Error).message}`;
  }
}

function switchRole(r: ActorRole): void {
  if(store.runStatus==='running'||r===actor.value)return;
  setActorRole(r);
  session.startDraft();
  session.clearPrivate();
  store.resetRun();
  void business.refresh();
  actor.value = r;
  void session.loadConversations();
  void store.loadOverview();
  void loadTasks();
}

/** PC-2：右栏办理单"查看会话位置" → 滚动到对应消息并短暂高亮 */
function locateMessage(messageId: string): void {
  if (!messageId) return;
  const el = msgsEl.value?.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`) ?? msgsEl.value?.querySelector('.msg--assistant:last-of-type');
  if (el instanceof HTMLElement) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('is-located');
    window.setTimeout(() => el.classList.remove('is-located'), 1800);
  }
}
/** PC-2：待确认方案到达（0→≥1）→ 右栏自动钉住为办理单视图 */
function onPlanArrived(messageId: string): void {
  if (window.innerWidth > 900) sideView.value = 'plan';
  if (messageId) locateMessage(messageId);
}

function openTask(conversationId: string | null): void {
  if (conversationId && session.conversations.some((c) => c.id === conversationId)) {
    void session.openConversation(conversationId);
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
  if(nearBottom.value)el.scrollTop = el.scrollHeight;else newMessages.value=true;
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
    // 耗时优先用服务端权威值（run_completed.payload.ms）；拿不到时才退回本次实测跨度
    live.ms = store.serverMs ?? store.elapsedMs;
    live.model = store.model;
  }
);
watch(
  () => session.currentMessages.length + store.stream.length,
  async () => {
    if (!liveConvId) return;
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

// ---- 断线回查（T5）：把"请手工回查"升级为"按运行编号收敛到真实终态" ----
/** 回查提示（细线一行）：恢复中 / 已补齐 / 仍在服务端运行 —— 必须让用户看到发生了什么 */
const recoverNotice = ref<string | null>(null);
let recoverPollTimer: number | null = null;

/** 用快照整段替换活跃轮的展示（原子替换，不做局部 merge） */
function convergeFromSnapshot(snapshot: RunSnapshot): void {
  const ms = snapshotMs(snapshot);
  store.settleFromSnapshot(snapshot.terminal!, ms);
  const live = resolveLive();
  if (live) {
    live.text = snapshot.answerText;
    live.status = messageStatusOf(snapshot.terminal);
    live.toolCalls = snapshot.toolCalls as ChatMessageData['toolCalls'];
    live.engine = snapshot.engine;
    live.model = snapshot.model;
    live.sourceType = snapshot.sourceType;
    if (ms !== null) live.ms = ms;
    // A5：计划随快照回放（历史轮展示读消息 meta.plan；这里同步进 store 供活跃轮）
    live.plan = snapshot.plan ?? null;
    // 快照里的错误信息没有落库字段（如实缺省），不编造失败原因
    live.error = null;
  }
  recoverNotice.value = `已按运行编号 ${snapshot.runId} 回查并补齐`;
  liveConvId = null;
  liveMsgId = null;
}

/**
 * 断线/中断后的收敛流程：
 *   ① 有明确终态 → 原子替换为该终态；
 *   ② 仍在服务端运行 → 继续轮询（有上限），拿不到就如实告知，不猜成功；
 *   ③ 快照不可得（服务端重启等原因）→ 保留原诚实文案，绝不假装成功。
 */
async function recoverRunFromSnapshot(convId: string, runId: string, fallback: { code: string; message: string; hint?: string }, attempt = 0): Promise<void> {
  if (recoverPollTimer !== null) {
    window.clearTimeout(recoverPollTimer);
    recoverPollTimer = null;
  }
  if (attempt === 0) recoverNotice.value = `正在按运行编号 ${runId} 回查…`;
  const res = await fetchRunSnapshot(convId, runId);
  if (!res.ok) {
    recoverNotice.value = null;
    // 快照都拿不到：回到原诚实错误（保留内容，提示按编号回查），不静默
    store.failRun(fallback);
    return;
  }
  if (isConverged(res.snapshot)) {
    convergeFromSnapshot(res.snapshot);
    return;
  }
  // 仍在服务端运行：继续等（最多约 60 秒，每 3 秒一次）
  if (attempt < 20) {
    recoverNotice.value = `该轮仍在服务端执行，正在等待（运行编号 ${runId}）`;
    recoverPollTimer = window.setTimeout(() => {
      void recoverRunFromSnapshot(convId, runId, fallback, attempt + 1);
    }, 3000);
    return;
  }
  // 等不到终态：明确"未能确认结果"，仍给出编号供人工回查 —— 不得显示为成功
  recoverNotice.value = `未能确认运行 ${runId} 的结果，请稍后按编号回查本会话`;
  store.failRun({ code: 'stream_ended_early', message: fallback.message, hint: fallback.hint });
}

/** 前台恢复且长时间无新事件 → 主动回查一次（避免用户看到"永远在跑"的假状态） */
function checkForegroundStale(): void {
  if (store.runStatus !== 'running' || !store.runId || !liveConvId) return;
  const last = store.lastEventAt ?? 0;
  if (Date.now() - last < 5000) return;
  void recoverRunFromSnapshot(liveConvId, store.runId, {
    code: 'stream_ended_early',
    message: '连接中断或长时间无新事件。已尝试按运行编号回查。'
  });
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') checkForegroundStale();
}
async function onSubmit(q: string): Promise<void> {
  // N04：**同步**占用提交锁，覆盖"await 创建会话"的窗口 —— 快速双击/连按 Enter 只发一次
  // T3：运行中的提交由 CommandBar 转成"加入待发送"，走到这里的一律是真正的首轮提交，
  // 锁语义未放宽（并发互斥仍然只有一条 SSE 流）。
  if (submitting.value || store.inputLocked || !q.trim()) return;
  submitting.value = true;
  pendingNotice.value = null;
  navOpen.value = false;
  const clientRequestId = session.uid('req');
  let convId: string | null = session.currentId;
  try {
    // PC-4：首句语义路由 —— 办理动词升级为任务会话，否则聊天查询（与移动端一致）
    const opsHint = /(办理|提交|报修|停用|发布|通知|值班|排班|工单|申请)/.test(q);
    const mode: ConvMode = opsHint ? 'task' : 'chat';
    convId = await session.ensureConversation(q, convId, clientRequestId, mode);
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
      // T5：断流不再只丢一句"请手工回查" —— 先按运行编号取服务端快照收敛
      if (err.code === 'stream_ended_early' && store.runId) {
        void recoverRunFromSnapshot(convId, store.runId, err);
        return;
      }
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
      live.model = store.model;
      live.sourceType = store.sourceType;
      live.ms = store.serverMs ?? store.elapsedMs;
      live.error = store.error ? { ...store.error } : null;
    }
    liveConvId = null;
    liveMsgId = null;
    void session.loadConversations();
    void loadTasks();
    // T3：本轮已到终态 —— 消费属于该会话的待发送（自动发出 / 填回草稿）
    const finishedConv = convId;
    void nextTick(() => consumePendingOnTerminal(finishedConv));
  }
}

async function onCancel(): Promise<void> {
  // N06/R06：先送达取消请求（服务端记 cancelled），再断开本地流 —— 次序反了会被记成 interrupted
  if (session.currentId && store.runId) {
    try {
      await Promise.race([
        clientFetch(`/api/runs/${encodeURIComponent(store.runId)}/cancel`, { method: 'POST', headers: actorHeaders() }),
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
  draftMode.value = mode || preferences.value.defaultMode;
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

  <p v-if="authLoading" class="auth-status" role="status">{{tr("正在验证主系统登录状态…")}}</p>
  <template v-else-if="!authed"><p v-if="authError" class="auth-status" role="alert">{{authError}}</p><LoginView :mode="authMode" @done="onLogin" /></template>
  <div v-else-if="!workspaceReady" class="workspace-loading" role="status">{{tr("正在恢复本人工作区…")}}</div>
  <div v-else class="app" :class="{ 'app--railclosed': !roomsOpen }">
    <!-- 左侧导航 -->
    <AgentSidebar :open="navOpen" :task-mode="(session.currentId?convMode:draftMode)!=='chat'" :auth-mode="authMode" :actor="actor" :tasks="tasks"
      @new="onNewChat" @select="id=>{session.openConversation(id);navOpen=false}" @rename="onRename" @remove="onDelete"
      @task="openTask" @rooms="toggleRooms(!roomsOpen)" @actor="switchRole" @close="navOpen=false" @logout="logout"
      @settings="settingsOpen=true" />
    <SettingsDialog :open="settingsOpen" @close="closeSettings" @logout="settingsOpen=false;logout()" @edition="switchEdition('mobile',session.currentId?{view:'conversation',conversationId:session.currentId}:{view:'assistant'})"/>
    <!-- T7：命令面板挂在根级，快捷键入口只有它自己一个 -->
    <CommandPalette :context="commandContext" />
    <div v-if="navOpen" class="nav__mask" @click="navOpen = false"></div>

    <!-- 主区：会话（有消息时列高锁定视口，输入框固定在底部） -->
    <main class="chat" :class="{ 'chat--conv': session.currentId && session.currentMessages.length > 0 }">


      <!-- 轮次操作结果：回档/删除之后必须让用户看到真实后果（含撤不回来的写入）。
           放在 hero/会话两个分支之前 —— 回档到第一轮会让会话变空，那时更需要这条说明。 -->
      <div v-if="roundNotice" class="chat__notice" :class="`chat__notice--${roundNotice.tone}`" role="status">
        <ul class="chat__noticelist">
          <li v-for="(line, i) in roundNotice.lines" :key="i">{{ line }}</li>
        </ul>
        <button type="button" class="chat__noticedismiss" :aria-label="tr('关闭提示')" :title="tr('关闭')" @click="roundNotice = null">✕</button>
      </div>

      <!-- T5：断线回查状态（细线一行，只为让用户知道"系统在做什么"） -->
      <p v-if="recoverNotice" class="chat__recover" role="status">
        {{ recoverNotice }}
        <button type="button" class="chat__recoverdismiss" :aria-label="tr('关闭提示')" @click="recoverNotice = null">✕</button>
      </p>

      <!-- 空会话：欢迎页即输入（保持居中首屏形态） -->
      <div v-if="!session.currentId || session.currentMessages.length === 0" class="hero">
        <button type="button" class="chat__navtoggle hero__navtoggle" @click="navOpen = !navOpen">{{tr("会话")}}</button>

        <!-- PC-4：去掉前置模式二选一 —— 与移动端同语义：开口即问。
             首句含"办理/提交/停用/通知/报修"等办理动词 → 任务会话；其余 → 聊天查询。
             任务能力并未藏起来：侧栏"新会话"仍可显式选模式，办理动词也会自动升级。 -->
        <h1 class="hero__h">{{tr("交代一件实验室任务")}}</h1>

        <CommandBar
          v-model:draft="draft"
          variant="hero"
          :submitting="submitting"
          :examples="true"
          :placeholder="tr('例如：E310 今天有哪些课？ / 帮我提交 D526 报修…')"
          :pending-text="pendingTextForCurrent"
          :pending-replaced="pendingInput.replaced"
          :notice="pendingNotice"
          @submit="onSubmit"
          @queue="onQueueInput"
          @cancel="onCancel"
          @cancel-pending="onCancelPending"
        />
        <p class="hero__scope">
          {{tr("提问与查询直接开始；要生成办理单时会自动进入任务会话。")}}
        </p>
      </div>

      <!-- 连续消息流 -->
      <template v-else>
        <header class="chat__head">
          <button type="button" class="chat__navtoggle" @click="navOpen = !navOpen">{{tr("会话")}}</button>
          <h1 class="chat__title">{{ currentTitle }}</h1>
          <span class="chat__count">{{ session.currentMessages.length }} {{tr("条消息")}}</span>
          <!-- 模式一旦确定就只读展示：不再提供会话内切换入口 -->
          <span class="chat__mode" :class="`chat__mode--${convMode}`" :title="modeLockTip" :aria-label="modeLockTip">
            {{ modeLabel(convMode) }}
          </span>
        </header>
        <p v-if="session.currentMessagesError" class="chat__err" role="alert">{{ session.currentMessagesError }}</p>

        <div ref="msgsEl" @scroll.passive="trackScroll" class="chat__msgs">
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

        <button v-if="newMessages" class="desktop-new-messages" @click="showLatest">{{tr("查看新消息")}}</button>
        <div class="chat__composer">
          <CommandBar
            v-model:draft="draft"
            variant="dock"
            :submitting="submitting"
            :examples="false"
            :placeholder="convMode === 'chat' ? '查询课表、房间、钥匙或实验室操作说明' : undefined"
            :submit-label="convMode === 'chat' ? '发送' : undefined"
            :pending-text="pendingTextForCurrent"
            :pending-replaced="pendingInput.replaced"
            :notice="pendingNotice"
            @submit="onSubmit"
            @queue="onQueueInput"
            @cancel="onCancel"
            @cancel-pending="onCancelPending"
          />
        </div>
      </template>
    </main>

    <!-- 右侧：房间清单 / 办理单（PC-2 互斥共用同一停靠轨道） -->
    <aside class="side" :class="{ 'side--collapsed': !roomsOpen }" :aria-label="tr(sideView === 'plan' ? '办理单' : '实验室房间')">
      <template v-if="roomsOpen">
        <header class="side__head">
          <div class="side__tabs" role="tablist" :aria-label="tr('右栏视图')">
            <button type="button" role="tab" :aria-selected="sideView === 'rooms'" :class="{ 'is-on': sideView === 'rooms' }" @click="sideView = 'rooms'">{{tr("房间")}}</button>
            <button type="button" role="tab" :aria-selected="sideView === 'plan'" :class="{ 'is-on': sideView === 'plan' }" @click="sideView = 'plan'">{{tr("办理单")}}</button>
          </div>
          <button
            type="button"
            class="side__toggle"
            :title="tr('收起右栏')"
            :aria-label="tr('收起右栏')"
            @click="toggleRooms(false)"
          >
            »
          </button>
        </header>
        <LabMatrix v-if="sideView === 'rooms'" @ask="onPickRoom" />
        <PlanPane v-else @locate="locateMessage" @plan-arrived="onPlanArrived" />
      </template>
      <template v-else>
        <button
          type="button"
          class="side__expand"
          :title="tr('展开房间清单')"
          :aria-label="tr('展开房间侧边栏')"
          @click="toggleRooms(true)"
        >
          «
        </button>
        <button type="button" class="side__rail-label" @click="toggleRooms(true)">{{tr("房间清单")}}</button>
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
.workspace-loading{display:grid;place-items:center;height:var(--app-height,100dvh);font-size:calc(var(--ui-font-size) * 0.92308);color:var(--text-muted)}
/* 布局：占满视口宽度（两侧留白最小化），中间对话区拿到全部剩余空间 */
.app {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0;
  padding: 8px 0;
  height: var(--app-height,100dvh);
  min-height: 0;
  overflow: hidden;
}

.nav__mask{display:none}
@media(max-width:900px){.nav__mask{display:block;position:fixed;inset:0;background:#0005;z-index:30}}
/* PC-2：右栏 tab 组与"定位高亮" */
.side__tabs{display:inline-flex;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.side__tabs button{border:0;background:var(--surface-2);color:var(--text-muted);font-size:calc(var(--ui-font-size) * 0.84615);padding:3px 12px;cursor:pointer}
.side__tabs button.is-on{background:var(--primary);color:var(--primary-contrast)}
.chat__msgs .msg.is-located{outline:2px solid var(--primary);outline-offset:4px;border-radius:8px;transition:outline-color .3s}
/* PC-3 微动效：卡片 hover 提亮 + 微浮（仅真 hover 设备，触屏自动禁用） */
@media (hover: hover) {
  .chat__msgs .native-card:hover,
  .chat__msgs .res:hover {
    background: var(--surface-2);
    transform: translateY(-1px);
    transition: background 0.12s ease-out, transform 0.12s ease-out;
  }
}
/* PC-3 弹层开关淡入缩放 */
.sidebar-account-menu,
.sidebar-row-menu {
  animation: pc-pop 0.16s ease-out;
}
@keyframes pc-pop {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-account-menu,
  .sidebar-row-menu {
    animation: none;
  }
}

/* ---- 主区 ---- */
.chat {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: 8px 20px;
  isolation: isolate;
  position: relative;
  z-index: 0;
  /* 会话显示区最大宽度：超宽屏上给两侧留白（导航侧与房间侧各让一点），
     一行文字过长会显著降低可读性，卡片也会被拉成难读的横条 */
  width: 100%;
  max-width: var(--chat-max, 1040px);
  margin-inline: auto;
}
/* 会话视图：列高锁定视口（顶部留出 app 的 padding-top），
   消息区内部滚动，composer 恒在视口底部（不随内容下移） */
.chat--conv {
  height: 100%;
  min-height: 0;
}
.hero {
  text-align: center;
  padding: clamp(24px, 12vh, 100px) var(--sp-2) 0;
  overflow-y: auto;
  min-height: 0;
}
.hero__h {
  margin: 0 0 var(--sp-2);
  font-size: clamp(22px, 3.4vw, 30px);
}
.hero__p {
  margin: 0 auto var(--sp-5);
  max-width: 560px;
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 1.07692);
}
.hero__navtoggle {
  margin-bottom: var(--sp-4);
}
.hero__scope {
  margin: var(--sp-4) auto 0;
  max-width: 620px;
  font-size: calc(var(--ui-font-size) * 0.92308);
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
  font-size: calc(var(--ui-font-size) * 0.92308);
  border-radius: var(--radius-sm);
  padding: 3px 10px;
  cursor: pointer;
}
.chat__title {
  margin: 0;
  font-size: calc(var(--ui-font-size) * 1.23077);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat__count {
  font-size: calc(var(--ui-font-size) * 0.92308);
  color: var(--text-faint);
  flex: 0 0 auto;
}
/* 已确定的会话模式：只读徽标（不是开关，所以不做成按钮外观） */
.chat__mode {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: calc(var(--ui-font-size) * 0.84615);
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
  font-size: calc(var(--ui-font-size) * 0.92308);
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
/* PC-3 阅读宽度分级：正文文本列收窄（约中文 62 字/行，降低长答案阅读疲劳），
   结构化卡片/提案卡仍可占满 --chat-max（卡片需要宽度）。 */
/* 正文列：MarkdownText 渲染为 .safe-markdown（GPT 重构后的正文包装），
   历史遗留的 .msg__text 一并覆盖，双保险 */
/* :deep() —— safe-markdown 是 MarkdownText 子组件根，scoped 选择器须穿透才能命中 */
.chat__msgs :deep(.msg--assistant .safe-markdown),
.chat__msgs .msg__text,
.chat__msgs .msg__userbubble,
.chat__msgs .msg__pending,
.chat__msgs .msg__err {
  max-width: var(--chat-text-max, 880px);
  margin-inline: auto;
  width: 100%;
}
.chat__msgs .msg--user {
  align-items: center;
}
.chat__msgs .msg--assistant .msg__ahead {
  max-width: var(--chat-text-max, 880px);
  margin-inline: auto;
  width: 100%;
}
.chat__msgs .msg--assistant > *:not(.msg__text):not(.msg__ahead):not(.msg__pending):not(.msg__err) {
  /* 结果卡/提案卡/工具卡保持全宽 */
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
  font-size: calc(var(--ui-font-size) * 0.92308);
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
/* T5 断线回查状态行：一条细线，不抢正文注意力 */
.chat__recover {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding-left: var(--sp-2);
  border-left: 2px solid var(--border-strong);
  font-size: calc(var(--ui-font-size) * 0.88462);
  color: var(--text-faint);
}
.chat__recoverdismiss {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0 4px;
  font-size: inherit;
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
  font-size: calc(var(--ui-font-size) * 0.92308);
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
  font-size: calc(var(--ui-font-size) * 0.92308);
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
  max-height: 100%;
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
  font-size: calc(var(--ui-font-size) * 1.0);
  font-weight: 600;
  white-space: nowrap;
}
.side__toggle,
.side__expand {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: calc(var(--ui-font-size) * 1.0);
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
  font-size: calc(var(--ui-font-size) * 1.07692);
}
.side__rail-label {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: calc(var(--ui-font-size) * 0.92308);
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
