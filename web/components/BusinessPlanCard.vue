<script setup lang="ts">
import {t as tr} from "../i18n";
import ScheduledRuleCard from './business/ScheduledRuleCard.vue';
import {provide} from 'vue';
import type {BusinessResult} from '@shared/business';
import {createNativeBusinessCard,nativeCardKey} from '../business/controller';
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
  <div class="native-card__head"><b>{{tr(({schedule:'指定日期调课',duty:'正式班次与检查交接',issues:'真实报修与工单处理',notifications:'站内通知',report:'真实运营日报',closures:'原系统临时停用'} as Record<string,string>)[result.view||'']||'原系统任务')}}</b><span role="status">{{stage}}</span></div>
  <p class="native-card__source">{{result.source}} {{tr("· 查询时间")}} {{result.queriedAt}} · {{business.profile?.username}}</p>
  <p v-if="!sameScope" class="native-card__warn">{{tr("该卡属于其他账号、已断开或失效的授权范围。请连接账号后重新查询。")}}</p>
  <template v-else>
   <p v-if="task" class="native-card__source">{{tr("任务")}} {{task.id}} {{tr("· 修订")}} {{task.revision}}</p>
   <p v-if="draftWarning" class="native-card__warn">{{draftWarning}} <button v-if="pendingDraft" @click="restorePendingDraft">{{tr("核对后恢复本地草稿")}}</button></p>
   <ScheduleCard v-if="result.view==='schedule'"/><DutyCard v-if="result.view==='duty'"/><IssueCard v-if="result.view==='issues'"/><NoticeCard v-if="result.view==='notifications'"/><ClosureCard v-if="result.view==='closures'"/>
   <NativeIncidentCard v-if="result.view==='incidents'&&result.scopeKey" :scope-key="result.scopeKey" :incident-id="result.incident?.id" :task-id="result.taskId" :readonly="readonly"/>
   <div v-if="result.tasks"><p>{{tr("原系统任务")}} {{result.tasks.tasks.length}} {{tr("项 · 请从页面“我的工作”继续办理。")}}</p><p v-for="t in result.tasks.tasks" :key="t.id">{{t.id}} · {{t.kind}} · {{t.status}}</p></div>
   <NativeResourceHealthCard v-if="result.view==='health'&&result.scopeKey" :scope-key="result.scopeKey" :task-id="result.taskId" :readonly="readonly"/>
   <ScheduledRuleCard v-if="result.scheduledRule&&result.scopeKey" :plan="result.scheduledRule" :scope-key="result.scopeKey" :readonly="readonly"/>
   <NativeReportCard v-if="report" :report="report"/>
   <NativeConfirmation/>
   <button class="quiet" :disabled="busy" @click="perform(refresh)">{{tr("刷新原系统业务数据")}}</button>
  </template>
  <p v-if="error" class="native-card__warn" role="alert">{{error}}</p>
 </section>
</template>
<style>
.native-card{border:1px solid var(--border-strong);border-left:4px solid #138c83;border-radius:12px;padding:16px;background:var(--surface);font-size:calc(var(--ui-font-size) * 1.0);overflow-wrap:anywhere;min-width:0}.native-card__head{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.native-card__head span{margin-left:auto;color:#138c83}.native-card__source{font-size:calc(var(--ui-font-size) * 0.84615);color:var(--text-muted)}.native-card__warn{color:var(--danger);background:var(--surface-2);padding:10px;border-radius:8px}.native-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.native-form label{display:grid;gap:5px;color:var(--text-muted)}.native-form input,.native-form select,.native-form textarea{border:1px solid var(--border-strong);background:var(--surface-2);border-radius:6px;padding:9px;color:var(--text);width:100%;min-width:0;box-sizing:border-box;font:inherit}.native-form .wide{grid-column:1/-1}.native-form .check{display:flex;align-items:center;gap:5px}.native-form .check input{width:auto}.native-card button{background:#126e76;border:1px solid transparent;border-radius:7px;padding:9px 12px;color:white;cursor:pointer;font:inherit;white-space:normal}.native-card button:disabled{opacity:.5;cursor:default}.native-card .quiet{background:var(--surface-2);color:var(--text-muted);border-color:var(--border);margin-top:10px}.candidate-list{padding-left:20px;max-height:330px;overflow:auto}.candidate-list li{display:flex;gap:10px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);padding:10px 0}.candidate-list p{font-size:calc(var(--ui-font-size) * 0.92308);margin:5px 0;color:var(--text-muted)}.candidate-list button{flex-shrink:0}.excluded-list{max-height:200px;overflow:auto;font-size:calc(var(--ui-font-size) * 0.92308)}.object-row{padding:12px 0;border-bottom:1px solid var(--border)}.object-row p{margin:6px 0}.object-row details{font-size:calc(var(--ui-font-size) * 0.84615);color:var(--text-muted)}.native-confirm{background:var(--surface-2);padding:12px;border-radius:8px;margin-top:12px}.button-row{display:flex;gap:8px;flex-wrap:wrap}.native-receipt{padding:12px;background:var(--surface-2);border:1px solid #138c83;border-radius:8px;margin-top:10px}.native-receipt p{font-size:calc(var(--ui-font-size) * 0.92308)}@media(max-width:600px){.native-card{padding:12px}.candidate-list li{flex-direction:column;align-items:stretch}.native-form{grid-template-columns:minmax(0,1fr)}.button-row button{width:100%}.native-card__head span{margin-left:0}}
</style>
