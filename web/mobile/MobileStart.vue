<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {preferences} from '../preferences';import {t as tr} from '../i18n';
import {useSessionStore} from '../stores/session';import {useRunStore} from '../stores/run';import {useBusinessStore} from '../stores/business';
import type {useConversationController} from '../composables/useConversationController';
import type {Target} from '@shared/labops-targets.js';import UiIcon from '../components/UiIcon.vue';
const props=defineProps<{section?:string;controller:ReturnType<typeof useConversationController>}>(),emit=defineEmits<{navigate:[Target]}>();
const session=useSessionStore(),run=useRunStore(),business=useBusinessStore(),draft=ref(session.draftFor('__new'));
const mode=ref<'chat'|'task'>(props.section==='chat'?'chat':props.section==='work'?'task':preferences.value.defaultMode);
const busy=computed(()=>run.inputLocked||props.controller.submitting.value);
watch(()=>props.section,value=>{if(value)mode.value=value==='chat'?'chat':'task';});
watch(draft,value=>session.saveDraft('__new',value));
watch(()=>preferences.value.defaultMode,value=>{if(!props.section)mode.value=value;});
async function send(){if(!draft.value.trim()||busy.value)return;session.startDraft();await props.controller.submit(draft.value,mode.value);}
function key(event:KeyboardEvent){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void send();}}
/** U05：建议点击即发起（不再是回填草稿），失败可在会话内重试 */
async function ask(text:string){if(busy.value)return;session.startDraft();await props.controller.submit(text,mode.value);}
/** 身份驱动的开场与建议（U05）：志愿者偏值班/报修，管理员偏办理与查询 */
const identity=computed(()=>business.profile?.identity??'');
const greeting=computed(()=>business.profile?.username?business.profile.username+tr('，要处理什么实验室事务？'):tr('需要处理什么实验室事务？'));
const suggestions=computed(()=>identity.value==='volunteer'
 ?[{label:'开始值班',text:'开始今天的值班'},{label:'查实验室',text:'查找今天的空闲实验室'},{label:'准备报修',text:'我想报修实验室设备，请先列出需要提供的信息'}]
 :[{label:'查询课表',text:'查询今天的实验室课表'},{label:'查找空闲实验室',text:'查找今天的空闲实验室'},{label:'准备报修',text:'我想报修实验室设备，请先列出需要提供的信息'}]);
/** 最近会话卡（U05）：最多 3 条，点击直达 */
const recent=computed(()=>session.workConversations.slice(0,3));
</script>
<template><section class="mobile-start"><div class="mobile-start-intro"><UiIcon name="lab" :size="32"/><h1>{{tr(greeting)}}</h1></div>
<form class="mobile-start-composer" @submit.prevent="send"><label class="sr-only" for="mobile-question">{{tr('查询实验室，或准备办理工作…')}}</label><textarea id="mobile-question" v-model="draft" rows="3" maxlength="3000" :disabled="busy" :placeholder="tr('查询实验室，或准备办理工作…')" @keydown="key"/><div class="mobile-start-composer-row"><button type="button" class="mobile-start-mode" :aria-pressed="mode==='task'" :title="tr('工作模式：可查询并准备办理单')" @click="mode=mode==='task'?'chat':'task'"><UiIcon name="chevron" :size="12"/>{{tr(mode==='task'?'模式 · 工作':'模式 · 聊天')}}</button><button class="mobile-primary" :disabled="busy||!draft.trim()" type="submit"><UiIcon name="send"/>{{tr(busy?'生成中…':'发送')}}</button></div></form>
<p v-if="controller.error.value" role="alert">{{controller.error.value}}</p>
<div class="mobile-start-suggestions"><button v-for="item in suggestions" :key="item.label" :disabled="busy" @click="ask(item.text)"><UiIcon name="chevron" :size="14"/>{{tr(item.label)}}</button></div>
<div v-if="recent.length" class="mobile-start-recent"><h2>{{tr('最近会话')}}</h2><button v-for="c in recent" :key="c.id" class="mobile-start-recent-row" @click="emit('navigate',{view:'conversation',conversationId:c.id})"><b>{{c.title||tr('新会话')}}</b><span>{{c.preview||tr('尚未开始对话')}}</span><small>{{session.timeLabel(c.lastActivityAt)}}</small></button><button class="mobile-history-link" @click="emit('navigate',{view:'sessions',section:mode==='chat'?'chat':'work'})"><UiIcon name="history"/>{{tr('全部历史会话')}}</button></div>
<button v-else class="mobile-history-link" @click="emit('navigate',{view:'sessions',section:mode==='chat'?'chat':'work'})"><UiIcon name="history"/>{{tr('历史会话')}}</button>
</section></template>
