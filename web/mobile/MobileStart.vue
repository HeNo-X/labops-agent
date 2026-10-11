<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {preferences} from '../preferences';import {t as tr} from '../i18n';
import {useSessionStore} from '../stores/session';import {useRunStore} from '../stores/run';
import type {useConversationController} from '../composables/useConversationController';
import type {Target} from '@shared/labops-targets.js';import UiIcon from '../components/UiIcon.vue';
const props=defineProps<{section?:string;controller:ReturnType<typeof useConversationController>}>(),emit=defineEmits<{navigate:[Target]}>();
const session=useSessionStore(),run=useRunStore(),draft=ref(session.draftFor('__new'));
const mode=ref<'chat'|'task'>(props.section==='chat'?'chat':props.section==='work'?'task':preferences.value.defaultMode);
const busy=computed(()=>run.inputLocked||props.controller.submitting.value);
watch(()=>props.section,value=>{if(value)mode.value=value==='chat'?'chat':'task';});
watch(draft,value=>session.saveDraft('__new',value));
watch(()=>preferences.value.defaultMode,value=>{if(!props.section)mode.value=value;});
async function send(){if(!draft.value.trim()||busy.value)return;session.startDraft();await props.controller.submit(draft.value,mode.value);}
function key(event:KeyboardEvent){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void send();}}
const suggestions=[{label:'查询课表',text:'查询今天的实验室课表'},{label:'查找空闲实验室',text:'查找今天的空闲实验室'},{label:'准备报修',text:'我想报修实验室设备，请先列出需要提供的信息'}];
</script>
<template><section class="mobile-start"><div class="mobile-start-intro"><UiIcon name="lab" :size="32"/><h1>{{tr('需要处理什么实验室事务？')}}</h1></div><div class="mobile-segments mobile-start-modes" role="group" :aria-label="tr('默认会话模式')"><button :aria-pressed="mode==='task'" :class="{'mobile-primary':mode==='task'}" :disabled="busy" @click="mode='task'">{{tr('工作')}}</button><button :aria-pressed="mode==='chat'" :class="{'mobile-primary':mode==='chat'}" :disabled="busy" @click="mode='chat'">{{tr('聊天')}}</button></div><form class="mobile-start-composer" @submit.prevent="send"><label class="sr-only" for="mobile-question">{{tr('查询实验室，或准备办理工作…')}}</label><textarea id="mobile-question" v-model="draft" rows="3" maxlength="3000" :disabled="busy" :placeholder="tr('查询实验室，或准备办理工作…')" @keydown="key"/><button class="mobile-primary" :disabled="busy||!draft.trim()" type="submit"><UiIcon name="send"/>{{tr(busy?'生成中…':'发送')}}</button></form><p v-if="controller.error.value" role="alert">{{controller.error.value}}</p><div class="mobile-start-suggestions"><button v-for="item in suggestions" :key="item.label" :disabled="busy" @click="draft=item.text"><UiIcon name="chevron" :size="14"/>{{tr(item.label)}}</button></div><button class="mobile-history-link" @click="emit('navigate',{view:'sessions',section:mode==='chat'?'chat':'work'})"><UiIcon name="history"/>{{tr('历史会话')}}</button></section></template>
