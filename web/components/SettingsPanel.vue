<script setup lang="ts">
import {isInstalledClient} from '../client';
const installed=isInstalledClient();
import {ref,computed,onMounted,onUnmounted} from 'vue';
import {preferences,updatePreferences,resetPreferences,preferenceError,mobile} from '../preferences';
import {UI_SCALES,type Preferences} from '../preferences/schema';
import {t as tr} from '../i18n';import {useBusinessStore} from '../stores/business';import {useRunStore} from '../stores/run';import UiIcon from './UiIcon.vue';
import VoiceTermPanel from './VoiceTermPanel.vue';
import NativeWorkPanel from './NativeWorkPanel.vue';
import EvidencePanel from './EvidencePanel.vue';
import NativeIncidentCard from './business/NativeIncidentCard.vue';
const props=withDefaults(defineProps<{category?:string;showBack?:boolean;taskMode?:boolean}>(),{category:'personalization',showBack:false,taskMode:true}),emit=defineEmits<{edition:[];logout:[];back:[];launch:[action:string]}>();
const CATEGORIES=['personalization','general','account'];
const allowed=[...CATEGORIES,'advanced',...(!mobile?['work']:[])];
const category=ref(allowed.includes(props.category||'')?(props.category as string):'personalization');
const business=useBusinessStore(),run=useRunStore();
const categories=[{id:'personalization',label:'个性化',icon:'palette'},{id:'general',label:'常规',icon:'settings'},...(!mobile?[{id:'work',label:'工作',icon:'work'}]:[]),...(installed?[{id:'advanced',label:'高级设置',icon:'panel'}]:[]),{id:'account',label:'账户',icon:'user'}];
const accents=[{id:'neutral',label:'中性',color:'#525252'},{id:'blue',label:'蓝色',color:'#1d4ed8'},{id:'green',label:'绿色',color:'#166534'},{id:'purple',label:'紫色',color:'#6d28d9'},{id:'amber',label:'琥珀',color:'#92400e'}];
function change(key:keyof Preferences,event:Event,kind:'string'|'number'|'boolean'='string'){const el=event.target as HTMLInputElement;updatePreferences({[key]:kind==='number'?Number(el.value):kind==='boolean'?el.checked:el.value} as Partial<Preferences>);}
// ---- 主题：自定义下拉（触发器 + 菜单，风格对齐设置面板）----
const themeOpen=ref(false),themeBox=ref<HTMLElement>();
const themeOptions=[{id:'auto',label:'跟随系统'},{id:'light',label:'浅色'},{id:'dark',label:'深色'}] as const;
const themeLabel=computed(()=>themeOptions.find(o=>o.id===preferences.value.theme)?.label||'跟随系统');
function setTheme(id:'auto'|'light'|'dark'){themeOpen.value=false;updatePreferences({theme:id});}
function closeThemeOnOutside(e:PointerEvent){if(themeOpen.value&&themeBox.value&&!themeBox.value.contains(e.target as Node))themeOpen.value=false;}
onMounted(()=>document.addEventListener('pointerdown',closeThemeOnOutside,true));onUnmounted(()=>document.removeEventListener('pointerdown',closeThemeOnOutside,true));
// ---- 界面缩放：档位选择（回复内容字号 = 界面字号 + 1px，随档位联动）----
const scaleId=computed(()=>{const px=mobile?preferences.value.mobileFont:preferences.value.desktopFont;const at=(s:{desktop:number;mobile:number})=>mobile?s.mobile:s.desktop;return (UI_SCALES.find(s=>at(s)===px)||UI_SCALES.reduce((best,s)=>Math.abs(at(s)-px)<Math.abs(at(best)-px)?s:best)).id;});
function setScale(id:string){const s=UI_SCALES.find(x=>x.id===id);if(s)updatePreferences({[mobile?'mobileFont':'desktopFont']:mobile?s.mobile:s.desktop} as Partial<Preferences>);}
// ---- 运行诊断：模型链与熔断状态（让"某个模型被暂时跳过"在界面上可见）----
type Health = { engineByMode?: Record<string, string>; modelsByMode?: Record<string, string[]>; circuitByMode?: Record<string, Array<{ model: string; consecutiveFailures: number; coolingDown: boolean; retryInMs: number }>> };
const health = ref<Health | null>(null), healthBusy = ref(false), healthError = ref('');
async function loadHealth() {
  if (healthBusy.value) return;
  healthBusy.value = true; healthError.value = '';
  try {
    const res = await fetch('/api/agent/health');
    if (!res.ok) throw new Error(String(res.status));
    health.value = await res.json() as Health;
  } catch (e) {
    healthError.value = tr('读取失败：') + (e as Error).message;
  } finally {
    healthBusy.value = false;
  }
}
function modeLabel(mode:string){return tr(mode==='chat'?'聊天':'工作');}
function healthState(c:{model:string;consecutiveFailures:number;coolingDown:boolean;retryInMs:number}):string{
  if(c.coolingDown)return tr('冷却中，约 ')+Math.ceil(c.retryInMs/1000)+tr(' 秒后重试');
  if(c.consecutiveFailures)return tr('已失败 ')+c.consecutiveFailures+tr(' 次');
  return tr('正常');
}
const runtime=()=>window.LabClient;
const environment=ref({...(runtime()?.environment?.()||{mainApiBase:'',agentApiBase:'',mainPublicBase:''})});
const diagnostics=ref(''),environmentMessage=ref(''),environmentBusy=ref(false);
async function checkConnection(){
  const client=runtime();if(!client||environmentBusy.value)return;
  environmentBusy.value=true;environmentMessage.value=tr('正在检查…');diagnostics.value='';
  try{
    const results=await client.diagnose();
    diagnostics.value=results.map(item=>item.message).join('\n');
    const failed=results.filter(item=>!item.ok).length;
    environmentMessage.value=failed?tr('有 {count} 项未通过：请核对地址、网络连接与服务器证书。',{count:failed}):tr('主系统与 LabOps 均可连接。');
  }catch(e){environmentMessage.value=(e as Error).message;}
  finally{environmentBusy.value=false;}
}
async function saveEnvironment(){
  const client=runtime();if(!client||environmentBusy.value)return;
  environmentBusy.value=true;environmentMessage.value=tr('正在保存…');
  try{await client.applyEnvironment(environment.value);}
  catch(e){environmentMessage.value=(e as Error).message||tr('地址未保存，请检查后重试。');environmentBusy.value=false;}
}
// ---- 常规：版本更新（仅安装版；逻辑复用客户端注入的 QzUpdate）----
const updateBusy=ref(false),updateMessage=ref(''),updateState=ref(''),updateRelease=ref<any>(null),updateReady=ref(false);
const updateApi=()=>(window as any).QzUpdate||null;
function refreshUpdateState(){
  const u=updateApi();if(!u){updateState.value=tr('当前环境不支持自动更新');return;}
  const a=u.applied?.();updateReady.value=!!(a&&a.version&&(a.path||!u.testMode?.()));
  updateState.value=(u.testMode?.()?tr('测试通道'):tr('正式通道'))+(a&&a.version?' · '+tr('已应用')+' '+a.version:'')+(u.lastCheck?.()?' · '+tr('上次检查')+' '+new Date(u.lastCheck()).toLocaleString():'');
}
async function checkUpdate(){
  const u=updateApi();if(!u||updateBusy.value)return;
  updateBusy.value=true;updateMessage.value=tr('正在检查…');
  try{
    const out=await u.check();
    if(!out.known)updateMessage.value=tr('服务器暂未发布此端安装包。');
    else if(!out.updateAvailable)updateMessage.value=tr('当前已是最新版本。');
    else{updateRelease.value=out.release;updateMessage.value=tr('发现新版本 {v}。',{v:out.release.version});}
  }catch(e){updateMessage.value=(e as Error).message;}
  finally{updateBusy.value=false;refreshUpdateState();}
}
async function downloadUpdate(){
  const u=updateApi();if(!u||!updateRelease.value||updateBusy.value)return;
  updateBusy.value=true;updateMessage.value=tr('正在下载…');
  try{await u.download(updateRelease.value);updateMessage.value=tr('更新已下载。');updateReady.value=true;}
  catch(e){updateMessage.value=(e as Error).message;}
  finally{updateBusy.value=false;refreshUpdateState();}
}
async function installUpdate(){
  const u=updateApi();if(!u||updateBusy.value)return;
  try{await u.installDownloaded();}catch(e){updateMessage.value=(e as Error).message;}
}
refreshUpdateState();
</script>
<template><div class="settings-panel" :class="{'settings-panel--fullscreen':showBack}"><div class="settings-side"><button v-if="showBack" type="button" class="settings-back" @click="emit('back')"><UiIcon name="chevron" :size="14"/><span>{{tr('返回工作区')}}</span></button><nav class="settings-categories" :aria-label="tr('设置')" role="tablist"><button v-for="item in categories" :key="item.id" role="tab" :aria-selected="category===item.id" :aria-controls="'settings-'+item.id" @click="category=item.id"><UiIcon :name="item.icon"/><span>{{tr(item.label)}}</span></button></nav></div><section :id="'settings-'+category" class="settings-content" role="tabpanel"><div class="settings-page">
<template v-if="category==='personalization'"><h2>{{tr('个性化')}}</h2>
<details class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('界面设置')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><div class="settings-card"><div class="settings-row"><span>{{tr('主题')}}</span>
<div ref="themeBox" class="settings-dropdown"><button id="pref-theme" type="button" class="settings-dropdown-trigger" aria-haspopup="listbox" :aria-expanded="themeOpen" :aria-label="tr('主题')" @click="themeOpen=!themeOpen" @keydown.esc="themeOpen=false"><span>{{tr(themeLabel)}}</span><UiIcon name="chevron" :size="14" :class="{'is-turned':themeOpen}"/></button>
<ul v-if="themeOpen" class="settings-dropdown-menu" role="listbox" :aria-label="tr('主题')"><li v-for="opt in themeOptions" :key="opt.id"><button type="button" role="option" :aria-selected="preferences.theme===opt.id" @click="setTheme(opt.id)">{{tr(opt.label)}}<UiIcon v-if="preferences.theme===opt.id" name="check" :size="14"/></button></li></ul></div></div>
<fieldset class="settings-scale"><legend>{{tr('界面缩放')}}</legend><div class="settings-scale-row" role="radiogroup" :aria-label="tr('界面缩放')"><button v-for="s in UI_SCALES" :key="s.id" type="button" role="radio" :aria-checked="scaleId===s.id" :style="{'--scale-px':(mobile?s.mobile:s.desktop)+'px'}" @click="setScale(s.id)">{{tr(s.label)}}</button></div><p class="settings-hint">{{tr('回复内容字号自动比界面大 1px。')}}</p></fieldset></div></section>
<details class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('强调色')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><div class="settings-card"><div class="settings-accents" role="group" :aria-label="tr('强调色')"><button v-for="accent in accents" :key="accent.id" :style="{'--swatch':accent.color}" :aria-label="tr(accent.label)" :aria-pressed="preferences.accent===accent.id" @click="updatePreferences({accent:accent.id as Preferences['accent']})"><i/><span>{{tr(accent.label)}}</span></button></div></div></div></details>
<details class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('预览')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><div class="settings-card settings-preview"><p class="settings-preview-interface">LabOps · {{tr('工作会话')}}</p><p class="settings-preview-response">{{tr('实验室课程和工作记录会在这里显示。')}}</p><span class="settings-preview-button">{{tr('发送')}}</span></div></div></details>
<details class="settings-group settings-voice"><summary class="settings-group__toggle"><span><h3>{{tr('常用语音热词')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><p class="settings-hint">{{tr('把自己常说的实验室词交给系统：一份确定改写识别结果，一份只是提醒模型该听成什么。改完只影响之后的语音输入，保存在这台浏览器里。')}}</p><div class="settings-card settings-voice-card"><VoiceTermPanel :embedded="true" /></div></div></details>
<button class="settings-reset" @click="resetPreferences">{{tr('恢复默认设置')}}</button></template>
<template v-else-if="category==='general'"><h2>{{tr('常规')}}</h2>
<details class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('语言与入口')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><div class="settings-card"><label class="settings-row" for="pref-language"><span>{{tr('语言')}}</span><select id="pref-language" :value="preferences.language" @change="change('language',$event)"><option value="auto">{{tr('跟随系统')}}</option><option value="zh-CN">{{tr("简体中文")}}</option><option value="en">English</option></select></label><label class="settings-row" for="pref-mode"><span>{{tr('默认会话模式')}}</span><select id="pref-mode" :value="preferences.defaultMode" @change="change('defaultMode',$event)"><option value="task">{{tr('工作会话')}}</option><option value="chat">{{tr('聊天会话')}}</option></select></label><label class="settings-row" for="pref-start"><span>{{tr('手机默认入口')}}</span><select id="pref-start" :value="preferences.mobileStart" @change="change('mobileStart',$event)"><option value="assistant">{{tr('会话')}}</option><option value="home">{{tr('工作台')}}</option></select></label></div><p class="settings-hint">{{tr('历史记录与业务资料保留原文。')}}</p></div></details>
<details class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr("模型链与熔断状态")}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><p class="settings-hint">{{tr("连续失败的上游模型会被暂时跳过并在冷却后自动恢复；这里显示的是服务端实时判定，不是配置清单。")}}</p><div class="settings-card settings-model-health"><button :disabled="healthBusy" @click="loadHealth">{{tr(healthBusy?"读取中…":"刷新诊断")}}</button><p v-if="healthError" class="settings-hint" role="alert">{{healthError}}</p><div v-if="health" class="settings-health"><div v-for="(list,mode) in health.circuitByMode" :key="String(mode)" class="settings-health-row"><b>{{modeLabel(String(mode))}}</b><span v-for="c in list" :key="c.model" class="settings-health-cell" :class="{'is-cooling':c.coolingDown}">{{c.model}} · {{healthState(c)}}</span></div><p class="settings-hint">{{tr("本轮实际生效模型显示在每条回答的来源徽章上；未配置 Key 的模式会明确标注为规则引擎，不冒充大模型。")}}</p></div></div></div></details>
<details v-if="installed" class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('版本更新')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><div class="settings-card settings-update"><p class="settings-hint">{{updateState}}</p><div class="settings-advanced-actions"><button :disabled="updateBusy" @click="checkUpdate">{{tr('检查更新')}}</button><button v-if="updateRelease" :disabled="updateBusy" @click="downloadUpdate">{{tr('下载更新')}}</button><button v-if="updateReady" :disabled="updateBusy" @click="installUpdate">{{tr('安装新版本')}}</button></div><p v-if="updateMessage" class="settings-hint" role="status">{{updateMessage}}</p></div></div></details>
<details v-if="!installed" class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('界面版本')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><div class="settings-card settings-edition"><button :disabled="run.inputLocked" @click="emit('edition')"><UiIcon name="panel"/>{{tr(mobile?'使用桌面版':'使用手机版')}}</button><p v-if="run.inputLocked" class="settings-hint">{{tr('生成结束后可切换版本。')}}</p></div></div></details></template>
<template v-else-if="category==='work'"><h2>{{tr('工作')}}</h2>
<details class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('我的工作')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><p class="settings-hint">{{tr('原系统任务与工作队列：待确认方案、待接收交接、待处理工单与资源数据健康。')}}</p><div class="settings-card settings-work-embed"><NativeWorkPanel v-if="business.connected" :embedded="true" :readonly="!taskMode" /></div></div></details>
<details v-if="business.connected&&taskMode&&business.profile?.identity==='admin'" class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('登记故障事件')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><p class="settings-hint">{{tr('登记故障事实并分析教学影响；联合方案仍需本人确认后执行。')}}</p><div class="settings-card settings-work-embed"><NativeIncidentCard :scope-key="business.scopeKey" /></div></div></details>
<details v-if="business.connected" class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('证据与资料')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><p class="settings-hint">{{tr('工单与房间的证据照片附件；管理员可导入厂家设备资料。')}}</p><div class="settings-card settings-work-embed"><EvidencePanel :inline="true" :embed="true" :readonly="!taskMode" /></div></div></details>
<section v-if="!business.connected" class="settings-group"><h3>{{tr('业务工作')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><p class="settings-hint">{{tr('连接主系统账号后可办理业务工作。')}}</p></div></details></template>
<template v-else-if="category==='advanced'"><h2>{{tr('高级设置')}}</h2><details  class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('服务器地址')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><p class="settings-hint">{{tr('服务器地址由管理员提供。更换服务器会退出当前账号并清理本机业务缓存，需重新登录。')}}</p><div class="settings-card settings-server"><label class="settings-field" for="adv-main"><span>{{tr('主系统 API')}}</span><input id="adv-main" type="url" v-model.trim="environment.mainApiBase" autocomplete="off" spellcheck="false" inputmode="url"></label><label class="settings-field" for="adv-agent"><span>{{tr('LabOps API')}}</span><input id="adv-agent" type="url" v-model.trim="environment.agentApiBase" autocomplete="off" spellcheck="false" inputmode="url"></label><label class="settings-field" for="adv-public"><span>{{tr('签到分享地址')}}</span><input id="adv-public" type="url" v-model.trim="environment.mainPublicBase" autocomplete="off" spellcheck="false" inputmode="url"></label><div class="settings-advanced-actions"><button class="settings-apply" :disabled="environmentBusy" @click="saveEnvironment">{{tr('保存并重新登录')}}</button><button :disabled="environmentBusy" @click="checkConnection">{{tr('检查连接')}}</button></div><pre v-if="diagnostics" class="settings-diagnostics" role="status">{{diagnostics}}</pre><p v-if="environmentMessage" class="settings-hint" role="status">{{environmentMessage}}</p></div></div></details></template>
<template v-else><h2>{{tr('账户')}}</h2><details  class="settings-group"><summary class="settings-group__toggle"><span><h3>{{tr('账户信息')}}</span><UiIcon name="chevron" :size="14" class="settings-group__chev"/></summary><div class="settings-group__body"><div class="settings-card settings-account"><div class="settings-identity"><span class="settings-avatar">{{(business.profile?.username||'L').slice(0,1)}}</span><div><b>{{business.profile?.username}}</b><small>{{business.profile?.username}} · {{tr(business.profile?.identity==='admin'?'管理员':'志愿者')}}</small></div></div><div class="settings-account-links"><template v-for="item in [{key:'profile',label:'个人资料'},{key:'password',label:'修改密码'}]" :key="item.key"><a v-if="business.accountLinks[item.key]" :href="business.accountLinks[item.key]" target="_blank" rel="noopener noreferrer"><span>{{tr(item.label)}}</span><small>{{tr('前往主系统')}}</small><UiIcon name="external"/></a><button v-else disabled>{{tr(item.label)}} · {{tr('主系统入口暂不可用')}}</button></template></div></div></div></details><button class="settings-logout" @click="emit('logout')">{{tr('退出登录')}}</button></template>
<p v-if="preferenceError" class="settings-hint" role="status">{{tr(preferenceError)}}</p><p v-if="category!=='account'&&category!=='advanced'&&category!=='work'" class="settings-hint">{{tr('保存于当前浏览器，按账号分别记忆。')}}</p></div></section></div></template>
<style scoped>
.settings-panel{display:grid;grid-template-columns:152px minmax(0,1fr);gap:20px;color:var(--text);font-size:var(--ui-font-size);min-width:0}
.settings-side{min-width:0}
.settings-categories{display:flex;flex-direction:column;gap:5px}
/* 分类卡片半高亮：默认约为选中态 45% 的底色，选中满底色 + 描边 */
.settings-categories button{display:flex;gap:8px;align-items:center;background:color-mix(in srgb,var(--primary-weak) 45%,transparent);border:0;border-radius:7px;padding:10px;text-align:left;color:var(--text);font:inherit;min-height:44px;cursor:pointer}
.settings-categories button:hover{background:color-mix(in srgb,var(--primary-weak) 75%,transparent)}
.settings-categories button[aria-selected=true]{background:var(--primary-weak);color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary-border);font-weight:600}
.settings-content{min-width:0}
.settings-content h2{font-size:1.15em;margin:4px 0 15px}
.settings-page{max-width:1100px;margin:0 auto}
/* 全屏态：左侧固定导航 + 返回工作区，右侧独立滚动、内容居中限宽 */
.settings-panel--fullscreen{height:100%;grid-template-columns:210px minmax(0,1fr);gap:0}
.settings-panel--fullscreen .settings-side{display:flex;flex-direction:column;gap:10px;min-height:0;padding:14px 12px;border-right:1px solid var(--border);overflow-y:auto}
.settings-panel--fullscreen .settings-content{min-height:0;padding:26px 40px 56px;overflow-y:auto}
.settings-back{display:flex;align-items:center;gap:6px;min-height:40px;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:var(--text-muted);font:inherit;text-align:left;cursor:pointer}
.settings-back:hover{background:var(--surface-2);color:var(--text)}
.settings-back svg{transform:rotate(180deg);flex-shrink:0}
/* 分区：组标题 + 卡片容器 */
.settings-group{margin:0 0 22px}
.settings-group>h3{margin:0 0 8px;font-size:1em;font-weight:600}
.settings-group>h3+.settings-hint{margin:0 0 10px}
.settings-card+.settings-hint{margin:8px 0 0}
.settings-card{background:var(--surface-2);border:1px solid var(--border);border-radius:8px}
.settings-card select,.settings-card .settings-dropdown-trigger{background:var(--surface)}
.settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);font:inherit;min-width:0}
.settings-card>.settings-row:last-child{border-bottom:0}
.settings-row select{max-width:58%;min-width:0;width:150px}
/* 主题下拉：自定义触发器 + 菜单（风格对齐设置面板；不依赖系统原生下拉外观） */
.settings-dropdown{position:relative}
.settings-dropdown-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:150px;min-height:44px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface-2);color:var(--text);font:inherit;cursor:pointer;transition:background-color .15s,border-color .15s}
.settings-dropdown-trigger:hover{background:var(--surface-3)}
.settings-dropdown-trigger:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.settings-dropdown-trigger svg{flex-shrink:0;transition:transform .15s}
.settings-dropdown-trigger svg.is-turned{transform:rotate(180deg)}
.settings-dropdown-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:30;min-width:100%;margin:0;padding:5px;list-style:none;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;box-shadow:var(--shadow-2)}
.settings-dropdown-menu li{margin:0}
.settings-dropdown-menu button{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:38px;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:var(--text);font:inherit;text-align:left;cursor:pointer;white-space:nowrap}
.settings-dropdown-menu button:hover{background:var(--surface-3)}
.settings-dropdown-menu button[aria-selected=true]{color:var(--primary);font-weight:600}
/* 界面缩放：档位按钮组，按钮文字按档位字号预览效果 */
.settings-scale{border:0;margin:0;padding:12px 16px}
.settings-scale legend{padding:0}
.settings-scale-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.settings-scale-row button{min-height:44px;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-family:var(--font-sans);font-size:var(--scale-px,14px);line-height:1.2;cursor:pointer;transition:border-color .15s,background-color .15s}
.settings-scale-row button:hover{background:var(--surface-3)}
.settings-scale-row button[aria-checked=true]{border:2px solid var(--primary);padding:5px 11px;background:var(--primary-weak);color:var(--primary);font-weight:600}
.settings-scale .settings-hint{margin:8px 0 0}
.settings-accents{display:flex;flex-wrap:wrap;gap:6px;padding:12px 16px}
.settings-accents button{display:flex;gap:5px;align-items:center;min-height:44px;padding:6px 9px;border:1px solid var(--border);border-radius:6px;color:var(--text);background:var(--surface);font:inherit;cursor:pointer}
.settings-accents button[aria-pressed=true]{border:2px solid var(--primary);padding:5px 8px}
.settings-accents i{width:14px;height:14px;background:var(--swatch);border-radius:50%;flex-shrink:0}
.settings-preview{padding:16px}
.settings-preview-interface{font-size:var(--ui-font-size);margin:4px 0}
.settings-preview-response{font-family:var(--font-serif);font-size:var(--reply-font-size);line-height:1.7;margin:8px 0 12px}
.settings-preview-button{display:inline-block;padding:7px 14px;border-radius:6px;background:var(--primary);color:var(--primary-contrast)}
.settings-voice-card{padding:12px 16px}
/* 工作分区：入口行（点击后关闭设置并打开对应业务面板） */
.settings-work{overflow:hidden}
.settings-work-row{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:12px 16px;border:0;border-bottom:1px solid var(--border);background:transparent;color:var(--text);font:inherit;text-align:left;cursor:pointer}
.settings-work-row:last-child{border-bottom:0}
.settings-work-row:hover{background:var(--surface-3)}
.settings-work-row>svg:first-child{flex-shrink:0;color:var(--text-muted)}
.settings-work-row>span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.settings-work-row small{color:var(--text-muted);font-size:.9em;white-space:nowrap}
.settings-work-row>svg:last-child{flex-shrink:0;color:var(--text-faint)}
.settings-work>.settings-hint{margin:0;padding:12px 16px}
.settings-reset,.settings-logout,.settings-edition button,.settings-account-links button{font:inherit;min-height:44px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;padding:8px 12px;cursor:pointer}
.settings-reset{margin-top:4px}
.settings-edition{padding:14px 16px}
.settings-edition button{display:flex;align-items:center;gap:8px;width:100%;text-align:left}
.settings-edition .settings-hint{margin:8px 0 0}
.settings-update{padding:14px 16px}
.settings-update .settings-hint{margin:0 0 4px}
.settings-update .settings-advanced-actions{margin:10px 0 4px}
.settings-model-health{padding:14px 16px}
.settings-model-health .settings-hint{margin:8px 0 0}
.settings-health{width:100%;margin:8px 0;font-size:12.5px}
.settings-health-cell{display:block;padding:1px 0}
.settings-health-cell.is-cooling{color:var(--warn)}
.settings-account{padding:16px}
.settings-identity{display:flex;gap:10px;align-items:center;margin-bottom:12px}
.settings-identity>div{min-width:0;display:flex;flex-direction:column;gap:5px;overflow-wrap:anywhere}
.settings-identity small{color:var(--text-muted)}
.settings-avatar{width:38px;height:38px;display:grid;place-items:center;border-radius:50%;background:var(--primary);color:var(--primary-contrast);flex-shrink:0}
.settings-account-links{display:grid;gap:8px}
.settings-account-links a{display:flex;gap:8px;align-items:center;min-height:44px;padding:12px 0;color:var(--text);text-decoration:none;border-bottom:1px solid var(--border)}
.settings-account-links>:last-child{border-bottom:0}
.settings-account-links a span{flex:1}
.settings-account-links a small{color:var(--text-muted)}
.settings-logout{margin-top:4px;color:var(--danger);width:100%;text-align:left}
.settings-hint{color:var(--text-muted);font-size:.9em;line-height:1.6;overflow-wrap:anywhere;margin:12px 0}
.settings-panel button:disabled{opacity:.55;cursor:default}
/* 高级设置：服务器地址与连接检查（仅安装版可见，网页端构造 categories 时不包含该分类） */
.settings-field{display:grid;gap:6px;padding:12px 16px;border-bottom:1px solid var(--border);font:inherit}
.settings-field>span{color:var(--text-muted);font-size:.9em}
.settings-field input{width:100%;box-sizing:border-box;min-height:44px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface);color:var(--text);font:inherit}
.settings-field input:focus{outline:0;border-color:var(--primary);background:var(--surface);box-shadow:0 0 0 3px var(--primary-weak)}
.settings-advanced-actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 4px}
.settings-card>.settings-advanced-actions{margin:0;padding:12px 16px}
.settings-advanced-actions button{min-height:44px;padding:10px 18px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;cursor:pointer}
.settings-advanced-actions .settings-apply{background:var(--primary);border-color:var(--primary);color:var(--primary-contrast);font-weight:600}
.settings-diagnostics{margin:12px 0 0;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:13px/1.75 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.settings-server>.settings-diagnostics{margin:0 16px 12px}
.settings-server>.settings-hint{margin:0 16px 12px}
@media(max-width:700px){.settings-panel{grid-template-columns:minmax(0,1fr);gap:12px}.settings-panel:not(.settings-panel--fullscreen) .settings-side{display:contents}.settings-categories{flex-direction:row;display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:5px}.settings-categories button{justify-content:center;padding:8px 4px;flex-wrap:wrap}.settings-categories svg{width:16px;flex-shrink:0}.settings-content h2{margin-bottom:8px}.settings-account-links a small{font-size:.85em}.settings-row{align-items:flex-start}.settings-row>span{padding-top:10px}.settings-panel--fullscreen{height:100%;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:0}.settings-panel--fullscreen .settings-side{border-right:0;border-bottom:1px solid var(--border);padding:10px 12px;overflow:visible}.settings-panel--fullscreen .settings-content{padding:16px 14px 40px}}
</style>
<style scoped>
/* 工作-内嵌业务面板：融入 settings-card（去弹窗遮罩/居中，适配设置页宽度） */
.settings-work-embed{padding:0;background:transparent}
.settings-work-embed .native-work-panel--embedded{border:0;border-radius:0;background:transparent}
.settings-work-embed .native-work-queues{flex-wrap:wrap;gap:8px}
.settings-work-embed .native-form{grid-template-columns:repeat(2,minmax(0,1fr))}
.settings-work-embed .evidence-inline{border:0;padding:0}
.settings-work-embed .native-card{border-left:4px solid var(--primary)}
</style>
<style scoped>
/* 批次2：分区组折叠——summary 行 + chevron 旋转 + body 内距 */
.settings-group__toggle{list-style:none;display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px 2px;font-size:1em;font-weight:600;user-select:none}
.settings-group__toggle::-webkit-details-marker{display:none}
.settings-group__toggle span{flex:1}
.settings-group__chev{transition:transform .15s;color:var(--text-faint);flex-shrink:0}
details[open]>.settings-group__toggle .settings-group__chev{transform:rotate(90deg)}
.settings-group__body{display:flex;flex-direction:column;gap:14px;padding:2px 2px 8px}
</style>
