<script setup lang="ts">
import {isInstalledClient} from '../client';
const installed=isInstalledClient();
import {ref} from 'vue';
import {preferences,updatePreferences,resetPreferences,preferenceError,mobile} from '../preferences';
import type {Preferences} from '../preferences/schema';
import {t as tr} from '../i18n';import {useBusinessStore} from '../stores/business';import {useRunStore} from '../stores/run';import UiIcon from './UiIcon.vue';
const props=withDefaults(defineProps<{category?:string}>(),{category:'personalization'}),emit=defineEmits<{edition:[];logout:[]}>();
const CATEGORIES=['personalization','general','account'];
const business=useBusinessStore(),run=useRunStore(),category=ref([...CATEGORIES,'advanced'].includes(props.category||'')?(props.category as string):'personalization');
const categories=[{id:'personalization',label:'个性化',icon:'palette'},{id:'general',label:'常规',icon:'settings'},...(installed?[{id:'advanced',label:'高级设置',icon:'panel'}]:[]),{id:'account',label:'账户',icon:'user'}];
const accents=[{id:'neutral',label:'中性',color:'#525252'},{id:'blue',label:'蓝色',color:'#1d4ed8'},{id:'green',label:'绿色',color:'#166534'},{id:'purple',label:'紫色',color:'#6d28d9'},{id:'amber',label:'琥珀',color:'#92400e'}];
function change(key:keyof Preferences,event:Event,kind:'string'|'number'|'boolean'='string'){const el=event.target as HTMLInputElement;updatePreferences({[key]:kind==='number'?Number(el.value):kind==='boolean'?el.checked:el.value} as Partial<Preferences>);}
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
<template><div class="settings-panel"><nav class="settings-categories" :aria-label="tr('设置')" role="tablist"><button v-for="item in categories" :key="item.id" role="tab" :aria-selected="category===item.id" :aria-controls="'settings-'+item.id" @click="category=item.id"><UiIcon :name="item.icon"/><span>{{tr(item.label)}}</span></button></nav><section :id="'settings-'+category" class="settings-content" role="tabpanel">
<template v-if="category==='personalization'"><h2>{{tr('个性化')}}</h2><label class="settings-row" for="pref-theme"><span>{{tr('主题')}}</span><select id="pref-theme" :aria-label="tr('主题')" :value="preferences.theme" @change="change('theme',$event)"><option value="auto">{{tr('跟随系统')}}</option><option value="light">{{tr('浅色')}}</option><option value="dark">{{tr('深色')}}</option></select></label>
<label class="settings-range" for="pref-interface"><span>{{tr('界面字体大小')}}<output>{{mobile?preferences.mobileFont:preferences.desktopFont}}px</output></span><input id="pref-interface" type="range" :min="mobile?9:11" :max="mobile?16:18" :value="mobile?preferences.mobileFont:preferences.desktopFont" @input="change(mobile?'mobileFont':'desktopFont',$event,'number')"></label>
<label class="settings-range" for="pref-response"><span>{{tr('回复字体大小')}}<output>{{mobile?preferences.mobileReply:preferences.desktopReply}}px</output></span><input id="pref-response" type="range" :min="mobile?9:12" :max="mobile?20:24" :value="mobile?preferences.mobileReply:preferences.desktopReply" @input="change(mobile?'mobileReply':'desktopReply',$event,'number')"></label>
<fieldset class="settings-accents"><legend>{{tr('强调色')}}</legend><button v-for="accent in accents" :key="accent.id" :style="{'--swatch':accent.color}" :aria-label="tr(accent.label)" :aria-pressed="preferences.accent===accent.id" @click="updatePreferences({accent:accent.id as Preferences['accent']})"><i/><span>{{tr(accent.label)}}</span></button></fieldset>
<label class="settings-row settings-switch"><span>{{tr('减少动效')}}</span><input type="checkbox" :checked="preferences.reducedMotion" @change="change('reducedMotion',$event,'boolean')"></label><section class="settings-preview"><small>{{tr('预览')}}</small><p class="settings-preview-interface">LabOps · {{tr('工作会话')}}</p><p class="settings-preview-response">{{tr('实验室课程和工作记录会在这里显示。')}}</p><span class="settings-preview-button">{{tr('发送')}}</span></section><button class="settings-reset" @click="resetPreferences">{{tr('恢复默认设置')}}</button></template>
<template v-else-if="category==='general'"><h2>{{tr('常规')}}</h2><label class="settings-row" for="pref-language"><span>{{tr('语言')}}</span><select id="pref-language" :value="preferences.language" @change="change('language',$event)"><option value="auto">{{tr('跟随系统')}}</option><option value="zh-CN">{{tr("简体中文")}}</option><option value="en">English</option></select></label><p class="settings-hint">{{tr('历史记录与业务资料保留原文。')}}</p><label class="settings-row" for="pref-mode"><span>{{tr('默认会话模式')}}</span><select id="pref-mode" :value="preferences.defaultMode" @change="change('defaultMode',$event)"><option value="task">{{tr('工作会话')}}</option><option value="chat">{{tr('聊天会话')}}</option></select></label><label class="settings-row" for="pref-start"><span>{{tr('手机默认入口')}}</span><select id="pref-start" :value="preferences.mobileStart" @change="change('mobileStart',$event)"><option value="assistant">{{tr('助手')}}</option><option value="home">{{tr('工作台')}}</option></select></label><div class="settings-model-health"><h3>{{tr("模型链与熔断状态")}}</h3><p class="settings-hint">{{tr("连续失败的上游模型会被暂时跳过并在冷却后自动恢复；这里显示的是服务端实时判定，不是配置清单。")}}</p><button :disabled="healthBusy" @click="loadHealth">{{tr(healthBusy?"读取中…":"刷新诊断")}}</button><p v-if="healthError" class="settings-hint" role="alert">{{healthError}}</p><div v-if="health" class="settings-health"><div v-for="(list,mode) in health.circuitByMode" :key="String(mode)" class="settings-health-row"><b>{{modeLabel(String(mode))}}</b><span v-for="c in list" :key="c.model" class="settings-health-cell" :class="{'is-cooling':c.coolingDown}">{{c.model}} · {{healthState(c)}}</span></div><p class="settings-hint">{{tr("本轮实际生效模型显示在每条回答的来源徽章上；未配置 Key 的模式会明确标注为规则引擎，不冒充大模型。")}}</p></div></div><template v-if="installed"><div class="settings-update"><h3>{{tr('版本更新')}}</h3><p class="settings-hint">{{updateState}}</p><div class="settings-advanced-actions"><button :disabled="updateBusy" @click="checkUpdate">{{tr('检查更新')}}</button><button v-if="updateRelease" :disabled="updateBusy" @click="downloadUpdate">{{tr('下载更新')}}</button><button v-if="updateReady" :disabled="updateBusy" @click="installUpdate">{{tr('安装新版本')}}</button></div><p v-if="updateMessage" class="settings-hint" role="status">{{updateMessage}}</p></div></template>
<div v-if="!installed" class="settings-edition"><h3>{{tr('界面版本')}}</h3><button :disabled="run.inputLocked" @click="emit('edition')"><UiIcon name="panel"/>{{tr(mobile?'使用桌面版':'使用手机版')}}</button><p v-if="run.inputLocked" class="settings-hint">{{tr('生成结束后可切换版本。')}}</p></div></template>
<template v-else-if="category==='advanced'"><h2>{{tr('高级设置')}}</h2><p class="settings-hint">{{tr('服务器地址由管理员提供。更换服务器会退出当前账号并清理本机业务缓存，需重新登录。')}}</p><label class="settings-field" for="adv-main"><span>{{tr('主系统 API')}}</span><input id="adv-main" type="url" v-model.trim="environment.mainApiBase" autocomplete="off" spellcheck="false" inputmode="url"></label><label class="settings-field" for="adv-agent"><span>{{tr('LabOps API')}}</span><input id="adv-agent" type="url" v-model.trim="environment.agentApiBase" autocomplete="off" spellcheck="false" inputmode="url"></label><label class="settings-field" for="adv-public"><span>{{tr('签到分享地址')}}</span><input id="adv-public" type="url" v-model.trim="environment.mainPublicBase" autocomplete="off" spellcheck="false" inputmode="url"></label><div class="settings-advanced-actions"><button class="settings-apply" :disabled="environmentBusy" @click="saveEnvironment">{{tr('保存并重新登录')}}</button><button :disabled="environmentBusy" @click="checkConnection">{{tr('检查连接')}}</button></div><pre v-if="diagnostics" class="settings-diagnostics" role="status">{{diagnostics}}</pre><p v-if="environmentMessage" class="settings-hint" role="status">{{environmentMessage}}</p></template>
<template v-else><h2>{{tr('账户')}}</h2><div class="settings-identity"><span class="settings-avatar">{{(business.profile?.username||'L').slice(0,1)}}</span><div><b>{{business.profile?.username}}</b><small>{{business.profile?.username}} · {{tr(business.profile?.identity==='admin'?'管理员':'志愿者')}}</small></div></div><div class="settings-account-links"><template v-for="item in [{key:'profile',label:'个人资料'},{key:'password',label:'修改密码'}]" :key="item.key"><a v-if="business.accountLinks[item.key]" :href="business.accountLinks[item.key]" target="_blank" rel="noopener noreferrer"><span>{{tr(item.label)}}</span><small>{{tr('前往主系统')}}</small><UiIcon name="external"/></a><button v-else disabled>{{tr(item.label)}} · {{tr('主系统入口暂不可用')}}</button></template></div><button class="settings-logout" @click="emit('logout')">{{tr('退出登录')}}</button></template>
<p v-if="preferenceError" class="settings-hint" role="status">{{tr(preferenceError)}}</p><p v-if="category!=='account'&&category!=='advanced'" class="settings-hint">{{tr('保存于当前浏览器，按账号分别记忆。')}}</p></section></div></template>
<style scoped>
.settings-panel{display:grid;grid-template-columns:152px minmax(0,1fr);gap:20px;color:var(--text);font-size:var(--ui-font-size);min-width:0}.settings-categories{display:flex;flex-direction:column;gap:5px}.settings-categories button{display:flex;gap:8px;align-items:center;background:transparent;border:0;border-radius:7px;padding:10px;text-align:left;color:var(--text);font:inherit;min-height:44px;cursor:pointer}.settings-categories button[aria-selected=true]{background:var(--primary-weak);color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary-border)}.settings-content{min-width:0}.settings-content h2{font-size:1.15em;margin:4px 0 15px}.settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);font:inherit;min-width:0}.settings-row select{max-width:58%;min-width:0;width:150px}.settings-range{display:grid;gap:5px;padding:14px 0;border-bottom:1px solid var(--border)}.settings-range>span{display:flex;align-items:center;justify-content:space-between}.settings-range output{font-variant-numeric:tabular-nums;color:var(--text-muted)}.settings-range input{width:100%;min-height:44px;accent-color:var(--primary);padding:0}.settings-accents{display:flex;flex-wrap:wrap;gap:6px;padding:12px 0;border:0;margin:12px 0}.settings-accents legend{padding:0}.settings-accents button{display:flex;gap:5px;align-items:center;min-height:44px;padding:6px 9px;border:1px solid var(--border);border-radius:6px;color:var(--text);background:var(--surface);font:inherit;cursor:pointer}.settings-accents button[aria-pressed=true]{border:2px solid var(--primary);padding:5px 8px}.settings-accents i{width:14px;height:14px;background:var(--swatch);border-radius:50%;flex-shrink:0}.settings-switch input{width:20px;height:20px;accent-color:var(--primary)}.settings-preview{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px;margin:15px 0}.settings-preview small{color:var(--text-muted)}.settings-preview-interface{font-size:var(--ui-font-size)}.settings-preview-response{font-family:var(--font-serif);font-size:var(--reply-font-size);line-height:1.7}.settings-preview-button{display:inline-block;padding:7px 14px;border-radius:6px;background:var(--primary);color:var(--primary-contrast)}.settings-reset,.settings-logout,.settings-edition button,.settings-account-links button{font:inherit;min-height:44px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);border-radius:6px;padding:8px 12px;cursor:pointer}.settings-edition{padding:16px 0;margin-top:12px;border-top:1px solid var(--border)}
.settings-update{padding:16px 0;margin-top:12px;border-top:1px solid var(--border)}
.settings-update h3{font-size:1em;margin:0 0 8px}
.settings-update .settings-advanced-actions{margin:10px 0 4px}.settings-edition h3{font-size:1em;margin:0 0 10px}.settings-edition button{display:flex;align-items:center;gap:8px;width:100%;text-align:left}.settings-identity{display:flex;gap:10px;align-items:center;margin-bottom:16px}.settings-identity>div{min-width:0;display:flex;flex-direction:column;gap:5px;overflow-wrap:anywhere}.settings-identity small{color:var(--text-muted)}.settings-avatar{width:38px;height:38px;display:grid;place-items:center;border-radius:50%;background:var(--primary);color:var(--primary-contrast);flex-shrink:0}.settings-account-links{display:grid;gap:8px}.settings-account-links a{display:flex;gap:8px;align-items:center;min-height:44px;padding:12px 0;color:var(--text);text-decoration:none;border-bottom:1px solid var(--border)}.settings-account-links a span{flex:1}.settings-account-links a small{color:var(--text-muted)}.settings-logout{margin-top:22px;color:var(--danger);width:100%;text-align:left}.settings-hint{color:var(--text-muted);font-size:.9em;line-height:1.6;overflow-wrap:anywhere;margin:12px 0}.settings-panel button:disabled{opacity:.55;cursor:default}
/* 高级设置：服务器地址与连接检查（仅安装版可见，网页端构造 categories 时不包含该分类） */
.settings-field{display:grid;gap:6px;padding:10px 0;border-bottom:1px solid var(--border);font:inherit}
.settings-field>span{color:var(--text-muted);font-size:.9em}
.settings-field input{width:100%;box-sizing:border-box;min-height:44px;padding:8px 10px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface-2);color:var(--text);font:inherit}
.settings-field input:focus{outline:0;border-color:var(--primary);background:var(--surface);box-shadow:0 0 0 3px var(--primary-weak)}
.settings-advanced-actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 4px}
.settings-advanced-actions button{min-height:44px;padding:10px 18px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;cursor:pointer}
.settings-advanced-actions .settings-apply{background:var(--primary);border-color:var(--primary);color:var(--primary-contrast);font-weight:600}
.settings-diagnostics{margin:12px 0 0;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);color:var(--text);font:13px/1.75 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:700px){.settings-panel{grid-template-columns:minmax(0,1fr);gap:12px}.settings-categories{flex-direction:row;display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:5px}.settings-categories button{justify-content:center;padding:8px 4px;flex-wrap:wrap}.settings-categories svg{width:16px;flex-shrink:0}.settings-content h2{margin-bottom:8px}.settings-account-links a small{font-size:.85em}.settings-row{align-items:flex-start}.settings-row>span{padding-top:10px}}
.settings-model-health{margin:12px 0 0;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2)}
.settings-model-health h3{margin:0 0 6px;font-size:13.5px}
.settings-health{width:100%;border-collapse:collapse;margin:8px 0;font-size:12.5px}
.settings-health th,.settings-health td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--border);vertical-align:top}
.settings-health th{color:var(--text-faint);font-weight:500}
.settings-health-cell{display:block;padding:1px 0}
.settings-health-cell.is-cooling{color:var(--warn)}
.settings-mono{font-family:var(--font-mono);font-size:12px}
</style>
