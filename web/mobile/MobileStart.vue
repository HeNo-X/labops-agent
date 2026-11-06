<script setup lang="ts">
import {computed,nextTick,ref,watch} from 'vue';
import {preferences} from '../preferences';import {t as tr} from '../i18n';
import {useSessionStore} from '../stores/session';import {useRunStore} from '../stores/run';import {useBusinessStore} from '../stores/business';
import type {useConversationController} from '../composables/useConversationController';
import type {Target} from '@shared/labops-targets.js';import UiIcon from '../components/UiIcon.vue';
import {useVoiceInput} from '../composables/useVoiceInput';import {useHoldToTalk} from '../composables/useHoldToTalk';import {useVoiceCorrection} from '../composables/useVoiceCorrection';import VoiceCorrectionBar from '../components/VoiceCorrectionBar.vue';import VoiceTermPanel from '../components/VoiceTermPanel.vue';
const props=defineProps<{section?:string;controller:ReturnType<typeof useConversationController>}>(),emit=defineEmits<{navigate:[Target]}>();
const session=useSessionStore(),run=useRunStore(),business=useBusinessStore(),draft=ref(session.draftFor('__new'));
// 长按说话（与桌面 CommandBar 共用同一组合式函数）：按住录音、松手识别回填
const voice=useVoiceInput();
const voiceFix=useVoiceCorrection(voice,draft);
// 与会话页同一套微信式交互：点麦克风进语音模式（输入框→整行语音条、麦克风→键盘键）
const voiceMode=ref(false),textareaRef=ref<HTMLTextAreaElement|null>(null);
const hold=useHoldToTalk({voice,onText:(recognized)=>{voiceFix.applyText(recognized);voiceMode.value=false;void nextTick(()=>textareaRef.value?.focus());}});
function enterVoice():void{if(busy.value||voice.working.value)return;voiceMode.value=true;}
function exitVoice():void{voiceMode.value=false;void nextTick(()=>textareaRef.value?.focus());}
const mode=ref<'chat'|'task'>(props.section==='chat'?'chat':props.section==='work'?'task':preferences.value.defaultMode);
const busy=computed(()=>run.inputLocked||props.controller.submitting.value);
watch(()=>props.section,value=>{if(value)mode.value=value==='chat'?'chat':'task';});
watch(draft,value=>session.saveDraft('__new',value));
watch(()=>preferences.value.defaultMode,value=>{if(!props.section)mode.value=value;});
async function send(){if(!draft.value.trim()||busy.value)return;session.startDraft();await props.controller.submit(draft.value,mode.value);}
function key(event:KeyboardEvent){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void send();}}
/** U05：建议点击即发起（不再是回填草稿），失败可在会话内重试 */
/** 快捷胶囊：只把内容填进输入框待用户确认，绝不替他直接发出去 */
function fill(text:string):void{if(busy.value)return;draft.value=text;void nextTick(()=>textareaRef.value?.focus());}
/** 身份驱动的开场与建议（U05）：志愿者偏值班/报修，管理员偏办理与查询 */
const identity=computed(()=>business.profile?.identity??'');
const greeting=computed(()=>business.profile?.username?business.profile.username+tr('，要处理什么实验室事务？'):tr('需要处理什么实验室事务？'));
/** 语音错误诚实提示（与 MobileConversation 同口径） */
const voiceHint=computed(()=>{const code=voice.errorCode.value;if(!code||code==='aborted')return '';const messages:Partial<Record<string,string>>={unsupported:tr('当前浏览器不支持录音'),insecure:tr('语音输入需要 HTTPS 或 localhost 环境'),denied:tr('麦克风权限被拒绝，请在浏览器地址栏允许后重试'),no_device:tr('未检测到可用麦克风'),busy:tr('已有录音在进行'),network:tr('网络异常，转写失败'),not_configured:tr('语音识别未配置：请在服务端 .env 设置 ASR_API_KEY'),rate_limited:tr('语音转写已达每小时配额，请稍后再试'),upstream:tr('识别服务暂不可用，请稍后重试'),empty:tr('没有听清，请靠近一点再说一次'),unknown:tr('语音识别失败，请重试')};return messages[code]||'';});
const suggestions=computed(()=>identity.value==='volunteer'
 ?[{label:'开始值班',text:'开始今天的值班'},{label:'查实验室',text:'查找今天的空闲实验室'},{label:'准备报修',text:'我想报修实验室设备，请先列出需要提供的信息'}]
 :[{label:'查询课表',text:'查询今天的实验室课表'},{label:'查找空闲实验室',text:'查找今天的空闲实验室'},{label:'准备报修',text:'我想报修实验室设备，请先列出需要提供的信息'}]);
</script>
<template><section class="mobile-start"><div class="mobile-start-mode-row" role="group" :aria-label="tr('会话模式')"><button type="button" class="mobile-start-mode" :aria-pressed="mode==='chat'" @click="mode='chat'">{{tr('聊天')}}</button><button type="button" class="mobile-start-mode" :aria-pressed="mode==='task'" @click="mode='task'">{{tr('工作')}}</button></div>
<div class="mobile-start-scroll">
<div class="mobile-start-intro"><span class="mobile-start-eyebrow">{{tr('实验室工作助手')}}</span><h1>{{tr(greeting)}}</h1></div>

</div>
<form class="mobile-start-composer" @submit.prevent="send"><div class="mobile-start-quick" role="group" :aria-label="tr('快捷输入')"><button v-for="item in suggestions" :key="item.label" type="button" :disabled="busy" @click="fill(item.text)">{{tr(item.label)}}</button></div>

<p class="mobile-start-mode-hint">{{tr(mode==='task'?'可查询并准备办理单':'只查询，不办理业务')}}</p>
<div v-if="voice.working.value" class="mobile-voice-bar" role="status" aria-live="polite"><span class="mobile-voice-dot" aria-hidden="true"></span><b>{{tr(voice.status.value==='transcribing'?'识别中…':voice.status.value==='requesting'?'等待麦克风…':'正在聆听')}}</b><span class="mobile-voice-time">{{Math.floor(voice.seconds.value)}}s / 60s</span><button type="button" @click="hold.cancel">{{tr('取消')}}</button></div>
<div class="mobile-start-input-row"><label class="sr-only" for="mobile-question">{{tr('查询实验室，或准备办理工作…')}}</label><button v-if="voice.supported.value&&!voiceMode" type="button" class="mobile-mic" :disabled="busy" :aria-label="tr('语音输入')" @click="enterVoice"><UiIcon name="mic"/></button><button v-else-if="voice.supported.value&&voiceMode" type="button" class="mobile-mic" :disabled="busy" :aria-label="tr('切换到键盘')" @click="exitVoice"><UiIcon name="keyboard"/></button><button v-if="voiceMode" type="button" class="mobile-speak" :class="{'is-recording':voice.status.value==='recording','is-sliding':hold.sliding.value}" :disabled="busy" v-on="hold.handlers"><span>{{tr(hold.sliding.value?'松开取消':voice.status.value==='recording'?'松开结束':'按住 说话')}}</span></button><textarea v-else ref="textareaRef" id="mobile-question" v-model="draft" rows="2" maxlength="3000" :disabled="busy||voice.working.value" :placeholder="voice.working.value?tr('正在聆听，松手结束…'):tr('查询实验室，或准备办理工作…')" @keydown="key"/><button v-if="!voiceMode" class="mobile-primary" :disabled="busy||!draft.trim()" type="submit"><UiIcon name="send"/>{{tr(busy?'生成中…':'发送')}}</button></div>
<p v-if="controller.error.value" class="mobile-start-error" role="alert">{{controller.error.value}}</p>
<p v-if="voiceHint" class="mobile-voice-hint" role="alert">{{voiceHint}}</p>
<VoiceCorrectionBar :corrections="voice.lastCorrections.value" :original-text="voiceFix.originalText.value" :suppressed="voiceFix.suppressed.value" @restore="voiceFix.restore" @suppress="voiceFix.suppress" @unsuppress="voiceFix.unsuppress"/><VoiceTermPanel v-if="voice.supported.value" :bias="voice.lastBias.value" :protocol="voice.lastProtocol.value"/>
</form>
</section></template>
