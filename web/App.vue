<script setup lang="ts">
/**
 * 任务画布 —— 应用外壳
 * ============================================================================
 *  布局：桌面双列（左：实验室矩阵；右：任务轨迹 + 结果与依据）
 *        手机单列（矩阵 → 轨迹 → 结果），命令栏常驻底部
 *  主题：跟随系统 prefers-color-scheme，并提供手动切换（深/浅）
 */
import { onMounted, ref } from 'vue';
import { useRunStore } from './stores/run';
import { useAgentStream } from './composables/useAgentStream';
import LabMatrix from './components/LabMatrix.vue';
import CommandBar from './components/CommandBar.vue';
import RunTrace from './components/RunTrace.vue';
import ScheduleResult from './components/ScheduleResult.vue';
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
          <h1 class="top__title">LabOps Agent · 实验室任务画布</h1>
          <p class="top__sub">
            第一阶段：一句话查课表（纵向链路打通）。服务对象：管理员 / 志愿者 / 学生。
          </p>
        </div>
      </div>

      <div class="top__right">
        <SourceBadge :source-type="store.sourceType ?? store.overviewSourceType" :engine="store.activeEngine" compact />
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
      <div class="col col--left">
        <LabMatrix @ask="onSubmit" />
      </div>
      <div class="col col--right">
        <RunTrace />
        <ScheduleResult />
        <ConfirmDock />
      </div>
    </main>

    <footer class="foot">
      <CommandBar @submit="onSubmit" @cancel="onCancel" />
      <p class="foot__note">
        {{
          store.activeEngine === 'demo'
            ? '当前服务端未配置 AGNES_API_KEY：回答由演示引擎（服务端规则解析）生成，界面与回答均已标注，未调用大模型。'
            : '当前由 Agnes 3.0 Flash 负责工具选择与回答生成；工具参数经服务端白名单与类型校验后才执行。'
        }}
        数据来源标识见页面顶部，三种来源（实时数据 / 脱敏快照 / 模拟演示）在视觉上可区分。
      </p>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  max-width: 1440px;
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
  /* 左栏给到 560px：房间卡片能排成 3 列，矩阵不会长成一条 1500px 的窄柱子 */
  grid-template-columns: minmax(0, 560px) minmax(0, 1fr);
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
.foot {
  position: sticky;
  bottom: 0;
  padding: var(--sp-3) 0 var(--sp-4);
  background: linear-gradient(to top, var(--bg) 72%, transparent);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.foot__note {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  text-align: center;
}

@media (max-width: 1024px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .col--left {
    order: 2;
  }
  .col--right {
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
  /* 手机上吸底栏必须瘦：说明文字藏起来，否则会吃掉四成屏高（实测过 343px） */
  .foot__note {
    display: none;
  }
}
</style>
