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
import { changeTemplate, type ScheduledSpec } from '../../business/scheduled-form';
import params from '@shared/scheduled-params.json';
import { calendarText, effectsText, formatDateTime, kindHint, recipientsText, triggerText } from '../../business/automation-format';
import ScheduledSpecForm from '../ScheduledSpecForm.vue';
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
const advanced = ref(false);
const localError = ref('');

type SimpleTrigger = 'daily' | 'weekly' | 'once' | 'duty';
const TRIGGERS: Array<{ value: SimpleTrigger; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'once', label: '仅一次' },
  { value: 'duty', label: '班次前' }
];

const triggerType = computed<SimpleTrigger>(() => {
  const type = String(spec.value.trigger?.type ?? 'daily');
  return type === 'weekly' || type === 'once' || type === 'duty' ? type : 'daily';
});

const hint = computed(() => kindHint(spec.value.kind));
const templateLabel = computed(() => props.templates[spec.value.kind] || spec.value.kind);

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

function setTemplate(event: Event): void {
  const kind = (event.target as HTMLSelectElement).value;
  const result = changeTemplate(spec.value, kind, applicable);
  const next = result.spec;
  // 模板名作为默认规则名，让用户不必先想名字 —— 主流 APP 的做法
  if (!spec.value.name.trim()) next.name = props.templates[kind] || kind;
  // 切到非值班模板时，若原来是 duty 触发则回到 daily
  if (next.trigger?.type === 'duty' && kind !== 'duty_reminder') next.trigger = { type: 'daily', time: '20:30' };
  spec.value = next;
}

function setSimpleTrigger(type: SimpleTrigger): void {
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
    <header class="auto-composer__head">
      <h2>{{ tr(editing ? '编辑自动化' : '新建自动化') }}</h2>
      <button type="button" class="auto-link" @click="advanced = !advanced">
        {{ tr(advanced ? '改用简明设置' : '完整设置') }}
      </button>
    </header>

    <!-- 完整设置：保留旧版全部字段，一个都不删，只是不再默认展示 -->
    <div v-if="advanced" class="auto-composer__advanced">
      <ScheduledSpecForm
        v-model="spec"
        :templates="templates"
        :busy="busy"
        :editing="editing"
        @preview="submit"
        @cancel="emit('cancel')"
      />
    </div>

    <!-- 简明设置：主流 Agent APP 的默认路径 -->
    <div v-else class="auto-composer__simple">
      <label class="auto-field">
        <span class="auto-field__label">{{ tr('要做什么') }}</span>
        <select :value="spec.kind" :disabled="busy" @change="setTemplate">
          <option v-for="(label, key) in templates" :key="key" :value="key">{{ tr(label) }}</option>
        </select>
        <small class="auto-field__hint">{{ tr(hint) }}</small>
      </label>

      <fieldset class="auto-field auto-field--trigger">
        <legend class="auto-field__label">{{ tr('多久一次') }}</legend>
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

        <p class="auto-field__hint">
          {{ tr('日历') }}：{{ tr(calendarText(spec.calendarPolicy)) }} ·
          {{ tr('接收') }}：{{ tr(recipientsText(spec.recipients)) }}
        </p>
      </fieldset>

      <p v-if="localError" class="auto-error" role="alert">{{ localError }}</p>

      <div class="auto-actions">
        <button type="button" class="auto-primary" :disabled="busy" @click="submit">
          {{ tr(editing ? '查看影响并保存' : '查看影响并创建') }}
        </button>
        <button type="button" :disabled="busy" @click="emit('cancel')">{{ tr('取消') }}</button>
      </div>
    </div>

    <!-- 影响核对：与表单同页，用户看到"会被通知谁、会在哪几次运行"后才落库 -->
    <section v-if="plan" class="auto-review" :aria-label="tr('影响核对')">
      <h3>{{ tr('确认后才会生效') }}</h3>
      <dl class="auto-review__grid">
        <div><dt>{{ tr('规则') }}</dt><dd>{{ plan.spec.name || templateLabel }}</dd></div>
        <div><dt>{{ tr('频率') }}</dt><dd>{{ tr(triggerText(plan.spec)) }}</dd></div>
        <div><dt>{{ tr('接收') }}</dt><dd>{{ tr(recipientsText(plan.spec.recipients)) }}</dd></div>
        <div><dt>{{ tr('效果') }}</dt><dd>{{ tr(effectsText(plan.effects)) }}</dd></div>
        <div><dt>{{ tr('时区') }}</dt><dd>{{ plan.spec.timezone || timezone || 'Asia/Shanghai' }}</dd></div>
        <div><dt>{{ tr('方案有效至') }}</dt><dd>{{ formatDateTime(plan.expiresAt) }}</dd></div>
      </dl>

      <h4>{{ tr('接下来会在这些时间运行') }}</h4>
      <ol v-if="plan.futureOccurrences?.length" class="auto-review__occ">
        <li v-for="item in plan.futureOccurrences.slice(0, 3)" :key="item.at">{{ item.local }}</li>
      </ol>
      <p v-else class="auto-review__warn">{{ tr('没有可用的未来触发时间 —— 请检查时间、正式排班或校历设置。') }}</p>

      <details v-if="plan.sample?.text" class="auto-review__sample">
        <summary>{{ tr('看看输出长什么样') }}</summary>
        <pre>{{ plan.sample.text }}</pre>
      </details>

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
  color: #fff;
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
  color: #fff;
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
  color: #fff !important;
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
