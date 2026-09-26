<script setup lang="ts">
/**
 * Agent 工作台 —— 应用外壳
 * ============================================================================
 *  布局原则：**任务流是唯一主角**。
 *    · 空态  ：居中 hero ——「交代一件实验室任务」大输入框 + 示例（点击即发起）
 *              + 一行能力边界；房间清单收进侧栏。
 *    · 运行中：任务卡 = 指令气泡 → 步骤时间线 → 结论回答 → 结构化结果卡
 *              → 折叠的数据依据；输入退到吸底命令栏。
 *    · 侧栏  ：可搜索房间清单（紧凑行）+ 数据与引擎说明（折叠），桌面 sticky。
 *    · 手机  ：首屏只有 hero；侧栏折叠区放在任务内容之后，绝不挡任务。
 *  主题：跟随系统 prefers-color-scheme，并提供手动切换（深/浅）。
 */
import { onMounted, ref } from 'vue';
import { useRunStore } from './stores/run';
import { useAgentStream } from './composables/useAgentStream';
import LabMatrix from './components/LabMatrix.vue';
import CommandBar from './components/CommandBar.vue';
import RunTrace from './components/RunTrace.vue';
import TaskResult from './components/TaskResult.vue';
import ConfirmDock from './components/ConfirmDock.vue';
import SourceBadge from './components/SourceBadge.vue';
import StatusTag from './components/StatusTag.vue';

const store = useRunStore();
const { start, cancel } = useAgentStream();

type ThemeMode = 'auto' | 'light' | 'dark';
const themeMode = ref<ThemeMode>('auto');

function applyTheme(mode: ThemeMode): void {
  themeMode.value = mode;
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    localStorage.setItem('labops.theme', mode);
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略即可 */
  }
}

onMounted(() => {
  let saved: ThemeMode = 'auto';
  try {
    const v = localStorage.getItem('labops.theme');
    if (v === 'light' || v === 'dark' || v === 'auto') saved = v;
  } catch {
    /* 忽略 */
  }
  applyTheme(saved);
  void store.loadOverview();
});

function onSubmit(q: string): void {
  store.beginRun(q);
  void start({
    message: q,
    runId: store.runId ?? undefined,
    sessionId: store.sessionId ?? undefined,
    onEvent: (ev) => store.ingest(ev),
    onError: (err) => store.failRun(err),
    onClose: () => store.finishRun()
  });
}

function onCancel(): void {
  cancel();
}
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="top__brand">
        <span class="top__mark" aria-hidden="true">▤</span>
        <div>
          <h1 class="top__title">LabOps Agent · 实验室任务助手</h1>
          <p class="top__sub">用一句话交办实验室查询，Agent 查证后给结论。</p>
        </div>
      </div>

      <div class="top__right">
        <div class="top__badges">
          <SourceBadge :source-type="store.sourceType ?? store.overviewSourceType" :engine="store.activeEngine" compact />
          <button
            v-if="store.sessionId && store.runStatus !== 'running'"
            type="button"
            class="top__newbtn"
            title="清空会话承接与当前任务，开始全新会话"
            @click="store.newSession()"
          >
            新会话
          </button>
        </div>
        <div class="theme" role="group" aria-label="主题切换">
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
    </header>

    <p v-if="store.overviewError" class="top__warn" role="alert">
      <StatusTag tone="danger" label="概览不可用" />{{ store.overviewError }}
    </p>

    <main class="grid">
      <!-- 主区：任务流 -->
      <div class="col col--main">
        <!-- 空态 hero：任务入口即主角 -->
        <section v-if="store.runStatus === 'idle'" class="hero" aria-labelledby="hero-h">
          <h2 id="hero-h" class="hero__h">交代一件实验室任务</h2>
          <p class="hero__p">
            查课表、看房间开放状态、找空闲实验室。说清房间号与日期即可，例如「E310 2026-09-30 有哪些课？」。
          </p>
          <CommandBar variant="hero" @submit="onSubmit" @cancel="onCancel" />
          <p class="hero__scope">
            当前可查：课表 · 房间开放状态与容量 · 某天（某节次）的空闲房间。
            在室人数、值班、签到、钥匙与发布通知等能力尚未接入。
          </p>
        </section>

        <!-- 任务卡：指令 → 行动 → 结论 → 依据 -->
        <section v-else class="task" aria-label="当前任务">
          <div class="task__q">
            <span class="task__qlabel" aria-hidden="true">任务</span>
            <p class="task__qtext">{{ store.question }}</p>
            <StatusTag
              :tone="
                store.runStatus === 'running'
                  ? 'info'
                  : store.runStatus === 'failed'
                    ? 'danger'
                    : store.runStatus === 'cancelled'
                      ? 'neutral'
                      : 'ok'
              "
              :glyph="store.runStatus === 'running' ? '◌' : store.runStatus === 'failed' ? '✕' : store.runStatus === 'cancelled' ? '⏹' : '✓'"
              :label="
                store.runStatus === 'running'
                  ? '执行中'
                  : store.runStatus === 'completed'
                    ? '已完成'
                    : store.runStatus === 'failed'
                      ? '失败'
                      : '已取消'
              "
            />
          </div>

          <RunTrace />

          <div v-if="store.stream" class="task__answer">
            <h3 class="task__ah">Agent 结论</h3>
            <pre class="task__atext">{{ store.stream }}</pre>
          </div>

          <TaskResult />

          <ConfirmDock v-if="store.pendingConfirm" />
        </section>
      </div>

      <!-- 侧区：房间上下文 + 说明 -->
      <aside class="col col--side" aria-label="辅助信息">
        <LabMatrix @ask="onSubmit" />
        <details class="about">
          <summary class="about__sum">数据与引擎说明</summary>
          <div class="about__body">
            <p>
              当前引擎：{{ store.activeEngine === 'agnes' ? 'Agnes 3.0 Flash（真实模型选择工具并生成回答）' : '演示引擎（服务端规则解析，未调用大模型）' }}。
            </p>
            <p>
              数据来源：{{ store.overviewSourceLabel }}。脱敏快照与模拟演示**不是实时数据**；
              教师姓名已伪名化，不含用户名册与凭据。
            </p>
            <p>
              写操作（发布通知、创建整改工单）尚未接入；将来接入时必须经人工确认卡二次确认后才会执行。
            </p>
          </div>
        </details>
      </aside>
    </main>

    <!-- 运行/完成后：吸底命令栏接管输入（空态时 hero 里的输入是同一组件的另一种形态） -->
    <footer v-if="store.runStatus !== 'idle'" class="foot">
      <CommandBar variant="dock" @submit="onSubmit" @cancel="onCancel" />
    </footer>
  </div>
</template>

<style scoped>
.shell {
  max-width: 1280px;
  margin: 0 auto;
  padding: var(--sp-4) var(--sp-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-height: 100vh;
}
.top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.top__brand {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}
.top__mark {
  font-size: 22px;
  line-height: 1.1;
  color: var(--primary);
}
.top__title {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.01em;
}
.top__sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.top__right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--sp-2);
}
.top__badges {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.top__newbtn {
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 12px;
  border-radius: 999px;
  padding: 3px 12px;
  cursor: pointer;
}
.top__newbtn:hover {
  color: var(--text);
  background: var(--surface-3);
}
.theme {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
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
  color: #fff;
}
.top__warn {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: var(--sp-4);
  align-items: start;
  flex: 1;
}
.col {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 0;
}
.col--side {
  position: sticky;
  top: var(--sp-4);
}

/* ---- 空态 hero ---- */
.hero {
  text-align: center;
  padding: clamp(24px, 12vh, 96px) var(--sp-2) 0;
}
.hero__h {
  margin: 0 0 var(--sp-2);
  font-size: clamp(22px, 3.4vw, 30px);
  letter-spacing: 0.01em;
}
.hero__p {
  margin: 0 auto var(--sp-5);
  max-width: 560px;
  color: var(--text-muted);
  font-size: 14px;
}
.hero__scope {
  margin: var(--sp-4) auto 0;
  max-width: 620px;
  font-size: 12px;
  color: var(--text-faint);
}

/* ---- 任务卡 ---- */
.task {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.task__q {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding-bottom: var(--sp-3);
  border-bottom: 1px dashed var(--border);
}
.task__qlabel {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: var(--primary);
  border: 1px solid var(--primary-border);
  background: var(--primary-weak);
  border-radius: var(--radius-sm);
  padding: 1px 7px;
  margin-top: 2px;
}
.task__qtext {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
}
.task__answer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.task__ah {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}
.task__atext {
  margin: 0;
  padding: var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-sans);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}

/* ---- 侧栏说明 ---- */
.about {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--sp-3) var(--sp-4);
  box-shadow: var(--shadow-1);
  font-size: 12px;
  color: var(--text-muted);
}
.about__sum {
  cursor: pointer;
  font-weight: 600;
  color: var(--text);
  user-select: none;
}
.about__body {
  margin-top: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.about__body p {
  margin: 0;
}

/* ---- 吸底命令栏 ---- */
.foot {
  position: sticky;
  bottom: 0;
  padding: var(--sp-3) 0 var(--sp-4);
  background: linear-gradient(to top, var(--bg) 72%, transparent);
}

@media (max-width: 1024px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .col--side {
    position: static;
    order: 2;
  }
  .col--main {
    order: 1;
  }
}
@media (max-width: 640px) {
  .shell {
    padding: var(--sp-3) var(--sp-3) 0;
    gap: var(--sp-3);
  }
  .top__right {
    align-items: flex-start;
    width: 100%;
  }
  .top__title {
    font-size: 16px;
  }
  .hero {
    padding-top: 8vh;
  }
  .task {
    padding: var(--sp-3);
  }
}
</style>
