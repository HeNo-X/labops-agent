<script setup lang="ts">
/**
 * 会话工作台 —— 应用外壳（M2：左侧导航 + 连续消息流，F01/F23/F25）
 * ============================================================================
 *  · 左侧导航：新聊天 / 最近会话（真实持久化列表）/ 实验室房间（折叠区）/ 状态与主题
 *  · 中央：连续消息流（每轮追加，绝不覆盖上一轮），吸底输入栏独立于滚动区
 *  · 房间点击只回填草稿，不自动发请求（F29）；发送后草稿清空（F27）
 *  · 主题：跟随系统 = 显式解析 prefers-color-scheme 并实时响应（F28 已修，保持）
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRunStore } from './stores/run';
import { useSessionStore } from './stores/session';
import type { ChatMessage as ChatMessageData } from './stores/session';
import { useAgentStream } from './composables/useAgentStream';
import LabMatrix from './components/LabMatrix.vue';
import CommandBar from './components/CommandBar.vue';
import ChatMessage from './components/ChatMessage.vue';
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

const store = useRunStore();
const session = useSessionStore();
// 登录门面（本地演示模式）：会话内记住登录；不做真实身份校验（R26 边界不变）
const authed = ref(sessionStorage.getItem('labops.auth') !== null);
function onLogin(account: string): void {
  sessionStorage.setItem('labops.auth', account);
  authed.value = true;
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
  if (saved === 'open') roomsOpen.value = true;
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

// ---- 会话类型（聊天 / 任务）----
// hero（未创建会话）用 draftMode 选择；已创建的会话以服务端存储为准（session.convModes）
type ConvMode = 'chat' | 'task';
const draftMode = ref<ConvMode>('task');
const convMode = computed<ConvMode>(() => session.currentMode());
async function onSwitchMode(m: ConvMode): Promise<void> {
  if (!session.currentId || m === convMode.value) return;
  try {
    await session.setConversationMode(session.currentId, m);
  } catch (e) {
    window.alert(`切换模式失败：${(e as Error).message}`);
  }
}
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
  void store.loadOverview();
  void loadTasks();
  void session.loadCurrentId();
  void session.loadConversations().then(() => {
    if (session.currentId) void session.openConversation(session.currentId);
  });
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
  setActorRole(r);
  actor.value = r;
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
        fetch(`/api/runs/${encodeURIComponent(store.runId)}/cancel`, { method: 'POST' }),
        new Promise((r) => setTimeout(r, 800))
      ]);
    } catch {
      /* 取消请求失败也照样本地停止 */
    }
  }
  cancel();
}

function onNewChat(): void {
  if (store.inputLocked) return;
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

</script>

<template>
  <LoginView v-if="!authed" @done="onLogin" />
  <div v-else class="app" :class="{ 'app--railclosed': !roomsOpen }">
    <!-- 左侧导航 -->
    <aside class="nav" :class="{ 'nav--open': navOpen }" aria-label="会话导航">
      <div class="nav__brand">
        <span class="nav__mark" aria-hidden="true">▤</span>
        <b>启真 LabOps</b>
      </div>
      <button type="button" class="nav__new" @click="onNewChat">＋ 新聊天</button>

      <div class="nav__section">
        <h2 class="nav__h">最近会话</h2>
        <p v-if="session.listError" class="nav__err" role="alert">{{ session.listError }}</p>
        <p v-else-if="session.listLoading && !session.conversations.length" class="nav__hint">载入中…</p>
        <p v-else-if="!session.conversations.length" class="nav__hint">还没有会话，发第一条消息开始。</p>
        <ul v-else class="nav__convs">
          <li v-for="c in session.conversations" :key="c.id">
            <button
              type="button"
              class="conv"
              :class="{ 'conv--on': c.id === session.currentId }"
              :title="`${c.title}（${c.messageCount} 条消息${c.mode === 'chat' ? ' · 聊天' : ''}）`"
              @click="session.openConversation(c.id); navOpen = false"
            >
              <span class="conv__title">
                <span v-if="c.mode === 'chat'" class="conv__mode" title="聊天会话">聊</span>{{ c.title }}
              </span>
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
      </div>

      <div class="nav__section">
        <h2 class="nav__h">我的任务</h2>
        <p v-if="tasksError" class="nav__err" role="alert">{{ tasksError }}</p>
        <p v-else-if="!tasks.length" class="nav__hint">
          还没有业务任务。试试「E310 投影没有信号，帮我报修」「发布通知《…》」或「结束值班收尾」。
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

      <div class="nav__foot">
        <div class="nav__actor" role="group" aria-label="沙盒演示身份">
          <button
            v-for="r in (['admin', 'volunteer', 'student'] as ActorRole[])"
            :key="r"
            type="button"
            class="theme__btn"
            :class="{ 'theme__btn--on': actor === r }"
            :aria-pressed="actor === r"
            :title="`切换沙盒演示视角：${ACTOR_ROLE_LABELS[r]}（能力边界由服务端校验）`"
            @click="switchRole(r)"
          >
            {{ ACTOR_ROLE_LABELS[r].replace('演示', '') }}
          </button>
        </div>
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
      <!-- 空会话：欢迎页即输入（保持居中首屏形态） -->
      <div v-if="!session.currentId || session.currentMessages.length === 0" class="hero">
        <button type="button" class="chat__navtoggle hero__navtoggle" @click="navOpen = !navOpen">会话</button>

        <div class="mode-seg mode-seg--hero" role="group" aria-label="会话模式">
          <button
            type="button"
            class="mode-seg__btn"
            :class="{ 'mode-seg__btn--on': draftMode === 'chat' }"
            :aria-pressed="draftMode === 'chat'"
            title="纯聊天：不能执行任务操作、不能查询数据"
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
            （沙盒演示环境办理，业务单号与回执以提案卡为准）。
            在室人数、钥匙台账、排班换班、课表变更与用房预约尚未接入。历史会话在左侧导航找回。
          </p>
        </template>
        <template v-else>
          <h1 class="hero__h">随便聊聊</h1>
          <p class="hero__p">
            自由聊天模式：不能执行任务操作、不能查询具体数据；要交办任务请切回「任务」模式。
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
            聊天模式不调用工具、不产生业务单据；具体数据查询与业务办理请使用「任务」模式。
          </p>
        </template>
      </div>

      <!-- 连续消息流 -->
      <template v-else>
        <header class="chat__head">
          <button type="button" class="chat__navtoggle" @click="navOpen = !navOpen">会话</button>
          <h1 class="chat__title">{{ currentTitle }}</h1>
          <span class="chat__count">{{ session.currentMessages.length }} 条消息</span>
          <div class="mode-seg mode-seg--head" role="group" aria-label="切换会话模式">
            <button
              type="button"
              class="mode-seg__btn"
              :class="{ 'mode-seg__btn--on': convMode === 'chat' }"
              :aria-pressed="convMode === 'chat'"
              title="纯聊天：不能执行任务操作"
              @click="onSwitchMode('chat')"
            >
              聊天
            </button>
            <button
              type="button"
              class="mode-seg__btn"
              :class="{ 'mode-seg__btn--on': convMode === 'task' }"
              :aria-pressed="convMode === 'task'"
              title="任务工作台：查询数据、生成办理单并执行"
              @click="onSwitchMode('task')"
            >
              任务
            </button>
          </div>
        </header>
        <p v-if="session.currentMessagesError" class="chat__err" role="alert">{{ session.currentMessagesError }}</p>

        <div ref="msgsEl" class="chat__msgs">
          <ChatMessage v-for="m in session.currentMessages" :key="m.id" :msg="m" @retry="onRetry(m)" @decided="loadTasks" />
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
  </div>
</template>

<style scoped>
/* 布局：占满视口宽度（两侧留白最小化），中间对话区拿到全部剩余空间 */
.app {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) auto;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-2) 0;
  min-height: 100vh;
}

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
.conv__mode {
  display: inline-block;
  font-size: 10px;
  line-height: 1;
  color: var(--info, var(--primary));
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 1px 3px;
  margin-right: 4px;
  vertical-align: 1px;
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
}
/* 会话视图：列高锁定视口（顶部留出 app 的 padding-top），
   消息区内部滚动，composer 恒在视口底部（不随内容下移） */
.chat--conv {
  height: calc(100vh - var(--sp-4));
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
.chat__composer {
  border-top: 1px solid var(--border);
  padding-top: var(--sp-3);
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
.mode-seg--head {
  margin-left: auto;
  flex: 0 0 auto;
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
