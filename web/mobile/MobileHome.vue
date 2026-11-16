<script setup lang="ts">
import {t as tr} from "../i18n";
import {computed,onMounted,ref,watch} from 'vue';import {businessApi,useBusinessStore} from '../stores/business';import {useVisibleRefresh} from '../composables/useVisibleRefresh';import type {HomeSummary} from '@shared/mobile';import type {Target} from '@shared/labops-targets.js';import AsyncState from './AsyncState.vue';import UiIcon from '../components/UiIcon.vue';import {usePullRefreshRegistration} from './gestures';
const emit=defineEmits<{navigate:[Target]}>(),business=useBusinessStore(),data=ref<HomeSummary>(),loading=ref(true),error=ref(''),expanded=ref(false),queueSection=ref<HTMLElement>();let generation=0;
type QueueFilter='all'|'tasks'|'plans'|'handover';
type QueueItem={id:string;title:string;meta:string;status:string;category:'task'|'issue'|'plan'|'shift'|'handover';target:Target;disabled?:boolean};
const kinds:Record<string,string>={'issue.create':'报修','issue.action':'工单','duty.handover':'检查交接','duty.accept':'接收交接','schedule.move':'调课','closure.create':'停用','closure.revoke':'恢复开放','incident.bundle':'故障处置','roster.update':'名册班级'};
const states:Record<string,string>={awaiting_confirmation:'待确认',draft:'草稿',stale:'需重算',expired:'已过期',executed:'已提交',in_progress:'处理中',open:'待处理',processing:'处理中',resolved:'已完成'};
const isVolunteer=computed(()=>business.profile?.identity==='volunteer'),queueFilter=ref<QueueFilter>('all');
const queue=computed<QueueItem[]>(()=>{const d=data.value;if(!d)return [];const items:QueueItem[]=[];for(const t of d.tasks)items.push({id:'task:'+t.id,title:kinds[t.kind]||t.kind,meta:t.id,status:statusLabel(t.status),category:'task',target:{view:'task',taskId:t.id}});for(const i of d.issues)items.push({id:'issue:'+i.id,title:i.description,meta:tr('工单')+' '+i.id,status:statusLabel(i.status),category:'issue',target:{view:'room',roomId:i.roomId,action:'issues'}});for(const p of d.pendingPlans){const target:Target=p.taskId?{view:'task',taskId:p.taskId}:p.conversationId?{view:'conversation',conversationId:p.conversationId}:{view:'home'};items.push({id:'plan:'+p.id,title:kinds[p.kind]||p.kind,meta:p.id,status:tr('待确认'),category:'plan',target,disabled:!p.taskId&&!p.conversationId});}for(const s of d.shifts)items.push({id:'shift:'+s.id,title:s.roomId,meta:s.date+' · '+s.periodKey,status:tr('班次'),category:'shift',target:{view:'room',roomId:s.roomId,action:'duty'}});for(const h of d.handovers)items.push({id:'handover:'+h.id,title:tr('待接收'),meta:h.id,status:tr('交接'),category:'handover',target:{view:'room',roomId:h.roomId,action:'duty'}});return items;});
const queueCounts=computed(()=>({tasks:data.value?data.value.tasks.length+data.value.issues.length:0,plans:data.value?.pendingPlans.length||0,handover:data.value?data.value.shifts.length+data.value.handovers.length:0,total:queue.value.length}));
const filteredQueue=computed(()=>{const q=queue.value;if(queueFilter.value==='tasks')return q.filter(i=>i.category==='task'||i.category==='issue');if(queueFilter.value==='plans')return q.filter(i=>i.category==='plan');if(queueFilter.value==='handover')return q.filter(i=>i.category==='shift'||i.category==='handover');return q;});
const visibleQueue=computed(()=>expanded.value?filteredQueue.value:filteredQueue.value.slice(0,5)),hasMore=computed(()=>filteredQueue.value.length>5);
const filters=computed(()=>[{id:'all' as const,label:tr('全部'),count:queueCounts.value.total},{id:'tasks' as const,label:tr('待办'),count:queueCounts.value.tasks},{id:'plans' as const,label:tr('待确认'),count:queueCounts.value.plans},{id:'handover' as const,label:tr('交接'),count:queueCounts.value.handover}]);
const riskRooms=computed(()=>data.value?.risk?.suspendedRooms||[]),riskIssues=computed(()=>data.value?.risk?.unassignedIssues||[]),riskCount=computed(()=>riskRooms.value.length+riskIssues.value.length);
function statusLabel(value:string){return data.value?.states?.[value]||states[value]||value;}
function focusQueue(){queueSection.value?.scrollIntoView({block:'start'});}
watch(queueFilter,()=>{expanded.value=false;});
async function refresh(){const epoch=++generation,scope=business.scopeKey;try{const result=await businessApi<HomeSummary>('proxy/mobile-home');if(scope===business.scopeKey&&epoch===generation){data.value=result;error.value='';}}catch(e){if(epoch===generation)error.value=(e as Error).message;}finally{if(epoch===generation)loading.value=false;}}
onMounted(refresh);useVisibleRefresh(refresh);usePullRefreshRegistration('home',refresh);
</script>
<template><AsyncState :loading="loading" :error="error" @retry="refresh"><template v-if="data">
<section class="mobile-section m-home-hero">
<div class="m-home-hero-head"><span>{{data.date}}</span><span>{{data.actor.name}}</span></div>
<p class="m-home-hero-line">{{tr('今天要做')}} <b>{{queueCounts.total}}</b> {{tr('项')}}</p>
<div class="m-home-metrics"><div><b>{{queueCounts.tasks}}</b><span>{{tr('本人待办')}}</span></div><div><b>{{queueCounts.plans}}</b><span>{{tr('待确认')}}</span></div><div><b>{{queueCounts.handover}}</b><span>{{tr('班次与交接')}}</span></div></div>
<div class="mobile-actions"><button class="mobile-primary" :disabled="!queueCounts.total" @click="focusQueue">{{tr('开始处理')}}</button><button @click="emit('navigate',{view:'rooms'})">{{tr('查实验室')}}</button></div>
</section>
<section v-if="riskCount" class="mobile-section m-home-risk">
<header class="mobile-section-head"><h3>{{tr('待核实风险')}} <small>{{riskCount}}</small></h3></header>
<button v-for="r in riskRooms.slice(0,2)" :key="r.roomId" class="mobile-row" @click="emit('navigate',{view:'room',roomId:r.roomId})"><b>{{r.roomName}} <span class="mobile-pill is-warning">{{tr('服务停用')}}</span></b></button>
<button v-for="i in riskIssues.slice(0,1)" :key="i.id" class="mobile-row" @click="emit('navigate',{view:'room',roomId:i.roomId,action:'issues'})"><b>{{tr('未指派')}} · {{i.description}}</b><small>{{i.id}}</small></button>
</section>
<section v-if="queueCounts.total" ref="queueSection" class="mobile-section m-home-queue">
<header class="mobile-section-head"><h3>{{tr('今天要做')}} <small>{{filteredQueue.length}}</small></h3><button v-if="hasMore" @click="expanded=!expanded">{{tr(expanded?'收起':'查看全部')}}</button></header>
<nav class="m-home-filters" :aria-label="tr('待处理筛选')"><button v-for="f in filters" :key="f.id" :aria-pressed="queueFilter===f.id" @click="queueFilter=f.id">{{f.label}} {{f.count}}</button></nav>
<button v-for="item in visibleQueue" :key="item.id" class="mobile-row m-home-queue-row" :disabled="item.disabled" @click="emit('navigate',item.target)"><b>{{item.title}} <span class="mobile-pill">{{item.status}}</span></b><small>{{item.meta}}</small></button>
<p v-if="!filteredQueue.length" class="mobile-empty">{{tr('暂无待办')}}</p>
</section>
<section v-else class="mobile-section m-home-clear"><h3>{{tr('今天没有待办')}}</h3><p>{{tr('队列清爽。需要时可以直接查实验室，或开一个工作会话。')}}</p><div class="mobile-actions"><button @click="emit('navigate',{view:'rooms'})">{{tr('查实验室')}}</button><button class="mobile-primary" @click="emit('navigate',{view:'assistant',section:'work'})">{{tr('新建工作会话')}}</button></div></section>
<nav class="mobile-quick-grid m-home-quick" :aria-label="tr('工作快捷入口')"><button @click="emit('navigate',{view:'rooms'})"><UiIcon name="room"/>{{tr('查实验室')}}</button><template v-if="isVolunteer"><button @click="emit('navigate',{view:'rooms'})"><UiIcon name="clock"/>{{tr('值班与交接')}}</button><button @click="emit('navigate',{view:'assistant',section:'work'})"><UiIcon name="new"/>{{tr('报修/求助')}}</button></template><template v-else><button @click="emit('navigate',{view:'assistant',section:'work'})"><UiIcon name="new"/>{{tr('新建会话')}}</button><button @click="emit('navigate',{view:'rooms'})"><UiIcon name="clock"/>{{tr('值班与交接')}}</button></template><button @click="emit('navigate',{view:'automation'})"><UiIcon name="clock"/>{{tr('自动化')}}</button></nav>
<details class="mobile-source"><summary>{{tr('数据依据')}}</summary>{{tr('主系统授权查询 ·')}} {{data.queriedAt}} · {{data.sourceRevision.slice(0,12)}}</details>
</template></AsyncState></template>
