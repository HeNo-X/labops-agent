<script setup lang="ts">
/**
 * 自动化创建/编辑器
 * ============================================================================
 *  设计目标：默认路径只要回答两件事 ——「做什么」和「多久一次」。
 *
 *     要做什么  [每日运营日报 ▾]   （带一句话说明，不用读懂参数名）
 *     多久一次  [每天][每周][仅一次][班次前]   + 时间
 *
 *  其余能力（接收人、参数、校历、Cron）通过「完整设置」渐进披露，一个都不删。
 *  ============================================================================
 *  ⚠️ 与主流 Agent APP 的一处**有意偏离**：
 *  它们的定时任务只服务自己，所以"一句话创建"可以直接落库；
 *  本系统的规则会**给真人投递站内通知**，所以保留"影响核对"这一步 ——
 *  但在界面上做成同一页里的一段，而不是像旧版那样"预览 → 再确认"两次跳转。
 */
import { computed, ref, watch } from 'vue';
import { t as tr } from '../../i18n';
import { autoRuleName, type ScheduledSpec } from '../../business/scheduled-form';
import params from '@shared/scheduled-params.json';
import { formatDateTime, triggerText } from '../../business/automation-format';
import type { AutomationPlan } from '../../composables/useAutomation';

const spec = defineModel<ScheduledSpec>({ required: true });

const props = defineProps<{
  templates: Record<string, string>;
  busy?: boolean;
  editing?: boolean;
  plan?: AutomationPlan | null;
  timezone?: string;
}>();

const emit = defineEmits<{ requestPlan: []; confirm: []; cancel: [] }>();

const applicable = params as Record<string, string[]>;

// A-Z：设置|历史页签（编辑已有规则时才有历史）
const tab = ref<'settings' | 'history'>('settings');
// ZCode 式调度：默认只是一行「+ 添加计划」，点击展开频率/时间/次数；编辑已有规则时默认展开。
// schedTouched=用户动过调度——动过之后折叠行显示节奏摘要，否则保持「+ 添加计划」
const schedOpen = ref(false);
const schedTouched = ref(false);
watch(schedOpen, (open) => { if (open && props.editing) schedTouched.value = true; });
watch(() => JSON.stringify([spec.value.trigger?.time, spec.value.trigger?.minutes, spec.value.trigger?.maxRuns, spec.value.trigger?.weekdays]), () => { if (schedOpen.value) schedTouched.value = true; });
function setParam(key: string, event: Event, numeric = false): void {
  const value = (event.target as HTMLInputElement).value;
  if (value === '') delete spec.value.params[key];
  else spec.value.params[key] = numeric ? Number(value) : value;
}
const PARAM_LABEL: Record<string, string> = {
  roomId: '房间编号（如 E310）',
  className: '班级名称',
  maxMissedHours: '错过补报窗口（小时，缺省 6）',
  thresholdHours: '工单超时阈值（小时）'
};
// A-Z2：指令未填 → 主按钮禁用变灰
const createDisabled = computed(() => isAgentTemplate.value && !String(spec.value.prompt ?? '').trim());
const schedSummary = computed(() => {
  if (schedOpen.value) return tr('收起调度设置');
  return schedTouched.value ? triggerText(spec.value) : tr('添加计划');
});
const isAgentTemplate = computed(() => spec.value.kind === 'agent_prompt');
const execMode = computed<'message' | 'agent'>(() => (spec.value.execMode === 'agent' ? 'agent' : 'message'));
const agentTools = computed<string[]>(() => (Array.isArray(spec.value.agentTools) ? spec.value.agentTools : []));
const DRAFT_TOOLS: Array<{ name: string; label: string }> = [
  { name: 'prepare_notification', label: '生成通知草稿（未连主系统时沙盒可用）' },
  { name: 'prepare_issue_ticket', label: '生成报修工单草稿（未连主系统时沙盒可用）' },
  { name: 'prepare_business_workflow', label: '原系统业务方案：通知发布 / 工单创建与流转等（连接主系统时可用；自主执行开启后到点直接提交）' }
];
function setExecMode(mode: 'message' | 'agent'): void {
  spec.value.execMode = mode;
  if (mode === 'message') {
    spec.value.agentTools = [];
    spec.value.autonomous = false; // 自主执行仅在 Agent 方式下有意义
  }
}
// B：自主执行勾选——第一次点只弹高危确认，二次点击才真正置位
const autonomyAsk = ref(false);
function toggleAutonomous(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.checked) {
    input.checked = false; // 等二次确认后再勾上
    autonomyAsk.value = true;
  } else {
    spec.value.autonomous = false;
  }
}
function confirmAutonomy(): void {
  spec.value.autonomous = true;
  autonomyAsk.value = false;
}
// 进入自定义指令模板时，三个额外动作默认全勾（用户可逐个取消）
watch(isAgentTemplate, (v) => { // immediate：startCreateWith 直接带 kind 打开时也要吃到默认勾选
  if (v && !Array.isArray(spec.value.agentTools)) spec.value.agentTools = DRAFT_TOOLS.map((t) => t.name);
}, { immediate: true });
function toggleTool(name: string): void {
  const set = new Set(agentTools.value);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  spec.value.agentTools = [...set];
}
const localError = ref('');

// A-G3（对标 ZCode：标题保留用户原话短语）：agent 模板的指令正文变化时，
// 规则名默认跟随原话前 16 字；用户在完整设置里改过名（nameTouched）就绝不覆盖。
const lastAutoName = ref('');
const nameTouched = ref(false);
watch(() => spec.value.prompt, (prompt) => {
  if (nameTouched.value) return;
  const next = autoRuleName(spec.value.kind, prompt, spec.value.name, lastAutoName.value, templateLabel.value);
  if (next) { lastAutoName.value = next; spec.value.name = next; }
});
watch(() => spec.value.name, (name) => {
  if (name !== undefined && name !== lastAutoName.value) { nameTouched.value = true; lastAutoName.value = name; }
});
// 换模板/换 spec（新建、编辑、模板切换都会整体替换）→ 重置跟踪基线
watch(spec, () => {
  nameTouched.value = false;
  lastAutoName.value = spec.value.name || templateLabel.value;
}, { immediate: true });
watch(() => spec.value.kind, () => { schedOpen.value = false; });

type SimpleTrigger = 'daily' | 'weekly' | 'once' | 'duty' | 'interval';
const TRIGGERS: Array<{ value: SimpleTrigger; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'interval', label: '每隔' },
  { value: 'once', label: '仅一次' },
  { value: 'duty', label: '班次前' }
];

const triggerType = computed<SimpleTrigger>(() => {
  const type = String(spec.value.trigger?.type ?? 'daily');
  return type === 'weekly' || type === 'once' || type === 'duty' || type === 'interval' ? type : 'daily';
});

// B/C：interval 的友好输入（数字 + 单位），落库统一为 minutes（15—10080）
const intervalMinutes = computed<number>({
  get: () => Number(spec.value.trigger?.['minutes'] ?? 30),
  set: (v: number) => { if (Number.isFinite(v)) spec.value.trigger = { type: 'interval', minutes: Math.max(15, Math.min(10080, Math.round(v))) }; }
});
// B：maxRuns 有限次（可选；留空=不限，到次自动停止并保留历史）
const maxRunsInput = computed<number | undefined>({
  get: () => (spec.value.trigger?.['maxRuns'] as number | undefined) ?? undefined,
  set: (v: number | undefined) => {
    const next = { ...spec.value.trigger } as Record<string, unknown>;
    if (v === undefined || Number.isNaN(v)) delete next['maxRuns'];
    else next['maxRuns'] = Math.max(1, Math.min(99, Math.round(v)));
    spec.value.trigger = next;
  }
});

const templateLabel = computed(() => props.templates[spec.value.kind] || spec.value.kind);
watch(() => props.editing, () => { tab.value = 'settings'; schedOpen.value = Boolean(props.editing); });

/** duty 触发只对值班类模板有意义，其它模板不显示这个选项 */
const availableTriggers = computed(() =>
  spec.value.kind === 'duty_reminder' ? TRIGGERS : TRIGGERS.filter((t) => t.value !== 'duty')
);

const onceLocal = computed({
  get(): string {
    const at = String(spec.value.trigger?.['at'] ?? '');
    if (!at) return '';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
      .format(d)
      .replace(' ', 'T');
  },
  set(value: string) {
    // 用户按北京时间输入 → 存 UTC ISO，避免夏令时/时区漂移
    spec.value.trigger = { type: 'once', at: value ? `${value}:00+08:00` : '' };
  }
});

const weekdayList = computed<number[]>(() => {
  const raw = spec.value.trigger?.['weekdays'];
  const list = Array.isArray(raw) ? raw.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  return list.length ? list : [1];
});



function setSimpleTrigger(type: SimpleTrigger): void {
  if (type === 'interval') { spec.value.trigger = { type: 'interval', minutes: Number(spec.value.trigger?.['minutes'] ?? 30) }; return; }
  const prev = spec.value.trigger ?? {};
  const time = String(prev['time'] ?? '20:30');
  if (type === 'daily') spec.value.trigger = { type: 'daily', time };
  else if (type === 'weekly') spec.value.trigger = { type: 'weekly', time, weekdays: weekdayList.value };
  else if (type === 'duty') spec.value.trigger = { type: 'duty', minutesBefore: Number(prev['minutesBefore'] ?? 30) };
  else spec.value.trigger = { type: 'once', at: String(prev['at'] ?? '') };
}

function toggleWeekday(day: number): void {
  const current = new Set(weekdayList.value);
  if (current.has(day)) current.delete(day);
  else current.add(day);
  if (!current.size) current.add(day); // 至少保留一天，避免产生一个永不触发的规则
  spec.value.trigger = { type: 'weekly', time: String(spec.value.trigger?.['time'] ?? '20:30'), weekdays: [...current].sort((a, b) => a - b) };
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 提交前端校验：把"必然失败的请求"挡在本地，省一次往返 */
function submit(): void {
  localError.value = '';
  if (!spec.value.kind) {
    localError.value = '请先选择要做的事';
    return;
  }
  if (!spec.value.name.trim()) spec.value.name = templateLabel.value;
  // B/C 客户端校验：把必然失败的请求挡在本地
  if (spec.value.kind === 'agent_prompt' && spec.value.trigger?.type === 'once' && spec.value.trigger.maxRuns !== undefined) { localError.value = '单次任务不需要 maxRuns'; return; }
  if (spec.value.trigger?.type === 'interval') { const m = Number(spec.value.trigger.minutes); if (!Number.isInteger(m) || m < 15 || m > 10080) { localError.value = '间隔应为 15—10080 分钟'; return; } }
  const mr = spec.value.trigger?.maxRuns;
  if (mr !== undefined && (!Number.isInteger(Number(mr)) || Number(mr) < 1 || Number(mr) > 99)) { localError.value = '最多运行次数应为 1—99 的整数'; return; }
  if (spec.value.kind === 'agent_prompt' && !String(spec.value.prompt ?? '').trim()) {
    localError.value = '请填写指令正文：到点要让 Agent 做什么';
    return;
  }
  const type = String(spec.value.trigger?.type ?? '');
  if (type === 'daily' && !/^\d{2}:\d{2}$/.test(String(spec.value.trigger?.['time'] ?? ''))) {
    localError.value = '请填写有效的运行时间（北京时间）';
    return;
  }
  if (type === 'once' && !spec.value.trigger?.['at']) {
    localError.value = '请填写仅一次运行的具体时间';
    return;
  }
  emit('requestPlan');
}

watch(
  () => props.plan,
  (value) => {
    if (value) localError.value = '';
  }
);
</script>

<template>
  <section class="auto-composer">
    <nav class="auto-crumb" :aria-label="tr('所在位置')">{{ tr('自动化') }} › {{ tr(editing ? '编辑定时任务' : '新建任务') }}</nav>
    <header class="auto-composer__head">
      <div class="auto-composer__headtext">
        <h2>{{ tr(editing ? '编辑定时任务' : '新建定时任务') }}</h2>
        <p class="auto-composer__sub">{{ tr('配置任务的执行时间、指令和运行方式。') }}</p>
      </div>
      <div v-if="editing" class="auto-tabs" role="tablist" :aria-label="tr('设置与历史')">
        <button type="button" role="tab" :aria-selected="tab === 'settings'" :class="{ 'is-on': tab === 'settings' }" :disabled="busy" @click="tab = 'settings'">{{ tr('设置') }}</button>
        <button type="button" role="tab" :aria-selected="tab === 'history'" :class="{ 'is-on': tab === 'history' }" :disabled="busy" @click="tab = 'history'">{{ tr('历史') }}</button>
      </div>
    </header>
    <p v-if="tab === 'history'" class="auto-note">{{ tr('运行历史在保存后开始累积；编辑完成后在列表点开这条规则即可看到完整历史与执行摘要。') }}</p>

    <!-- A-Z：ZCode 式三字段——任务标题 / 调度（默认折叠的「+ 添加计划」行）/ 指令（核心大输入） -->
    <div v-else class="auto-composer__simple">
      <label class="auto-field">
        <span class="auto-field__label">{{ tr('任务标题') }}</span>
        <input v-model="spec.name" maxlength="120" :disabled="busy" :placeholder="tr('未命名定时任务')">
      </label>

      <button type="button" class="auto-sched-row" :aria-expanded="schedOpen" :disabled="busy" @click="schedOpen = !schedOpen">
        <span class="auto-sched-row__plus" aria-hidden="true">+</span>
        <span>{{ schedOpen ? tr('收起调度设置') : schedSummary }}</span>
      </button>
      <div v-if="schedOpen" class="auto-sched-panel">
        <div class="auto-seg" role="radiogroup" :aria-label="tr('运行频率')">
          <button
            v-for="option in availableTriggers"
            :key="option.value"
            type="button"
            role="radio"
            :aria-checked="triggerType === option.value"
            :class="{ 'is-on': triggerType === option.value }"
            :disabled="busy"
            @click="setSimpleTrigger(option.value)"
          >
            {{ tr(option.label) }}
          </button>
        </div>

        <div class="auto-field__row">
          <label v-if="triggerType === 'interval'" class="auto-inline">
            <span>{{ tr('每隔') }}</span>
            <input v-model.number="intervalMinutes" type="number" min="15" max="10080" step="15" :disabled="busy" required />
            <span>{{ tr('分钟（15—10080）') }}</span>
          </label>
          <label v-if="triggerType === 'daily' || triggerType === 'weekly' || triggerType === 'interval'" class="auto-inline">
            <span>{{ tr('最多运行次数（可选）') }}</span>
            <input v-model.number="maxRunsInput" type="number" min="1" max="99" :disabled="busy" :placeholder="tr('不限')" />
          </label>
          <label v-if="triggerType === 'daily' || triggerType === 'weekly'" class="auto-inline">
            <span>{{ tr('北京时间') }}</span>
            <input v-model="spec.trigger.time" type="time" :disabled="busy" required />
          </label>

          <label v-if="triggerType === 'once'" class="auto-inline">
            <span>{{ tr('运行时间') }}</span>
            <input v-model="onceLocal" type="datetime-local" :disabled="busy" required />
          </label>

          <label v-if="triggerType === 'duty'" class="auto-inline">
            <span>{{ tr('提前') }}</span>
            <input v-model.number="spec.trigger.minutesBefore" type="number" min="0" max="120" :disabled="busy" />
            <span>{{ tr('分钟') }}</span>
          </label>
        </div>

        <div v-if="triggerType === 'weekly'" class="auto-weekdays" role="group" :aria-label="tr('星期')">
          <button
            v-for="(day, index) in WEEKDAY"
            :key="index"
            type="button"
            :aria-pressed="weekdayList.includes(index)"
            :class="{ 'is-on': weekdayList.includes(index) }"
            :disabled="busy"
            @click="toggleWeekday(index)"
          >
            {{ day }}
          </button>
        </div>

        <label v-if="triggerType === 'duty'" class="auto-note">{{ tr('正式值班提醒需工作人员账号，触发时间由排班决定。') }}</label>
      </div>

      <div class="auto-field auto-field--cmd">
        <span class="auto-field__label">{{ tr('指令') }}</span>
        <template v-if="isAgentTemplate">
          <textarea
            v-model="spec.prompt"
            class="auto-textarea auto-textarea--big"
            rows="6"
            maxlength="2000"
            :placeholder="tr('例如：每天早上查一下 E310 的课表，用一句话总结')"
          ></textarea>
          <div class="auto-chiprow">
            <div class="auto-seg auto-seg--chip" role="radiogroup" :aria-label="tr('执行方式')">
              <button type="button" role="radio" :aria-checked="execMode === 'message'" :class="{ 'is-on': execMode === 'message' }" :disabled="busy" @click="setExecMode('message')">{{ tr('只发消息') }}</button>
              <button type="button" role="radio" :aria-checked="execMode === 'agent'" :class="{ 'is-on': execMode === 'agent' }" :disabled="busy" @click="setExecMode('agent')">{{ tr('让 Agent 去做') }}</button>
            </div>
            <label v-if="execMode === 'agent'" class="auto-check auto-check--auto" :title="tr('勾选后 Agent 将不再等待你确认')">
              <input type="checkbox" :checked="spec.autonomous === true" :disabled="busy" @change="toggleAutonomous($event)">
              <span>{{ tr('允许 Agent 自主执行任务') }}</span>
            </label>
          </div>
          <fieldset v-if="execMode === 'agent'" class="auto-field auto-field--tools">
            <legend class="auto-field__label">{{ tr('额外允许的动作（默认只读）') }}</legend>
            <p class="auto-field__hint">{{ tr('默认已可查询课表、房间状态、本人签到状态与签到汇总（管理员）等只读工具；此处勾选用于追加草稿类动作。') }}</p>
            <label v-for="tool in DRAFT_TOOLS" :key="tool.name" class="auto-check">
              <input type="checkbox" :checked="agentTools.includes(tool.name)" :disabled="busy" @change="toggleTool(tool.name)">
              <span>{{ tr(tool.label) }}</span>
            </label>
          </fieldset>
        </template>
        <template v-else>
          <p class="auto-field__hint">{{ tr('固定模板：到点按模板生成并投递，参数如下（留空项按缺省口径）。') }}</p>
          <div class="auto-params">
            <label v-for="key in (applicable[spec.kind] || [])" :key="key" class="auto-inline">
              <span>{{ tr(PARAM_LABEL[key] || key) }}</span>
              <input
                :value="spec.params[key]"
                :type="key === 'maxMissedHours' || key === 'thresholdHours' ? 'number' : 'text'"
                :min="key === 'maxMissedHours' ? 1 : undefined"
                :max="key === 'maxMissedHours' ? 24 : undefined"
                maxlength="100"
                :disabled="busy"
                @input="setParam(key, $event, key === 'maxMissedHours' || key === 'thresholdHours')"
              >
            </label>
          </div>
          <p class="auto-field__hint">{{ tr('接收：本人账号；要发给其他人，可在会话里让 Agent 建并按提示选择收件人。') }}</p>
        </template>
      </div>

      <!-- A-Z：主按钮在指令框下方右侧；指令未填时禁用变灰（A-Z2） -->
      <div class="auto-actions auto-actions--end">
        <button
          type="button"
          class="auto-primary auto-primary--big"
          :disabled="busy || createDisabled"
          @click="submit"
        >
          {{ tr(editing ? '保存修改' : '创建定时任务') }}
        </button>
      </div>

      <p v-if="localError" class="auto-error" role="alert">{{ localError }}</p>
    </div>

    <!-- 影响核对：与表单同页，用户看到"会被通知谁、会在哪几次运行"后才落库 -->
          <!-- B：自主执行高危二次确认——第一次点勾选只弹窗，这里再点确认才真正勾上 -->
      <div v-if="autonomyAsk" class="auto-risk" role="alertdialog" aria-modal="true" :aria-label="tr('高危操作确认')" @click.self="autonomyAsk = false">
        <div class="auto-risk__box">
          <h3 class="auto-risk__title">{{ tr('⚠️ 高危操作：允许 Agent 自主执行') }}</h3>
          <p>{{ tr('勾选后，到点运行的 Agent 准备好方案后将直接提交原系统（如发布通知、创建或流转工单），不再等待你本人确认。') }}</p>
          <p>{{ tr('误操作可能影响真实业务数据。仅在你完全信任该任务指令、且清楚它会做什么时才开启。') }}</p>
          <div class="auto-risk__actions">
            <button type="button" :disabled="busy" @click="autonomyAsk = false">{{ tr('取消') }}</button>
            <button type="button" class="auto-danger" :disabled="busy" @click="confirmAutonomy">{{ tr('我已了解风险，确认开启') }}</button>
          </div>
        </div>
      </div>

    <section v-if="plan" class="auto-review" :aria-label="tr('影响核对')">
      <h3>{{ tr('确认后才会生效') }}</h3>
      <dl class="auto-review__grid">
        <div><dt>{{ tr('频率') }}</dt><dd>{{ tr(triggerText(plan.spec)) }}</dd></div>
        <div><dt>{{ tr('方案有效至') }}</dt><dd>{{ formatDateTime(plan.expiresAt) }}</dd></div>
      </dl>

      <h4>{{ tr('接下来会在这些时间运行') }}</h4>
      <ol v-if="plan.futureOccurrences?.length" class="auto-review__occ">
        <li v-for="item in plan.futureOccurrences.slice(0, 3)" :key="item.at">{{ item.local }}</li>
      </ol>
      <p v-else class="auto-review__warn">{{ tr('没有可用的未来触发时间 —— 请检查时间、正式排班或校历设置。') }}</p>

      <details v-if="plan.changes?.length" class="auto-review__diff">
        <summary>{{ tr('本次修改的字段') }}</summary>
        <div v-for="change in plan.changes" :key="change.field" class="auto-review__change">
          <b>{{ change.field }}</b>
          <pre>{{ JSON.stringify(change.before) }} → {{ JSON.stringify(change.after) }}</pre>
        </div>
      </details>

      <div class="auto-actions">
        <button type="button" class="auto-primary" :disabled="busy" @click="emit('confirm')">
          {{ tr(editing ? '确认保存' : '确认创建') }}
        </button>
        <button type="button" :disabled="busy" @click="emit('cancel')">{{ tr('返回修改') }}</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.auto-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--line, #dfe3e8);
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  background: var(--surface, #fff);
  color: inherit;
}
.auto-textarea:focus {
  outline: none;
  border-color: var(--primary, #1668dc);
  box-shadow: 0 0 0 3px var(--primary-weak, #eef4ff);
}
.auto-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.auto-check input {
  margin-top: 3px;
}
.auto-check input[type=checkbox] {
  width: 16px;
  min-height: 0;
  flex-shrink: 0;
  accent-color: var(--primary, #1668dc);
}
.auto-composer {
  display: grid;
  gap: 14px;
}
.auto-composer__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.auto-composer__head h2 {
  margin: 0;
  font-size: 15px;
  margin-right: auto;
}
.auto-link {
  background: none;
  border: 0;
  color: var(--primary);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
  padding: 6px 2px;
}
.auto-composer__simple {
  display: grid;
  gap: 14px;
}
.auto-field {
  display: grid;
  gap: 6px;
  border: 0;
  padding: 0;
  margin: 0;
}
.auto-field__label {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 600;
  padding: 0;
}
.auto-field select,
.auto-field input {
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  box-sizing: border-box;
}
.auto-field__hint {
  font-size: 12px;
  color: var(--text-faint);
  margin: 0;
  overflow-wrap: anywhere;
}
.auto-field__row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.auto-inline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}
.auto-inline input {
  width: auto;
  min-width: 120px;
}
.auto-seg {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  overflow: hidden;
  background: var(--surface-2);
  width: fit-content;
  max-width: 100%;
  flex-wrap: wrap;
}
.auto-seg button {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  min-height: 40px;
}
.auto-seg button.is-on {
  background: var(--primary);
  color: var(--primary-contrast);
}
.auto-weekdays {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.auto-weekdays button {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-muted);
  cursor: pointer;
  font: inherit;
}
.auto-weekdays button.is-on {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-contrast);
}
.auto-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.auto-actions button {
  min-height: 40px;
  padding: 8px 16px;
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
.auto-error {
  margin: 0;
  color: var(--danger, #b91c1c);
  font-size: 12px;
}
.auto-review {
  border: 1px solid var(--primary);
  border-radius: 10px;
  padding: 14px;
  background: var(--surface);
  display: grid;
  gap: 10px;
}
.auto-review h3 {
  margin: 0;
  font-size: 14px;
}
.auto-review h4 {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.auto-review__grid {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px 16px;
}
.auto-review__grid dt {
  font-size: 11px;
  color: var(--text-faint);
}
.auto-review__grid dd {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.auto-review__occ {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.auto-review__warn {
  margin: 0;
  font-size: 12px;
  color: var(--warning, #a16207);
}
.auto-review__sample summary,
.auto-review__diff summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
}
.auto-review__sample pre,
.auto-review__change pre {
  margin: 6px 0 0;
  padding: 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  max-height: 220px;
  overflow: auto;
}
.auto-review__change b {
  font-size: 12px;
}
@media (max-width: 640px) {
  .auto-review__grid {
    grid-template-columns: 1fr;
  }
  .auto-actions button {
    flex: 1 1 auto;
  }
}
</style>
<style scoped>
/* A-Z：ZCode 式创建页（面包屑 + 标题块 + 页签 + 右上主按钮） */
.auto-crumb { margin: 0 0 14px; color: var(--text-faint); font-size: calc(var(--ui-font-size) * 0.84615); }
.auto-composer__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.auto-composer__headtext h2 { margin: 0 0 4px; font-size: calc(var(--ui-font-size) * 1.3); }
.auto-composer__sub { margin: 0; color: var(--text-faint); font-size: calc(var(--ui-font-size) * 0.92308); }
.auto-composer__top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.auto-tabs { display: flex; gap: 2px; background: var(--surface-2, var(--surface)); border: 1px solid var(--border); border-radius: 999px; padding: 2px; }
.auto-tabs button { border: 0; background: transparent; border-radius: 999px; padding: 5px 16px; font: 600 calc(var(--ui-font-size) * 0.92308) var(--font-sans); color: var(--text-muted); cursor: pointer; }
.auto-tabs button.is-on { background: var(--primary); color: var(--primary-contrast, #fff); }
.auto-tabs button:disabled { opacity: .6; cursor: wait; }
.auto-composer__history-note { margin: 0 0 10px; }
.auto-composer__simple > .auto-field--sched { border: 1px solid var(--border); border-radius: var(--radius-lg, 12px); padding: 12px 14px; margin: 0 0 12px; }
.auto-composer__simple > .auto-field--sched > .auto-field__label { font-weight: 700; color: var(--text); }
@media(max-width: 640px) { .auto-composer__top { width: 100%; } }
</style>
<style scoped>
/* A-Z：ZCode 式调度折叠行与指令大输入 */
.auto-sched-row {
  display: flex; align-items: center; gap: 10px; width: 100%;
  border: 1px solid var(--border); border-radius: var(--radius, 10px);
  background: var(--surface-2, var(--surface)); color: var(--text-muted);
  padding: 11px 14px; cursor: pointer; font: calc(var(--ui-font-size) * 1.0) var(--font-sans);
  margin: 0 0 4px;
}
.auto-sched-row:hover { border-color: var(--border-strong, var(--primary)); color: var(--text); }
.auto-sched-row__plus { font-size: calc(var(--ui-font-size) * 1.15); color: var(--text-faint); }
.auto-sched-panel {
  border: 1px solid var(--border); border-radius: var(--radius, 10px);
  padding: 12px 14px; margin: 0 0 14px;
  display: flex; flex-direction: column; gap: 10px;
  background: var(--surface-2, var(--surface));
}
.auto-field--cmd { display: flex; flex-direction: column; gap: 6px; }
.auto-textarea--big { width: 100%; resize: vertical; line-height: 1.65; }
.auto-chiprow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.auto-check--auto { padding: 6px 12px; border: 1px dashed var(--border-strong); border-radius: 999px; }
.auto-check--auto input[type=checkbox] { width: 15px; height: 15px; margin-top: 0; }
.auto-risk { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
.auto-risk__box { background: var(--surface, #fff); color: var(--text, #111); max-width: 460px; width: 100%; border-radius: 14px; padding: 20px; display: grid; gap: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35); }
.auto-risk__title { margin: 0; font-size: 15px; color: var(--danger, #b91c1c); }
.auto-risk__box p { margin: 0; font-size: 13px; line-height: 1.6; }
.auto-risk__actions { display: flex; gap: 10px; justify-content: flex-end; }
.auto-risk__actions .auto-danger { background: var(--danger, #b91c1c); border-color: var(--danger, #b91c1c); color: #fff; }
.auto-seg--chip { display: inline-flex; gap: 2px; border: 1px solid var(--border); border-radius: 999px; padding: 2px; }
.auto-seg--chip button { border: 0; background: transparent; border-radius: 999px; padding: 4px 12px; font: calc(var(--ui-font-size) * 0.92308) var(--font-sans); color: var(--text-muted); cursor: pointer; }
.auto-seg--chip button.is-on { background: var(--primary); color: var(--primary-contrast, #fff); }
.auto-chip { display: inline-flex; align-items: center; padding: 4px 12px; border: 1px solid var(--border); border-radius: 999px; font-size: calc(var(--ui-font-size) * 0.84615); color: var(--text-muted); }
.auto-chip--note { border-style: dashed; }
.auto-params { display: flex; flex-wrap: wrap; gap: 10px; }
.auto-params .auto-inline { display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
.auto-params .auto-inline span { font-size: calc(var(--ui-font-size) * 0.84615); color: var(--text-muted); }
</style>
<style scoped>
/* A-Z2：指令框下方右侧的主按钮——圆角、稍大；禁用变灰 */
.auto-actions--end { justify-content: flex-end; margin-top: 4px; }
.auto-primary--big {
  border-radius: 12px;
  padding: 12px 28px;
  font-size: calc(var(--ui-font-size) * 1.07692);
  font-weight: 700;
}
.auto-primary--big:disabled { opacity: .45; cursor: not-allowed; }

/* 交互反馈补齐（2026-11-07） */
.auto-seg button:hover:not(.is-on),
.auto-weekdays button:hover {
  background: var(--surface-3);
  color: var(--text);
}
.auto-actions button:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: var(--primary-border);
  color: var(--primary);
}
.auto-seg button:active,
.auto-weekdays button:active,
.auto-actions button:active:not(:disabled) {
  background: var(--surface-2);
}
.auto-seg button:focus-visible,
.auto-weekdays button:focus-visible,
.auto-actions button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

</style>
