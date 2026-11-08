/**
 * 自动化（定时任务）数据层
 * ============================================================================
 *  把原来塞在 ScheduledJobsPanel.vue 模板里的 8 类请求收拢到这里：
 *  列表 / 详情 / 预览 / 确认 / 开关 / 立即执行 / 归档 / 提醒偏好 / 事实结果 / 准备包。
 *
 *  三条设计约束：
 *  1) **scope 感知**：切换账号时丢弃上一账号的在途响应，避免把 A 的规则渲染给 B。
 *  2) **不静默失败**：任何失败都写进 error，由界面显式呈现（这是本项目踩过的坑）。
 *  3) **开关是一键的，创建不是**：暂停/恢复不外发任何消息，可以自动走完
 *     preview→confirm；创建/修改/立即执行/归档会改变外部世界（给人发通知），
 *     必须让用户看到影响核对后再确认（C6 human-in-the-loop）。
 */

import { computed, ref } from 'vue';
import { businessApi, useBusinessStore } from '../stores/business';
import type { ScheduledSpec } from '../business/scheduled-form';

export type AutomationAction = 'create' | 'change' | 'pause' | 'resume' | 'archive' | 'run_now';

export interface AutomationJob {
  id: string;
  ownerId: string;
  version: number;
  status: string;
  displayStatus?: string;
  spec: ScheduledSpec;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastRunStatus?: string;
  /** RAG 之外的批次 A（G5）：最近修改时间（主系统 Job.updatedAt 透传，缺省无） */
  updatedAt?: string;
  canViewDetails: boolean;
  canManage: boolean;
}

export interface AutomationRun {
  id: string;
  occurrenceLocal: string;
  status: string;
  attempt: number;
  error?: string;
  sourceRevision?: string;
  frozenPayload: Array<{ output: { text: string; agent?: { runId?: string; model?: string; toolCalls?: number } } }>;
  resultRefs: unknown[];
}

export interface AutomationDetail {
  job: AutomationJob;
  runs: AutomationRun[];
  audit: unknown[];
}

export interface AutomationPlan {
  id: string;
  action: AutomationAction;
  jobId: string;
  spec: ScheduledSpec;
  futureOccurrences: Array<{ at: string; local: string }>;
  sample: { text: string };
  effects: string[];
  expiresAt: string;
  beforeSpec?: ScheduledSpec | null;
  changes?: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface ReminderPreference {
  enabled: boolean;
  quietStart: string;
  quietEnd: string;
  categories: string[];
  maxPerDay: number;
  maxPerEvent: number;
  minIntervalMinutes: number;
}

export interface SavedResult {
  id: string;
  title: string;
  text: string;
}

export function useAutomation() {
  const business = useBusinessStore();

  const jobs = ref<AutomationJob[]>([]);
  const templates = ref<Record<string, string>>({});
  const timezone = ref('Asia/Shanghai');
  const preference = ref<ReminderPreference | null>(null);
  const results = ref<SavedResult[]>([]);
  const preparation = ref('');
  const detail = ref<AutomationDetail | null>(null);
  const plan = ref<AutomationPlan | null>(null);

  const loading = ref(false);
  const busy = ref(false);
  const error = ref('');
  const ready = ref(false);

  const connected = computed(() => business.connected);
  const activeCount = computed(() => jobs.value.filter((j) => j.status === 'active').length);

  /** 统一守卫：防并发、集中错误、丢弃跨账号的过期响应。忙时不再静默：显式提示，避免旧方案被误确认 */
  async function guard(fn: () => Promise<void>): Promise<void> {
    if (busy.value) {
      error.value = '上一个操作尚未完成，请稍候再试';
      return;
    }
    const scope = business.scopeKey;
    busy.value = true;
    error.value = '';
    try {
      await fn();
    } catch (e) {
      if (scope === business.scopeKey) error.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
  }

  function reset(): void {
    jobs.value = [];
    detail.value = null;
    plan.value = null;
    preference.value = null;
    results.value = [];
    preparation.value = '';
    error.value = '';
    ready.value = false;
  }

  async function load(): Promise<void> {
    if (!business.connected) return;
    loading.value = true;
    try {
      await guard(async () => {
        const scope = business.scopeKey;
        const [list, prefs, saved] = await Promise.all([
          businessApi<{ jobs: AutomationJob[]; templates: Record<string, string>; timezone?: string }>(
            'proxy/scheduled-jobs'
          ),
          businessApi<{ preference: ReminderPreference }>('proxy/reminder-preferences').catch(() => null),
          businessApi<{ results: SavedResult[] }>('proxy/scheduled-results').catch(() => null)
        ]);
        if (scope !== business.scopeKey) return;
        jobs.value = list.jobs ?? [];
        templates.value = list.templates ?? {};
        timezone.value = list.timezone || 'Asia/Shanghai';
        preference.value = prefs?.preference ?? null;
        results.value = saved?.results ?? [];
        ready.value = true;
      });
    } finally {
      loading.value = false;
    }
  }

  async function loadDetail(id: string): Promise<void> {
    await guard(async () => {
      const scope = business.scopeKey;
      const data = await businessApi<AutomationDetail>('proxy/scheduled-jobs/' + id);
      if (scope !== business.scopeKey) return;
      detail.value = data;
    });
  }

  function closeDetail(): void {
    detail.value = null;
    plan.value = null;
  }

  /**
   * 请求影响核对方案。返回 plan 由界面渲染成"将要发生什么"，
   * 用户确认后才会真正写入 —— 这是外发类操作的必经环节。
   */
  async function requestPlan(action: AutomationAction, spec?: ScheduledSpec, job?: AutomationJob): Promise<boolean> {
    let ok = false;
    // 先清旧方案：即使本次请求被守卫挡掉或失败，也不会残留上一动作（如 run_now）被误确认
    plan.value = null;
    await guard(async () => {
      const scope = business.scopeKey;
      const body: Record<string, unknown> = {
        scopeKey: business.scopeKey,
        action,
        reason: '用户在自动化页面核对完整参数与影响'
      };
      if (job) {
        body['jobId'] = job.id;
        body['expectedVersion'] = job.version;
      }
      if ((action === 'create' || action === 'change') && spec) body['spec'] = spec;
      const res = await businessApi<{ plan: AutomationPlan }>('proxy/scheduled-jobs/preview', body);
      if (scope !== business.scopeKey) return;
      plan.value = res.plan;
      ok = true;
    });
    return ok;
  }

  async function confirmPlan(): Promise<AutomationJob | null> {
    const current = plan.value;
    if (!current) return null;
    let created: AutomationJob | null = null;
    await guard(async () => {
      const scope = business.scopeKey;
      const res = await businessApi<{ job: AutomationJob }>('proxy/scheduled-jobs/confirm', {
        scopeKey: business.scopeKey,
        planId: current.id
      });
      if (scope !== business.scopeKey) return;
      plan.value = null;
      created = res.job;
      await refreshQuiet();
      if (detail.value?.job.id === res.job.id) await loadDetailQuiet(res.job.id);
    });
    return created;
  }

  function cancelPlan(): void {
    plan.value = null;
  }

  /** 内部刷新：不抢 busy、不清 error，避免把确认结果冲掉 */
  async function refreshQuiet(): Promise<void> {
    const scope = business.scopeKey;
    const list = await businessApi<{ jobs: AutomationJob[]; templates: Record<string, string> }>(
      'proxy/scheduled-jobs'
    );
    if (scope !== business.scopeKey) return;
    jobs.value = list.jobs ?? [];
    templates.value = list.templates ?? {};
  }

  async function loadDetailQuiet(id: string): Promise<void> {
    const scope = business.scopeKey;
    const data = await businessApi<AutomationDetail>('proxy/scheduled-jobs/' + id);
    if (scope !== business.scopeKey) return;
    detail.value = data;
  }

  /**
   * 开关：暂停/恢复。这两类动作不改 spec、不外发消息，
   * 所以按主流 Agent APP 的习惯做成"拔一下就生效"——
   * 内部仍然走 preview→confirm 的协议，只是不再让用户点两次。
   */
  async function toggle(job: AutomationJob): Promise<void> {
    const action: AutomationAction = job.status === 'active' ? 'pause' : 'resume';
    await guard(async () => {
      const scope = business.scopeKey;
      const preview = await businessApi<{ plan: AutomationPlan }>('proxy/scheduled-jobs/preview', {
        scopeKey: business.scopeKey,
        action,
        jobId: job.id,
        expectedVersion: job.version,
        reason: '本人在列表上切换规则开关'
      });
      if (scope !== business.scopeKey) return;
      await businessApi('proxy/scheduled-jobs/confirm', { scopeKey: business.scopeKey, planId: preview.plan.id });
      if (scope !== business.scopeKey) return;
      await refreshQuiet();
    });
  }

  async function runNow(job: AutomationJob): Promise<void> {
    await requestPlan('run_now', undefined, job);
  }

  async function archive(job: AutomationJob): Promise<void> {
    await requestPlan('archive', undefined, job);
  }

  /** 删除历史任务记录（仅已完成/已归档；主系统一并清运行历史，审计行保留） */
  async function deleteJob(job: AutomationJob): Promise<void> {
    await guard(async () => {
      const scope = business.scopeKey;
      await businessApi('proxy/scheduled-jobs/delete', { jobId: job.id, scopeKey: business.scopeKey });
      if (scope !== business.scopeKey) return;
      if (detail.value?.job.id === job.id) detail.value = null;
      await refreshQuiet();
    });
  }

  async function savePreference(next: ReminderPreference): Promise<boolean> {
    let ok = false;
    await guard(async () => {
      const scope = business.scopeKey;
      await businessApi('proxy/reminder-preferences', { ...next, scopeKey: business.scopeKey });
      if (scope !== business.scopeKey) return;
      preference.value = { ...next };
      ok = true;
    });
    return ok;
  }

  async function loadPreparation(): Promise<void> {
    await guard(async () => {
      const scope = business.scopeKey;
      const res = await businessApi<{ result: { text: string } }>('proxy/preparation-pack');
      if (scope !== business.scopeKey) return;
      preparation.value = res.result?.text ?? '';
    });
  }

  return {
    // state
    jobs,
    templates,
    timezone,
    preference,
    results,
    preparation,
    detail,
    plan,
    loading,
    busy,
    error,
    ready,
    // derived
    connected,
    activeCount,
    // actions
    load,
    loadDetail,
    closeDetail,
    requestPlan,
    confirmPlan,
    cancelPlan,
    toggle,
    runNow,
    archive,
    deleteJob,
    savePreference,
    loadPreparation,
    reset
  };
}
