<script setup lang="ts">
/**
 * 自动化（定时任务）主面板
 * ============================================================================
 *  形态：
 *    列表（卡片 + 开关） → 详情（概览 + 历史） → 新建（三控件 + 影响核对）
 *
 *  列表保持可扫读：
 *    · 一条规则一张卡，首屏只回答 4 个问题；参数/审计不铺在列表上
 *    · 开关即暂停/恢复，不必走"修改→预览→确认"
 *    · 创建只需选模板 + 频率 + 时间；完整参数收进"完整设置"
 *    · 提醒偏好、事实结果、准备包收在折叠区，不与主任务混排
 *    · PC 与移动端共用本组件（移动端传 inline），口径一致
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { t as tr } from '../../i18n';
import UiIcon from '../UiIcon.vue';
import { useModal } from '../../composables/useModal';
import { useVisibleRefresh } from '../../composables/useVisibleRefresh';
import { useBusinessStore } from '../../stores/business';
import { useSessionStore } from '../../stores/session';
import { copySpec, newSpec, type ScheduledSpec } from '../../business/scheduled-form';
import { useAutomation, type AutomationJob } from '../../composables/useAutomation';
import {
  calendarText,
  effectsText,
  formatDateTime,
  recipientsText,
  statusMeta,
  triggerText
} from '../../business/automation-format';
import { kindHint } from '../../business/automation-format';
import AutomationTaskCard from './AutomationTaskCard.vue';
import AutomationComposer from './AutomationComposer.vue';
import AutomationHistory from './AutomationHistory.vue';
import type { Target } from '@shared/labops-targets.js';

const props = defineProps<{
  readonly?: boolean;
  inline?: boolean;
  jobId?: string;
  navigation?: boolean;
  iconOnly?: boolean;
}>();

const emit = defineEmits<{ navigate: [Target] }>();

const business = useBusinessStore();
const session = useSessionStore();
const automation = useAutomation();

const open = ref(Boolean(props.inline));
const composerOpen = ref(false);
const editing = ref<AutomationJob | null>(null);
const spec = ref<ScheduledSpec>(newSpec(business.profile?.username || ''));
const savedNotice = ref('');
  // 模板网格的静态展示元数据（图标 + 示例节奏），点击即按该模板新建
  const TEMPLATE_META: Record<string, { icon: string; schedule: string }> = {
    daily_report: { icon: 'clock', schedule: '每天 08:00' },
    tomorrow_courses: { icon: 'room', schedule: '每天 17:30' },
    duty_reminder: { icon: 'clock', schedule: '班前 30 分钟' },
    due_followup: { icon: 'bell', schedule: '每天 18:00' },
    notice_reminder: { icon: 'bell', schedule: '每天 09:00' },
    lab_open_reminder: { icon: 'room', schedule: '开门前 30 分钟' },
    session_checkin_reminder: { icon: 'star', schedule: '按值班班次' },
    patrol_reminder: { icon: 'file', schedule: '按值班班次' },
    agent_prompt: { icon: 'new', schedule: '你说时间，Agent 执行' }
  };
  // 模板卡预填推荐指令（新建统一指令驱动）
  const PROMPT_PRESETS: Record<string, string> = {
    daily_report: '汇总今天的值班、报修与站内通知，生成今日日报',
    tomorrow_courses: '查一下明天有哪些课、哪些教室要用，提前一天整理成清单',
    duty_reminder: '查一下下一次正式值班，提醒我带好钥匙并按时到岗',
    due_followup: '查一下有没有快到截止时间还没处理的工单，提醒跟进',
    notice_reminder: '查一下我还没读的站内通知，挑重要的简单说一遍',
    lab_open_reminder: '查明天要上课的实验室，提醒志愿者提前开门',
    session_checkin_reminder: '对照今天的签到记录，提醒还没到岗的值班缺口',
    patrol_reminder: '按值班班次巡查实验室：服务状态、未关闭工单与异常情况'
  };
  const startCreateWith = (kind: string): void => {
    if (props.readonly) return;
    if (props.inline) session.startDraft();
    editing.value = null;
    composerOpen.value = true;
    automation.cancelPlan();
    spec.value = newSpec(business.profile?.username || '');
    // 新建统一指令驱动——kind=agent_prompt，模板卡预填推荐指令
    spec.value.kind = 'agent_prompt';
    spec.value.execMode = 'agent';
    spec.value.prompt = PROMPT_PRESETS[kind] ?? '';
    spec.value.name = automation.templates.value[kind] || kind;
  };
// 示例话术复制（剪贴板不可用时如实提示，不谎报复制成功）
const copied = ref(false);
async function copyExample(): Promise<void> {
  const phrase = '每天早上 8 点给我发昨天的日报';
  try {
    await navigator.clipboard.writeText(phrase);
    copied.value = true;
  } catch {
    copied.value = false;
    window.prompt(tr('复制失败，请手动选择复制：'), phrase);
  }
  setTimeout(() => { copied.value = false; }, 2000);
}

const detail = automation.detail;
const plan = automation.plan;
const busy = automation.busy;
const error = automation.error;

// 影响核对区在列表/详情页的底部：生成后滚过去，避免用户以为按钮没反应
// （新建/编辑路径由 AutomationComposer 自己滚，两边互斥不会抢滚动）
const panelPlanEl = ref<HTMLElement | null>(null);
watch(plan, async (value) => {
  if (!value || composerOpen.value) return;
  await nextTick();
  panelPlanEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
// 服务端失败信息在面板顶部；用户在底部点"创建"时也要能看到原因，不能静默
const panelErrorEl = ref<HTMLElement | null>(null);
watch(error, async (value) => {
  if (!value) return;
  await nextTick();
  panelErrorEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

useModal(open, '.auto-panel', () => !props.inline);

const titleText = computed(() => (props.jobId ? tr('自动化详情') : tr('自动化')));
const activeCount = computed(() => automation.jobs.value.filter((job) => job.status === 'active').length);
const inDetail = computed(() => Boolean(props.jobId || detail.value));

// 动作中文标签：确认区显示中文，避免裸英文 action 无法核对
const ACTION_LABELS: Record<string, string> = {
  create: '创建', change: '修改', pause: '暂停', resume: '恢复', archive: '归档', run_now: '立即运行'
};
function actionLabel(action: string): string {
  return tr(ACTION_LABELS[action] || action);
}

function closeIfOverlay(): void {
  if (!props.inline) open.value = false;
}

async function openPanel(): Promise<void> {
  open.value = true;
  composerOpen.value = false;
  editing.value = null;
  automation.cancelPlan();
  if (!props.jobId) detail.value = null;
  await automation.load();
  if (props.jobId) await automation.loadDetail(props.jobId);
}

function startCreate(): void {
  if (props.readonly) return;
  if (props.inline) session.startDraft();
  editing.value = null;
  composerOpen.value = true;
  automation.cancelPlan();
  spec.value = newSpec(business.profile?.username || '');
  // 新建统一指令驱动——执行方式默认让 Agent 去做，标题留空由用户起
  spec.value.kind = 'agent_prompt';
  spec.value.execMode = 'agent';
}

function startEdit(job: AutomationJob): void {
  if (props.readonly) return;
  if (props.inline) session.startDraft();
  editing.value = job;
  composerOpen.value = true;
  automation.cancelPlan();
  spec.value = copySpec(job.spec);
}

async function requestPlan(): Promise<void> {
  const action = editing.value ? 'change' : 'create';
  await automation.requestPlan(action, spec.value, editing.value ?? undefined);
}

async function confirmPlan(): Promise<void> {
  const result = await automation.confirmPlan();
  if (!result) return;
  composerOpen.value = false;
  editing.value = null;
  savedNotice.value = tr('已保存');
  if (props.inline && result.id) emit('navigate', { view: 'job', jobId: result.id } as Target);
  if (props.jobId) await automation.loadDetail(props.jobId);
}

function cancelComposer(): void {
  composerOpen.value = false;
  editing.value = null;
  automation.cancelPlan();
}

async function openDetail(job: AutomationJob): Promise<void> {
  if (props.inline) {
    emit('navigate', { view: 'job', jobId: job.id } as Target);
    return;
  }
  if (!job.canViewDetails && !job.canManage) return;
  await automation.loadDetail(job.id);
}

function backToList(): void {
  automation.cancelPlan();
  if (props.inline) {
    emit('navigate', { view: 'automation' } as Target);
    return;
  }
  automation.closeDetail();
}

async function toggleJob(job: AutomationJob): Promise<void> {
  await automation.toggle(job);
}

// 历史记录独立分区：运行中/暂停留在主列表；已完成/已归档沉到页面底部「历史记录」
const liveJobs = computed(() =>
  automation.jobs.value.filter((j) => j.status !== 'archived' && j.displayStatus !== 'completed')
);
const historyJobs = computed(() =>
  automation.jobs.value.filter((j) => j.status === 'archived' || j.displayStatus === 'completed')
);

const delConfirm = ref<AutomationJob | null>(null);
async function onDelete(job: AutomationJob): Promise<void> {
  if (delConfirm.value?.id !== job.id) {
    delConfirm.value = job; // 卡片自身已做两步确认，这里兜底直接执行
  }
  await automation.deleteJob(job);
  delConfirm.value = null;
}

async function runNow(job: AutomationJob): Promise<void> {
  await automation.runNow(job);
}

async function archiveJob(job: AutomationJob): Promise<void> {
  await automation.archive(job);
}

function onTarget(event: Event): void {
  const target = (event as CustomEvent<Target>).detail;
  if (target?.view !== 'automation' && !target?.jobId) return;
  void (async () => {
    open.value = true;
    await automation.load();
    if (target.jobId) await automation.loadDetail(target.jobId);
  })();
}

onMounted(() => {
  window.addEventListener('labops-target', onTarget);
  if (props.inline) {
    void automation.load().then(() => {
      if (props.jobId) void automation.loadDetail(props.jobId);
    });
  }
});

onUnmounted(() => window.removeEventListener('labops-target', onTarget));

watch(
  () => props.jobId,
  (id) => {
    if (!id) return;
    open.value = true;
    void automation.loadDetail(id);
  }
);

watch(
  () => business.scopeKey,
  () => {
    automation.reset();
    composerOpen.value = false;
    editing.value = null;
    if (!props.inline) open.value = false;
    if (props.inline) void automation.load();
  }
);

useVisibleRefresh(
  () => automation.load(),
  () => open.value && !composerOpen.value && !plan.value && !busy.value
);
</script>

<template>
  <!-- 侧栏 / 顶栏入口（PC）。移动端走 inline，不渲染这里 -->
  <div v-if="business.connected && !inline" class="auto-entry">
    <button
      type="button"
      :class="{ 'nav-tool': navigation }"
      :aria-label="tr('自动化')"
      :title="tr('自动化')"
      @click="openPanel"
    >
      <UiIcon v-if="navigation" name="clock" />
      <span v-if="!iconOnly">{{ tr('自动化') }}</span>
      <span v-if="!iconOnly && activeCount" class="auto-entry__count">{{ activeCount }}</span>
    </button>
  </div>

  <Teleport to="body" :disabled="inline">
    <div v-if="open && business.connected" :class="inline ? 'auto-inline' : 'auto-mask'" @click.self="closeIfOverlay">
      <section
        class="auto-panel"
        :role="inline ? undefined : 'dialog'"
        :aria-modal="inline ? undefined : true"
        :aria-label="titleText"
      >
        <header class="auto-panel__head">
          <h1>{{ titleText }}</h1>
          <span v-if="activeCount" class="auto-panel__count">{{ activeCount }}{{ tr(' 个运行中') }}</span>
          <button type="button" :disabled="busy" @click="automation.load">{{ tr('刷新') }}</button>
          <button v-if="!inline" type="button" :aria-label="tr('关闭自动化')" @click="open = false">
            {{ tr('关闭') }}
          </button>
        </header>

        <p v-if="readonly" class="auto-note">
          {{ tr('当前只可查询规则与结果。修改请新建工作会话或进入实验室工作台。') }}
        </p>
        <p v-if="busy" class="auto-note" role="status">{{ tr('正在读取 / 保存…') }}</p>
        <p v-if="error" ref="panelErrorEl" class="auto-error" role="alert">{{ error }}</p>
        <p v-if="savedNotice" class="auto-ok" role="status">{{ savedNotice }}</p>

        <!-- 详情 -->
        <template v-if="inDetail && detail">
          <div class="auto-detail">
            <button type="button" class="auto-back" :disabled="busy" @click="backToList">
              <span aria-hidden="true">←</span>{{ tr('返回') }}
            </button>
            <div class="auto-detail__head">
              <h2>{{ detail.job.spec.name || automation.templates.value[detail.job.spec.kind] || detail.job.spec.kind }}</h2>
              <span class="auto-badge" :class="`auto-badge--${statusMeta(detail.job.displayStatus || detail.job.status).tone}`">
                <span aria-hidden="true">{{ statusMeta(detail.job.displayStatus || detail.job.status).glyph }}</span>
                {{ tr(statusMeta(detail.job.displayStatus || detail.job.status).label) }}
              </span>
            </div>

            <dl class="auto-detail__grid">
              <div><dt>{{ tr('频率') }}</dt><dd>{{ tr(triggerText(detail.job.spec)) }}</dd></div>
              <div><dt>{{ tr('下次运行') }}</dt><dd>{{ formatDateTime(detail.job.nextRunAt) }}</dd></div>
              <!-- maxRuns 用尽后 displayStatus=completed，这里显示进度 -->
              <div v-if="detail.job.spec.trigger.maxRuns"><dt>{{ tr('已运行') }}</dt><dd>{{ detail.runs.length }} / {{ detail.job.spec.trigger.maxRuns }} {{ tr('次') }}</dd></div>
              <div><dt>{{ tr('日历') }}</dt><dd>{{ tr(calendarText(detail.job.spec.calendarPolicy)) }}</dd></div>
              <div><dt>{{ tr('接收') }}</dt><dd>{{ tr(recipientsText(detail.job.spec.recipients)) }}</dd></div>
              <div><dt>{{ tr('效果') }}</dt><dd>{{ tr(effectsText(detail.job.spec.approvedEffects)) }}</dd></div>
              <div><dt>{{ tr('所有者') }}</dt><dd>{{ detail.job.ownerId }}</dd></div>
              <!-- 编辑走版本化 change，这里让"上次改动"可见 -->
              <div v-if="detail.job.updatedAt"><dt>{{ tr('最近修改') }}</dt><dd>{{ formatDateTime(detail.job.updatedAt) }} · v{{ detail.job.version }}</dd></div>
            </dl>

            <div v-if="!readonly && detail.job.canManage" class="auto-actions">
              <button type="button" :disabled="busy" @click="startEdit(detail.job)">{{ tr('编辑') }}</button>
              <button type="button" :disabled="busy" @click="runNow(detail.job)">{{ tr('立即运行') }}</button>
              <!-- 已完成（maxRuns 用尽）的任务不再提供暂停/恢复——历史保留，语义已终结 -->
              <button
                v-if="detail.job.displayStatus !== 'completed'"
                type="button"
                :disabled="busy"
                @click="toggleJob(detail.job)"
              >
                {{ tr(detail.job.status === 'active' ? '暂停' : '恢复') }}
              </button>
              <button
                v-if="detail.job.status !== 'archived'"
                type="button"
                class="auto-danger-link"
                :disabled="busy"
                @click="archiveJob(detail.job)"
              >
                {{ tr('归档') }}
              </button>
            </div>
            <p v-else-if="!readonly" class="auto-note">
              {{ tr('当前仅有查看详情权限，不能接管或修改此规则。') }}
            </p>

            <details class="auto-detail__raw">
              <summary>{{ tr('完整规则参数') }}</summary>
              <pre>{{ JSON.stringify(detail.job.spec, null, 2) }}</pre>
            </details>

            <AutomationHistory :runs="detail.runs" />

            <details v-if="detail.audit?.length" class="auto-detail__raw">
              <summary>{{ tr('审计记录') }}</summary>
              <pre>{{ JSON.stringify(detail.audit, null, 2) }}</pre>
            </details>
          </div>

          <!-- 影响核对（详情页里的立即运行/归档也走同一套确认） -->
          <section v-if="plan" ref="panelPlanEl" class="auto-review">
            <h3>{{ tr('确认后才会生效') }}</h3>
            <p class="auto-review__line">{{ tr('动作') }}：{{ actionLabel(plan.action) }} · {{ tr('接收') }}：{{ tr(recipientsText(plan.spec.recipients)) }}</p>
            <p class="auto-review__line">{{ tr('效果') }}：{{ tr(effectsText(plan.effects)) }}</p>
            <ol v-if="plan.futureOccurrences?.length" class="auto-review__occ">
              <li v-for="item in plan.futureOccurrences.slice(0, 3)" :key="item.at">{{ item.local }}</li>
            </ol>
            <div class="auto-actions">
              <button type="button" class="auto-primary" :disabled="busy" @click="confirmPlan">{{ tr('确认执行') }}</button>
              <button type="button" :disabled="busy" @click="automation.cancelPlan">{{ tr('取消') }}</button>
            </div>
          </section>
        </template>

        <!-- 新建 / 编辑 -->
        <template v-else-if="composerOpen && !readonly">
          <button type="button" class="auto-back" :disabled="busy" @click="cancelComposer">
            <span aria-hidden="true">←</span>{{ tr('返回') }}
          </button>
          <AutomationComposer
            v-model="spec"
            :templates="automation.templates.value"
            :busy="busy"
            :editing="Boolean(editing)"
            :plan="plan"
            :timezone="automation.timezone.value"
            @request-plan="requestPlan"
            @confirm="confirmPlan"
            @cancel="cancelComposer"
          />
        </template>

        <!-- 列表（标题块 + 任务卡 + 模板网格） -->
        <template v-else>
          <div class="auto-hero">
            <h1 class="auto-hero__title">{{ tr('定时任务') }}</h1>
            <p class="auto-hero__sub">{{ tr('到点自动执行：生成日报、提醒值班，或让 Agent 替你查询与整理。') }}</p>
          </div>
          <div class="auto-create-bar">
            <button type="button" class="auto-primary auto-create-btn" :disabled="busy || readonly" @click="startCreate">
              {{ tr('新建定时任务') }}
            </button>
          </div>
          <div class="auto-list">
            <AutomationTaskCard
              v-for="job in liveJobs"
              :key="job.id"
              :job="job"
              :templates="automation.templates.value"
              :busy="busy"
              :readonly="readonly"
              @open="openDetail(job)"
              @toggle="toggleJob(job)"
              @delete="onDelete(job)"
            />
          </div>

          <div v-if="!automation.jobs.value.length && !busy" class="auto-empty-card">
            <p class="auto-empty-card__title">{{ tr('还没有定时任务') }}</p>
            <button type="button" class="auto-primary" :disabled="busy" @click="startCreate">
              {{ tr('创建定时任务') }}
            </button>
            <!-- 自动化的最短路径是"跟 Agent 说一句话"，这里把它显性化 -->
            <p class="auto-empty__try">
              {{ tr('也可以在会话里直接对我说：') }}
              <code>每天早上 8 点给我发昨天的日报</code>
              <button type="button" class="auto-link" @click="copyExample">{{ tr(copied ? '已复制' : '复制这句话') }}</button>
            </p>
          </div>

          <div class="auto-tpl-section">
            <h3 class="auto-tpl-section__title">{{ tr('定时任务模板') }}</h3>
            <div class="auto-tpl-grid">
              <button
                v-for="(meta, kind) in TEMPLATE_META"
                :key="kind"
                type="button"
                class="auto-tpl-card"
                :disabled="busy"
                @click="startCreateWith(String(kind))"
              >
                <span class="auto-tpl-card__head">
                  <UiIcon :name="meta.icon" :size="15"/>
                  <b>{{ tr(automation.templates.value[String(kind)] || String(kind)) }}</b>
                </span>
                <span class="auto-tpl-card__hint">{{ tr(kindHint(String(kind))) }}</span>
                <span class="auto-tpl-card__sched">{{ tr(meta.schedule) }}</span>
              </button>
            </div>
          </div>

          <!-- 历史记录：已完成/已归档，独立分区沉底（不与运行中任务混排） -->
          <div v-if="historyJobs.length" class="auto-tpl-section auto-history">
            <h3 class="auto-tpl-section__title">{{ tr('历史记录') }}</h3>
            <p class="auto-field__hint">{{ tr('已完成或已归档的任务保留在这里，可删除记录；不影响运行中的任务。') }}</p>
            <div class="auto-list">
              <AutomationTaskCard
                v-for="job in historyJobs"
                :key="job.id"
                :job="job"
                :templates="automation.templates.value"
                :busy="busy"
                :readonly="readonly"
                @open="openDetail(job)"
                @toggle="toggleJob(job)"
                @delete="onDelete(job)"
              />
            </div>
          </div>

          <!-- 影响核对（列表页的新建/立即运行/归档） -->
          <section v-if="plan" ref="panelPlanEl" class="auto-review">
            <h3>{{ tr('确认后才会生效') }}</h3>
            <dl class="auto-review__grid">
              <div><dt>{{ tr('频率') }}</dt><dd>{{ tr(triggerText(plan.spec)) }}</dd></div>
              <div><dt>{{ tr('方案有效至') }}</dt><dd>{{ formatDateTime(plan.expiresAt) }}</dd></div>
            </dl>
            <ol v-if="plan.futureOccurrences?.length" class="auto-review__occ">
              <li v-for="item in plan.futureOccurrences.slice(0, 3)" :key="item.at">{{ item.local }}</li>
            </ol>
            <div class="auto-actions">
              <button type="button" class="auto-primary" :disabled="busy" @click="confirmPlan">{{ tr('确认执行') }}</button>
              <button type="button" :disabled="busy" @click="automation.cancelPlan">{{ tr('取消') }}</button>
            </div>
          </section>

    </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.auto-entry {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 20px;
  font-size: calc(var(--ui-font-size) * 0.92308);
  border-bottom: 1px solid var(--border);
}
.auto-entry button {
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  min-height: 36px;
}
.auto-entry__count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--primary);
  color: var(--primary-contrast);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.auto-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: #0006;
  padding: 4dvh 16px;
  display: flex;
  justify-content: center;
}
.auto-panel {
  width: min(75vw, 100%);
  max-height: 94dvh;
  overflow: auto;
  scrollbar-width: none;
  padding: 22px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border-strong);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
  border-radius: 10px;
  box-sizing: border-box;
  display: grid;
  gap: 12px;
  align-content: start;
}
.auto-panel::-webkit-scrollbar {
  display: none;
}
.auto-inline .auto-panel {
  width: 100%;
  max-height: none;
  overflow: visible;
  padding: 0;
  border-radius: 0;
}
.auto-panel__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.auto-panel__head h1 {
  margin: 0;
  font-size: 16px;
  margin-right: auto;
}
.auto-panel__count {
  font-size: 12px;
  color: var(--text-faint);
}
.auto-panel__head button {
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
}
.auto-panel__head button:disabled {
  opacity: 0.55;
}
.auto-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
.auto-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #b91c1c);
}
.auto-ok {
  margin: 0;
  font-size: 12px;
  color: var(--ok, #2e7d32);
}
.auto-list {
  display: grid;
  gap: 10px;
}
.auto-empty {
  padding: 20px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
.auto-empty p {
  margin: 0;
}
.auto-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.auto-actions button {
  min-height: 38px;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.auto-actions button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.auto-primary {
  background: var(--primary) !important;
  border-color: var(--primary) !important;
  color: var(--primary-contrast) !important;
  font-weight: 600;
}
.auto-danger-link {
  color: var(--danger, #b91c1c) !important;
}
.auto-detail {
  display: grid;
  gap: 12px;
}
.auto-detail__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.auto-detail__head h2 {
  margin: 0;
  font-size: 16px;
}
.auto-detail__grid {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  background: var(--surface-2);
}
.auto-detail__grid dt {
  font-size: 11px;
  color: var(--text-faint);
}
.auto-detail__grid dd {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.auto-detail__raw summary,
.auto-fold summary,
.auto-result summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
}
.auto-detail__raw pre,
.auto-result pre,
.auto-fold pre {
  margin: 6px 0 0;
  padding: 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 260px;
  overflow: auto;
}
.auto-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
}
.auto-badge--ok {
  color: var(--ok, #2e7d32);
}
.auto-badge--warn {
  color: var(--warning, #a16207);
  border-style: dashed;
}
.auto-badge--danger {
  color: var(--danger, #b91c1c);
  border-style: double;
  border-width: 3px;
}
.auto-badge--info {
  color: var(--primary);
}
.auto-badge--muted {
  color: var(--text-faint);
  border-style: dashed;
}
.auto-review {
  border: 1px solid var(--primary);
  border-radius: 10px;
  padding: 14px;
  display: grid;
  gap: 10px;
}
.auto-review h3 {
  margin: 0;
  font-size: 14px;
}
.auto-review__grid {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 16px;
}
.auto-review__grid dt {
  font-size: 11px;
  color: var(--text-faint);
}
.auto-review__grid dd {
  margin: 0;
  font-size: 13px;
}
.auto-review__line {
  margin: 0;
  font-size: 13px;
}
.auto-review__occ {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
}
.auto-fold {
  border-top: 1px solid var(--border);
  padding-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
.auto-pref {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.auto-pref label {
  display: grid;
  gap: 4px;
  font-size: 12px;
}
.auto-pref input[type='time'],
.auto-pref input[type='number'] {
  min-height: 36px;
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
}
.auto-check {
  display: flex !important;
  align-items: center;
  gap: 6px;
}
.auto-check input {
  width: 18px;
  height: 18px;
}
.auto-pref__cats {
  grid-column: 1 / -1;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}
.auto-pref__cats legend {
  font-size: 11px;
  color: var(--text-faint);
  padding: 0 4px;
}
.auto-pref button {
  grid-column: 1 / -1;
  min-height: 40px;
  border-radius: 8px;
  border: 1px solid var(--primary);
  background: var(--primary);
  color: var(--primary-contrast);
  font: inherit;
  cursor: pointer;
  max-width: 220px;
}
.auto-result {
  margin-top: 8px;
}

@media (max-width: 640px) {
  .auto-mask {
    padding: 0;
  }
  .auto-panel {
    max-height: 100dvh;
    border-radius: 0;
    padding: 14px;
  }
  .auto-actions button {
    flex: 1 1 auto;
    min-height: 44px;
  }
  .auto-panel__head button {
    min-height: 40px;
  }
}
</style>
<style scoped>
/* 标题块（列表页） */
.auto-hero { margin: 0 0 18px; }
.auto-hero__title { margin: 0 0 6px; font-size: calc(var(--ui-font-size) * 1.7); font-weight: 700; color: var(--text); }
.auto-hero__sub { margin: 0; color: var(--text-faint); font-size: calc(var(--ui-font-size) * 1.0); }
/* 空态大卡：居中按钮的大边框卡 */
.auto-empty-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 12px);
  padding: 56px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.auto-empty-card__title { margin: 0; color: var(--text-faint); font-size: calc(var(--ui-font-size) * 1.0); }
.auto-empty-card .auto-empty__try { margin: 6px 0 0; }
/* 模板网格：PC 两列、窄屏单列 */
.auto-tpl-section { margin-top: 26px; }
.auto-history{opacity:0.88}
.auto-tpl-section__title { margin: 0 0 10px; font-size: calc(var(--ui-font-size) * 1.0); color: var(--text-muted); font-weight: 600; }
.auto-tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.auto-tpl-card {
  display: flex; flex-direction: column; gap: 4px; text-align: left;
  border: 1px solid var(--border); border-radius: var(--radius-lg, 12px);
  background: var(--surface); color: var(--text);
  padding: 9px 14px; cursor: pointer; font: inherit;
}
.auto-tpl-card:hover { border-color: var(--border-strong, var(--primary)); }
.auto-tpl-card:disabled { opacity: .6; cursor: wait; }
.auto-tpl-card__head { display: flex; align-items: center; gap: 8px; font-size: calc(var(--ui-font-size) * 1.0); }
.auto-tpl-card__hint { color: var(--text-muted); font-size: calc(var(--ui-font-size) * 0.92308); line-height: 1.55; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.auto-tpl-card__sched { color: var(--text-faint); font-size: calc(var(--ui-font-size) * 0.84615); }
@media(max-width: 720px) { .auto-tpl-grid { grid-template-columns: 1fr; } }
/* 新建定时任务按钮栏：左对齐、圆角主按钮 */
.auto-create-bar { display: flex; margin: 0 0 4px; }
.auto-create-btn {
  min-height: 38px; padding: 8px 20px;
  border-radius: 999px; border: 1px solid var(--primary);
  font: inherit; font-weight: 600; cursor: pointer;
}
.auto-create-btn:disabled { opacity: .55; cursor: not-allowed; }
/* 子页面返回按钮：左对齐、轻量 */
.auto-back {
  justify-self: start; display: inline-flex; align-items: center; gap: 6px;
  min-height: 34px; padding: 6px 10px;
  background: transparent; border: 0; border-radius: 6px;
  color: var(--text-muted); font: inherit; cursor: pointer;
}
.auto-back:hover { background: var(--surface-3); color: var(--text); }
.auto-back:disabled { opacity: .55; cursor: not-allowed; }

/* 面板头部/操作按钮的悬浮反馈 */
.auto-panel__head button:hover:not(:disabled),
.auto-actions button:hover:not(:disabled),
.auto-pref button:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: var(--primary-border);
  color: var(--primary);
}
.auto-entry button:hover {
  color: var(--primary);
  background: var(--primary-weak);
}
.auto-panel__head button:active:not(:disabled),
.auto-actions button:active:not(:disabled) {
  background: var(--surface-2);
}
.auto-panel__head button:focus-visible,
.auto-actions button:focus-visible,
.auto-pref button:focus-visible,
.auto-entry button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

</style>
