<script setup lang="ts">
import {t as tr} from "../i18n";
import {computed,nextTick,onMounted,onUnmounted,ref,watch} from 'vue';import {clientFetch} from '../client';import {actorHeaders} from '../actor';import {useSessionStore,type RoundEffects,type Round} from '../stores/session';import {useRunStore} from '../stores/run';import type {useConversationController} from '../composables/useConversationController';import ChatMessage from '../components/ChatMessage.vue';import RoundToolbar from '../components/RoundToolbar.vue';import {useVisibleRefresh} from '../composables/useVisibleRefresh';
import {useBusinessStore} from '../stores/business';import AsyncState from './AsyncState.vue';import {useFeedback} from './feedback';
import ComposerBar from '../components/ComposerBar.vue';
const props=defineProps<{conversationId:string;controller:ReturnType<typeof useConversationController>}>(),session=useSessionStore(),run=useRunStore(),feedback=useFeedback(),draft=ref(''),scroller=ref<HTMLElement>(),nearBottom=ref(true),newMessages=ref(false),error=ref(''),effects=ref<string[]>([]),roundBusy=ref(false);
const business=useBusinessStore();
/** 无 conversationId = 空会话态（打开即主会话区）：问候语 + 快捷胶囊都在这里 */
const isDraft=computed(()=>!props.conversationId);
const greeting=computed(()=>business.profile?.username?business.profile.username+tr('，要处理什么实验室事务？'):tr('需要处理什么实验室事务？'));
const suggestions=computed(()=>business.profile?.identity==='volunteer'
 ?[{label:'开始值班',text:'开始今天的值班'},{label:'查实验室',text:'查找今天的空闲实验室'},{label:'准备报修',text:'我想报修实验室设备，请先列出需要提供的信息'}]
 :[{label:'查询课表',text:'查询今天的实验室课表'},{label:'查找空闲实验室',text:'查找今天的空闲实验室'},{label:'准备报修',text:'我想报修实验室设备，请先列出需要提供的信息'}]);
/** 快捷胶囊只填入不发送 */
function fill(t:string):void{if(busy.value)return;draft.value=t;}
/**
 * L1 跨端状态共享（2026-11-07）：会话详情带回 activeRunId；不是本端发起的，
 * 说明另一台设备正在跑这一轮 → 横幅 + 停止入口 + 3 秒轮询收敛。只读，不重发消息。
 */
const externalRunId=computed(()=>{
  const id=props.conversationId;if(!id)return null;
  const active=session.activeRuns[id]||null;
  if(!active)return null;
  return active===run.runId?null:active;
});
let pollTimer:number|null=null;
function stopPoll(){if(pollTimer!==null){window.clearInterval(pollTimer);pollTimer=null;}}
watch(externalRunId,id=>{
  if(id&&pollTimer===null){
    pollTimer=window.setInterval(()=>{const cid=props.conversationId;if(cid)void session.syncConversation(cid);},3000);
  }
  if(!id)stopPoll();
},{immediate:true});
onUnmounted(stopPoll);
async function stopExternalRun():Promise<void>{
  const rid=externalRunId.value;if(!rid)return;
  await clientFetch('/api/runs/'+encodeURIComponent(rid)+'/cancel',{method:'POST',headers:actorHeaders()}).catch(()=>undefined);
  if(props.conversationId)void session.syncConversation(props.conversationId);
}
const mode=computed(()=>session.currentMode()),busy=computed(()=>run.inputLocked||props.controller.submitting.value||Boolean(session.activeRuns[props.conversationId]));
// A10：移动端模式开关——与会话页顶部的说明标签并排，点击即切（服务端已解锁，
// 模式随发送时刻生效、历史消息语义不变）；运行中/切换中禁用，失败走既有 error 行。
const switching=ref(false);
async function setMode(m:'chat'|'task'):Promise<void>{if(m===mode.value||switching.value||busy.value)return;switching.value=true;try{if(props.conversationId)await session.changeConversationMode(props.conversationId,m);}catch(e){error.value=(e as Error).message;}finally{switching.value=false;}}
async function load(){
  if(!props.conversationId){draft.value=session.draftFor('__new');return;}
  if(props.controller.activeConversation.value!==props.conversationId)await session.openConversation(props.conversationId);
  else session.saveCurrentId(props.conversationId);
  draft.value=session.draftFor(props.conversationId);
}
onMounted(load);watch(()=>props.conversationId,load);watch(draft,value=>session.saveDraft(props.conversationId,value));
useVisibleRefresh(()=>session.syncConversation(props.conversationId!),()=>Boolean(props.conversationId)&&props.controller.activeConversation.value!==props.conversationId);
function onScroll(){const e=scroller.value;if(e){nearBottom.value=e.scrollHeight-e.scrollTop-e.clientHeight<100;if(nearBottom.value)newMessages.value=false;}}
async function latest(){nearBottom.value=true;newMessages.value=false;await nextTick();if(scroller.value)scroller.value.scrollTop=scroller.value.scrollHeight;}
watch(()=>session.currentMessages.map(m=>m.text+m.status).join('|'),async()=>{if(nearBottom.value)await latest();else newMessages.value=true;});
async function send(){const text=draft.value;if(!text.trim()||busy.value)return;nearBottom.value=true;void props.controller.submit(text,mode.value);}
function describe(result:RoundEffects|undefined){if(!result)return [];return [...result.notes,...result.reverted.map(r=>'已回退沙盒对象 '+r.objectId),...result.rejectedPlans.map(id=>'已作废待确认方案 '+id),...result.supersededProposals.map(id=>'已作废待确认提案 '+id),...result.cancelledTasks.map(id=>'已取消任务 '+id),...result.notReverted.map(r=>'未回退 '+r.objectId+'：'+r.reason),...result.blocked.map(r=>'原系统已提交，需人工处理：'+r.planId+' '+r.objects.map(o=>o.id).join('、'))];}
async function remove(round:Round){if(busy.value||!round.userMessage)return;const ok=await feedback.confirmSheet({title:tr('删除本轮提问与回答？'),message:tr('作废未确认方案；已提交业务不会撤销。'),confirmLabel:tr('删除'),cancelLabel:tr('取消'),destructive:true});if(!ok)return;roundBusy.value=true;const result=await session.deleteRound(props.conversationId,round.userMessage.id);roundBusy.value=false;if(result.ok){
  effects.value=describe(result.effects);
  // 删空即删会话：已无任何轮次时自动删除，回到开始页（currentId 置空后 isDraft 生效）
  if(!session.currentRounds.length){
    try{await session.removeConversation(props.conversationId);}catch{ /* 会话已不在则忽略 */ }
    feedback.toast(tr('该会话已无消息，已自动删除'));
    return;
  }
  feedback.toast(tr('已删除本轮'));
}else error.value=result.message||'删除未成功';}
/**
 * 该轮是否牵涉业务办理（口径同 App.roundTouchesBusiness）：只看这一轮有没有产出
 * 业务单/原系统方案，不看结果 state（确认执行不会回写，避免把已执行轮误判为无业务）。
 */
function touchesBusiness(round:Round):boolean{
  return round.messages.some(m=>m.role==='assistant'&&m.toolCalls.some(t=>{
    if(t.resultKind==='operation_proposal')return Boolean(t.result);
    if(t.resultKind==='business_plan'){
      const res=t.result as {planId?:string|null;plan?:{state?:string}|null;receipt?:unknown}|null;
      return Boolean(res)&&Boolean(res!.planId||res!.receipt||res!.plan);
    }
    return false;
  }));
}
/** 内联「修改」：回档已在 ChatMessage 成功，展示回退结果后以 task 模式重发新内容 */
async function afterRoundEdit(payload:{userMessageId:string;text:string;revertEffects:boolean}):Promise<void>{
  // 回档在视图层执行（子组件点击即 emit，不能等它被卸载）
  roundBusy.value=true;
  const result=await session.rollbackRound(props.conversationId,payload.userMessageId,payload.revertEffects);
  roundBusy.value=false;
  if(!result.ok){error.value=result.message||'回档失败，内容未变化';return;}
  effects.value=describe(result.effects);
  error.value='';
  draft.value=payload.text;
  await props.controller.submit(payload.text,'task');
}
/** 内联「回档」：仅展示回退结果，不重发 */
async function afterRoundRewind(payload:{userMessageId:string;revertEffects:boolean}):Promise<void>{
  roundBusy.value=true;
  const result=await session.rollbackRound(props.conversationId,payload.userMessageId,payload.revertEffects);
  roundBusy.value=false;
  if(!result.ok){error.value=result.message||'回档失败，内容未变化';return;}
  effects.value=describe(result.effects);
  error.value='';
}
watch(()=>run.runStatus,value=>{if(value!=='running')draft.value=session.draftFor(props.conversationId);});
</script>
<template><div class="mobile-conversation"><div class="mobile-conversation-heading"><span class="m-mode-tag">{{tr(mode==='chat'?'查询与对话（不办理业务）':'可办理的工作对话')}}</span><div v-if="!isDraft" class="m-mode-switch" role="group" :aria-label="tr('会话模式')"><button type="button" class="m-mode-switch__opt" :class="{'is-active':mode==='task'}" :disabled="switching||busy" :aria-pressed="mode==='task'" @click="setMode('task')">{{tr('工作')}}</button><button type="button" class="m-mode-switch__opt" :class="{'is-active':mode==='chat'}" :disabled="switching||busy" :aria-pressed="mode==='chat'" @click="setMode('chat')">{{tr('聊天')}}</button></div></div><div ref="scroller" class="mobile-messages" @scroll.passive="onScroll"><p v-for="(line,i) in effects" :key="i" class="mobile-warning">{{line}}</p><p v-if="error||controller.error.value" role="alert">{{error||controller.error.value}}</p><div v-if="isDraft" class="mobile-empty"><p class="mobile-empty__hi">{{tr(greeting)}}</p><div class="mobile-start-quick"><button v-for="item in suggestions" :key="item.label" type="button" :disabled="busy" @click="fill(item.text)">{{tr(item.label)}}</button></div></div><AsyncState v-else :loading="session.messagesLoading" :error="session.currentMessagesError||''" @retry="session.syncConversation(conversationId)"><p v-if="!session.currentMessages.length" class="mobile-state">{{tr(mode==='chat'?'查询课表、房间状态或钥匙登记。':'查询实验室，或准备报修、交接和调课。')}}</p><article v-for="(round,index) in session.currentRounds" :key="round.key" class="mobile-round"><ChatMessage v-for="message in round.messages" :key="message.id" :msg="message" :can-rewind="mode==='task'" :busy="busy||roundBusy" :business-writes="touchesBusiness(round)" :can-delete="Boolean(round.userMessage)" @retry="draft=round.userMessage?.text||''" @round-delete="remove(round)" @round-edit="afterRoundEdit" @round-rewind="afterRoundRewind"/><RoundToolbar :index="index+1"/></article></AsyncState></div><div v-if="externalRunId" class="mobile-external-run" role="status"><span>{{tr('另一台设备正在生成这一轮…')}}</span><button type="button" @click="stopExternalRun">{{tr('停止这一轮')}}</button></div><button v-if="newMessages" class="mobile-new-messages" @click="latest">{{tr("有新消息 · 查看")}}</button><ComposerBar
      v-model:draft="draft"
      variant="mobile"
      input-id="mobile-question"
      :busy="busy"
      :disabled="Boolean(session.currentMessagesError)"
      :placeholder="mode==='chat'?'输入查询问题…':'输入要查询或办理的事项…'"
      @submit="send"
      @stop="controller.stop"
    />
    <!-- 回档/修改已改为气泡内联（InlineRoundEditor，见 ChatMessage），不再使用居中弹窗 -->
  </div></template>
<style scoped>
/* A10：会话模式开关——与说明标签同行右对齐，紧凑分段（左=工作/右=聊天） */
.mobile-conversation-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.m-mode-switch{display:flex;gap:2px;padding:2px;background:var(--m-tonal,var(--surface-3));border:1px solid var(--m-hairline,var(--border));border-radius:999px;flex-shrink:0}
.m-mode-switch__opt{border:0;background:transparent;border-radius:999px;padding:4px 12px;font:600 calc(var(--ui-font-size) * 0.84615) var(--font-sans);color:var(--text-muted);cursor:pointer;white-space:nowrap}
.m-mode-switch__opt.is-active{background:var(--primary);color:var(--primary-contrast,#fff)}
.m-mode-switch__opt:disabled{cursor:wait;opacity:.6}
</style>
