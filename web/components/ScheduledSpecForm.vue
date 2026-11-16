<script setup lang="ts">
import {t as tr} from "../i18n";
import {computed,ref} from 'vue';import {copySpec,changeTemplate,type ScheduledSpec} from '../business/scheduled-form';import params from '@shared/scheduled-params.json';import {useBusinessStore} from '../stores/business';
const spec=defineModel<ScheduledSpec>({required:true}),props=defineProps<{templates:Record<string,string>;busy?:boolean;editing?:boolean;stepwise?:boolean}>(),emit=defineEmits<{preview:[];cancel:[]}>(),business=useBusinessStore(),warning=ref(''),step=ref(1),applicable=params as Record<string,string[]>;
const has=(key:string)=>applicable[spec.value.kind]?.includes(key),trigger=computed(()=>String(spec.value.trigger.type));
function setTemplate(event:Event){const kind=(event.target as HTMLSelectElement).value,result=changeTemplate(spec.value,kind,applicable);spec.value=result.spec;warning.value=result.removed.length?'模板已改变，不适用的参数已移除：'+result.removed.join('、')+'。请核对预览差异。':'';}
function setTrigger(event:Event){const type=(event.target as HTMLSelectElement).value,previous=spec.value.trigger;spec.value={...copySpec(spec.value),trigger:type==='once'?{type,at:previous.at||''}:type==='weekly'?{type,time:previous.time||'20:30',weekdays:previous.weekdays||[1]}:type==='duty'?{type,minutesBefore:previous.minutesBefore??30}:type==='cron'?{type,expression:previous.expression||'30 20 * * *'}:{type,time:previous.time||'20:30'}};}
const once=computed({get:()=>spec.value.trigger.at?new Date(String(spec.value.trigger.at)).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).replace(' ','T').slice(0,16):'',set:v=>spec.value.trigger.at=v+':00+08:00'});
const inbox=computed({get:()=>spec.value.approvedEffects.includes('inbox'),set:yes=>spec.value.approvedEffects=yes?['report','inbox']:['report']});
const recipientKind=computed({get:()=>spec.value.recipients.length===1?spec.value.recipients[0]?.kind||'user':'existing',set:kind=>{if(kind==='existing')return;spec.value.recipients=[kind==='user'?{kind,userId:business.profile?.username||''}:kind==='role'?{kind,role:'volunteer'}:{kind,className:''}];}});
const recipientValue=computed({get:()=>{const r=spec.value.recipients[0]||{};return r.userId||r.role||r.className||'';},set:value=>{const r=spec.value.recipients[0];if(r)r[r.kind==='role'?'role':r.kind==='class'?'className':'userId']=value;}});
function setParam(key:string,event:Event,numeric=false){const value=(event.target as HTMLInputElement).value;if(value==='')delete spec.value.params[key];else spec.value.params[key]=numeric?Number(value):value;}
/** 接收对象的一句话摘要（管理员看的是"发给谁"，不是一堆 kind 字段） */
const ROLE_LABEL:Record<string,string>={admin:'管理员',volunteer:'志愿者',student:'学生'};
const recipientText=computed(()=>spec.value.recipients.map(r=>r.kind==='user'?r.userId:r.kind==='class'?'班级 '+r.className:'角色 '+(ROLE_LABEL[r.role]||r.role)).join('、')||'未选择');
const isAdmin=computed(()=>business.profile?.identity==='admin');
/** 有参数的模板才显示"适用范围"整段，避免空段落让人以为漏填 */
const hasParams=computed(()=>['roomId','className','thresholdHours','maxMissedHours'].some(k=>has(k)));
</script>

<template>
  <form class="spec-form" :novalidate="stepwise" @submit.prevent="emit('preview')">
    <ol v-if="stepwise" class="spec-steps" :aria-label="tr('规则设置步骤')">
      <li v-for="(label, index) in ['模板','时间与校历','参数范围','接收人与效果']" :key="label">
        <button type="button" :aria-current="step === index + 1 ? 'step' : undefined" @click="step = index + 1">
          {{ index + 1 }} {{ tr(label) }}
        </button>
      </li>
    </ol>

    <p v-if="warning" class="spec-warn">{{ warning }}</p>

    <!-- ① 做什么 ---------------------------------------------------------- -->
    <section v-show="!stepwise || step === 1" class="spec-section">
      <h4 class="spec-section__title">{{ tr('做什么') }}</h4>
      <div class="spec-grid">
        <label class="spec-field">
          <span class="spec-field__label">{{ tr('模板') }}</span>
          <select :aria-label="tr('模板')" :value="spec.kind" @change="setTemplate">
            <option v-for="(label, key) in templates" :key="key" :value="key">{{ tr(label) }}</option>
          </select>
        </label>
        <label class="spec-field">
          <span class="spec-field__label">{{ tr('名称') }}</span>
          <input v-model="spec.name" maxlength="120" :placeholder="tr('留空使用模板名称')">
        </label>
      </div>
    </section>

    <!-- ② 什么时候 -------------------------------------------------------- -->
    <section v-show="!stepwise || step === 2" class="spec-section">
      <h4 class="spec-section__title">{{ tr('什么时候运行') }}</h4>
      <div class="spec-grid">
        <label class="spec-field">
          <span class="spec-field__label">{{ tr('触发方式') }}</span>
          <select :value="trigger" :aria-label="tr('触发方式')" @change="setTrigger">
            <option value="daily">{{ tr('每天') }}</option>
            <option value="weekly">{{ tr('每周') }}</option>
            <option value="once">{{ tr('指定时间') }}</option>
            <option value="cron">{{ tr('高级 Cron（受限）') }}</option>
            <option v-if="spec.kind === 'duty_reminder'" value="duty">{{ tr('正式班次前') }}</option>
          </select>
        </label>

        <label v-if="trigger === 'daily' || trigger === 'weekly'" class="spec-field">
          <span class="spec-field__label">{{ tr('北京时间') }}</span>
          <input v-model="spec.trigger.time" type="time" required>
        </label>

        <label v-if="trigger === 'duty'" class="spec-field">
          <span class="spec-field__label">{{ tr('提前分钟') }}</span>
          <input v-model.number="spec.trigger.minutesBefore" type="number" min="0" max="120">
        </label>

        <label class="spec-field">
          <span class="spec-field__label">{{ tr('校历策略') }}</span>
          <select v-model="spec.calendarPolicy">
            <option value="all_days">{{ tr('每天 / 正式班次日期') }}</option>
            <option value="teaching_days">{{ tr('仅校历确认的教学日') }}</option>
          </select>
        </label>

        <label v-if="trigger === 'weekly'" class="spec-field spec-field--wide">
          <span class="spec-field__label">{{ tr('星期') }}</span>
          <select v-model="spec.trigger.weekdays" multiple size="3">
            <option v-for="(day, i) in ['周日','周一','周二','周三','周四','周五','周六']" :key="i" :value="i">{{ tr(day) }}</option>
          </select>
        </label>

        <label v-if="trigger === 'once'" class="spec-field spec-field--wide">
          <span class="spec-field__label">{{ tr('北京时间') }}</span>
          <input v-model="once" type="datetime-local" required>
        </label>

        <label v-if="trigger === 'cron'" class="spec-field spec-field--wide">
          <span class="spec-field__label">{{ tr('高级 Cron（分 时 * * 星期）') }}</span>
          <input v-model="spec.trigger.expression" required maxlength="40" placeholder="30 20 * * *">
        </label>
      </div>
    </section>

    <!-- ③ 适用范围 -------------------------------------------------------- -->
    <section v-show="(!stepwise || step === 3) && hasParams" class="spec-section">
      <h4 class="spec-section__title">{{ tr('适用范围') }}</h4>
      <p class="spec-section__hint">{{ tr('留空表示不限范围') }}</p>
      <div class="spec-grid">
        <label v-if="has('roomId')" class="spec-field">
          <span class="spec-field__label">{{ tr('房间编号（留空不限）') }}</span>
          <input :value="spec.params.roomId" maxlength="100" @input="setParam('roomId', $event)">
        </label>
        <label v-if="has('className')" class="spec-field">
          <span class="spec-field__label">{{ tr('班级名称（留空按授权范围）') }}</span>
          <input :value="spec.params.className" maxlength="100" @input="setParam('className', $event)">
        </label>
        <label v-if="has('thresholdHours')" class="spec-field">
          <span class="spec-field__label">{{ tr('人工授权处理时限（小时）') }}</span>
          <input :value="spec.params.thresholdHours" type="number" min="1" max="720" :placeholder="tr('留空则只按截止时间')" @input="setParam('thresholdHours', $event, true)">
        </label>
        <label class="spec-field">
          <span class="spec-field__label">{{ tr('允许停机补跑窗口（小时，默认 6）') }}</span>
          <input :value="spec.params.maxMissedHours" type="number" min="1" max="24" placeholder="6" @input="setParam('maxMissedHours', $event, true)">
        </label>
      </div>
    </section>

    <!-- ④ 发给谁 ---------------------------------------------------------- -->
    <section v-show="!stepwise || step === 4" class="spec-section">
      <h4 class="spec-section__title">{{ tr('发给谁') }}</h4>
      <div class="spec-grid">
        <label class="spec-field">
          <span class="spec-field__label">{{ tr('接收范围') }}</span>
          <select v-model="recipientKind" :aria-label="tr('接收范围')">
            <option value="user">{{ tr('本人 / 指定账号') }}</option>
            <option v-if="spec.recipients.length > 1" value="existing">{{ tr('保留原对象（多项）') }}</option>
            <template v-if="isAdmin">
              <option value="class">{{ tr('班级') }}</option>
              <option value="role">{{ tr('角色') }}</option>
            </template>
          </select>
        </label>
        <label v-if="isAdmin && recipientKind !== 'existing'" class="spec-field">
          <span class="spec-field__label">{{ tr('账号 / 班级 / 角色') }}</span>
          <input v-model="recipientValue" required>
        </label>
      </div>
      <p class="spec-summary">
        <span class="spec-summary__label">{{ tr('当前接收对象') }}</span>
        <b>{{ recipientText }}</b>
      </p>
      <label class="spec-check">
        <input v-model="inbox" type="checkbox">
        <span>{{ tr('保存结果并发送站内提醒') }}</span>
      </label>
    </section>

    <footer class="spec-actions">
      <template v-if="stepwise">
        <button v-if="step > 1" type="button" class="spec-btn" @click="step--">{{ tr('上一步') }}</button>
        <button v-if="step < 4" type="button" class="spec-btn spec-btn--primary" @click="step++">{{ tr('下一步') }}</button>
      </template>
      <button v-if="!stepwise || step === 4" class="spec-btn spec-btn--primary" :disabled="busy">
        {{ tr('预览未来时间和样例') }}
      </button>
      <button type="button" class="spec-btn" @click="emit('cancel')">{{ tr('取消') }}</button>
    </footer>
  </form>
</template>

<style scoped>
/* 分区纵向布局：每段一个问题，控件一行不超过两个。
   label 与控件分行排布：同一行内联在宽度不足时会挤乱。 */
.spec-form {
  display: grid;
  gap: 18px;
  font-size: 13px;
  color: var(--text, #1f2329);
}

.spec-steps {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  list-style: none;
}
.spec-steps button {
  border: 1px solid var(--line, #e3e6ea);
  background: var(--surface, #fff);
  color: var(--text-muted, #5b6470);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.spec-steps button[aria-current='step'] {
  border-color: var(--primary, #1668dc);
  color: var(--primary, #1668dc);
  background: var(--primary-weak, #eef4ff);
}

.spec-warn {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--warn-border, #f0d59a);
  background: var(--warn-bg, #fff8e6);
  color: var(--text, #1f2329);
  font-size: 12px;
  line-height: 1.5;
}

.spec-section {
  display: grid;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--line, #eef0f3);
}
.spec-section:first-of-type {
  padding-top: 0;
  border-top: 0;
}
.spec-section__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted, #5b6470);
}
.spec-section__hint {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--text-faint, #8a929e);
}

.spec-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 14px;
}
.spec-field {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.spec-field--wide {
  grid-column: 1 / -1;
}
.spec-field__label {
  font-size: 12px;
  color: var(--text-muted, #5b6470);
}
.spec-field input,
.spec-field select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 9px;
  border: 1px solid var(--line, #dfe3e8);
  border-radius: 8px;
  background: var(--surface, #fff);
  color: inherit;
  font-size: 13px;
  font-family: inherit;
}
.spec-field input:focus,
.spec-field select:focus {
  outline: none;
  border-color: var(--primary, #1668dc);
  box-shadow: 0 0 0 3px var(--primary-weak, #eef4ff);
}

.spec-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-2, #f6f8fa);
  font-size: 12px;
}
.spec-summary__label {
  color: var(--text-muted, #5b6470);
}

.spec-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.spec-check input {
  width: 15px;
  height: 15px;
  margin: 0;
}

.spec-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line, #eef0f3);
}
.spec-btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--line, #dfe3e8);
  background: var(--surface, #fff);
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}
.spec-btn--primary {
  border-color: var(--primary, #1668dc);
  background: var(--primary, #1668dc);
  color: var(--primary-contrast);
}
.spec-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 560px) {
  .spec-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .spec-actions {
    justify-content: stretch;
  }
  .spec-actions .spec-btn {
    flex: 1;
  }
}
</style>
