<script setup lang="ts">
import {t as tr} from "../i18n";
import ScheduledRuleCard from './business/ScheduledRuleCard.vue';
import {provide} from 'vue';
import type {BusinessResult} from '@shared/business';
import {createNativeBusinessCard,nativeCardKey} from '../business/controller';
import {formatDateTime} from '../business/automation-format';
import ScheduleCard from './business/ScheduleCard.vue';
import DutyCard from './business/DutyCard.vue';
import IssueCard from './business/IssueCard.vue';
import NoticeCard from './business/NoticeCard.vue';
import ClosureCard from './business/ClosureCard.vue';
import NativeResourceHealthCard from './business/NativeResourceHealthCard.vue';
import NativeIncidentCard from './business/NativeIncidentCard.vue';
import NativeReportCard from './business/NativeReportCard.vue';
import NativeConfirmation from './business/NativeConfirmation.vue';
const props=defineProps<{result:BusinessResult;cardId:string;readonly?:boolean}>();
const controller=createNativeBusinessCard(props);provide(nativeCardKey,controller);
const {business,sameScope,stage,error,busy,perform,refresh,task,report,draftWarning,pendingDraft,restorePendingDraft}=controller;
</script>
<template>
 <section class="native-card" :data-view="result.view" :aria-label="tr('原系统业务任务卡')">
  <div class="native-card__head"><b>{{tr(({schedule:'指定日期调课',duty:'正式班次与检查交接',issues:'真实报修与工单处理',notifications:'站内通知',report:'真实运营日报',closures:'原系统临时停用',checkin:'管理员代录签到',roster:'名册与班级归属'} as Record<string,string>)[result.view||'']||'原系统任务')}}</b><span role="status">{{stage}}</span></div>
       <details class="card__more"><summary>说明</summary>
  <p class="native-card__source">{{result.source}} {{tr("· 查询时间")}} {{formatDateTime(result.queriedAt)}} · {{business.profile?.username}}</p>
       </details>
  <p v-if="!sameScope" class="native-card__warn">{{tr("该卡属于其他账号、已断开或失效的授权范围。请连接账号后重新查询。")}}</p>
  <template v-else>
       <details class="card__more"><summary>说明</summary>
   <p v-if="task" class="native-card__source">{{tr("任务")}} {{task.id}} {{tr("· 修订")}} {{task.revision}}</p>
       </details>
   <p v-if="draftWarning" class="native-card__warn">{{draftWarning}} <button v-if="pendingDraft" @click="restorePendingDraft">{{tr("核对后恢复本地草稿")}}</button></p>
   <ScheduleCard v-if="result.view==='schedule'"/><DutyCard v-if="result.view==='duty'"/><IssueCard v-if="result.view==='issues'"/><NoticeCard v-if="result.view==='notifications'"/><ClosureCard v-if="result.view==='closures'"/>
   <NativeIncidentCard v-if="result.view==='incidents'&&result.scopeKey" :scope-key="result.scopeKey" :incident-id="result.incident?.id" :task-id="result.taskId" :readonly="readonly"/>
   <div v-if="result.tasks"><p>{{tr("原系统任务")}} {{result.tasks.tasks.length}} {{tr("项 · 请从页面“我的工作”继续办理。")}}</p><p v-for="t in result.tasks.tasks" :key="t.id">{{t.kind}} · {{t.status}}</p></div>
   <NativeResourceHealthCard v-if="result.view==='health'&&result.scopeKey" :scope-key="result.scopeKey" :task-id="result.taskId" :readonly="readonly"/>
   <ScheduledRuleCard v-if="result.scheduledRule&&result.scopeKey" :plan="result.scheduledRule" :scope-key="result.scopeKey" :readonly="readonly"/>
   <NativeReportCard v-if="report" :report="report"/>
   <div v-if="result.view==='checkin'&&result.plan" class="native-confirm">
    <p><b>{{ result.plan.payload.targetUsername }}</b><template v-if="result.plan.payload.className">（{{ result.plan.payload.className }}）</template> · {{ result.plan.payload.date }} · {{ ({am1:'上午第一大节',am2:'上午第二大节',pm1:'下午第一大节',pm2:'下午第二大节',eve_ab:'晚上AB节',eve_cd:'晚上CD节'} as Record<string,string>)[result.plan.payload.periodKey||''] || result.plan.payload.periodKey }} · {{ result.plan.payload.labName || result.plan.payload.labId }} · 《{{ result.plan.payload.courseName || tr('未录入') }}》</p>
    <p>{{ tr('代录原因：') }}{{ result.plan.payload.reason }}</p>
       <details class="card__more"><summary>说明</summary>
    <p class="native-card__source">{{ tr('提交后记录标记 agent-manual，写入审计（代录人与原因）；时间以服务器为准。') }}</p>
       </details>
   </div>
   <div v-if="result.view==='roster'&&result.plan" class="native-confirm">
    <p><b>{{ result.plan.payload.targetName || tr('未命名账号') }}</b> · {{ result.plan.payload.accountMasked }} · {{ tr('班级归属') }} <b>{{ result.plan.payload.beforeClassName || tr('（未登记）') }}</b> → <b>{{ result.plan.payload.afterClassName }}</b></p>
    <p>{{ tr('变更依据：') }}{{ result.plan.payload.reason }}</p>
       <details class="card__more"><summary>说明</summary>
    <p class="native-card__source">{{ result.plan.payload.rosterRowPresent ? tr('名册对正表有该学号行：账号档案、名册行与班级人数一并更新。') : tr('名册对正表没有该学号行：不新建名册行，班级按账号档案生效，班级人数统计不变。') }}</p>
       </details>
       <details class="card__more"><summary>说明</summary>
    <p class="native-card__source">{{ tr('提交后写入审计（操作人、时间、改前→改后、依据）；学号原值不回传，时间以服务器为准。') }}</p>
       </details>
   </div>
   <NativeConfirmation/>
   <button class="quiet" :disabled="busy" @click="perform(refresh)">{{tr("刷新原系统业务数据")}}</button>
  </template>
  <p v-if="error" class="native-card__warn" role="alert">{{error}}</p>
 </section>
</template>
<style>
.native-card{border:1px solid var(--border-strong);border-left:4px solid var(--primary);border-radius:12px;padding:16px;background:var(--surface);font-size:calc(var(--ui-font-size) * 1.0);overflow-wrap:anywhere;min-width:0}.native-card__head{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.native-card__head span{margin-left:auto;color:var(--primary)}.native-card__source{font-size:calc(var(--ui-font-size) * 0.84615);color:var(--text-muted)}.native-card__warn{color:var(--danger);background:var(--surface-2);padding:10px;border-radius:8px}.native-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.native-form label{display:grid;gap:5px;color:var(--text-muted)}.native-form input,.native-form select,.native-form textarea{border:1px solid var(--border-strong);background:var(--surface-2);border-radius:6px;padding:9px;color:var(--text);width:100%;min-width:0;box-sizing:border-box;font:inherit}.native-form .wide{grid-column:1/-1}.native-form .check{display:flex;align-items:center;gap:5px}.native-form .check input{width:auto}.native-card button{background:var(--primary);border:1px solid transparent;border-radius:7px;padding:9px 12px;color:white;cursor:pointer;font:inherit;white-space:normal}.native-card button:disabled{opacity:.5;cursor:default}.native-card .quiet{background:var(--surface-2);color:var(--text-muted);border-color:var(--border);margin-top:10px}.candidate-list{padding-left:20px;max-height:330px;overflow:auto}.candidate-list li{display:flex;gap:10px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);padding:10px 0}.candidate-list p{font-size:calc(var(--ui-font-size) * 0.92308);margin:5px 0;color:var(--text-muted)}.candidate-list button{flex-shrink:0}.excluded-list{max-height:200px;overflow:auto;font-size:calc(var(--ui-font-size) * 0.92308)}.object-row{padding:12px 0;border-bottom:1px solid var(--border)}.object-row p{margin:6px 0}.object-row details{font-size:calc(var(--ui-font-size) * 0.84615);color:var(--text-muted)}.native-confirm{background:var(--surface-2);padding:12px;border-radius:8px;margin-top:12px}.button-row{display:flex;gap:8px;flex-wrap:wrap}.native-receipt{padding:12px;background:var(--surface-2);border:1px solid var(--primary);border-radius:8px;margin-top:10px}.native-receipt p{font-size:calc(var(--ui-font-size) * 0.92308)}@media(max-width:600px){.native-card{padding:12px}.candidate-list li{flex-direction:column;align-items:stretch}.native-form{grid-template-columns:minmax(0,1fr)}.button-row button{width:100%}.native-card__head span{margin-left:0}}
</style>
