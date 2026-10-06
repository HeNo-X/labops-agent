<script setup lang="ts">
import {ref,onMounted,onUnmounted} from 'vue';
import {useBusinessStore,businessApi} from '../stores/business';
import {useRunStore} from '../stores/run';
const business=useBusinessStore(),account=ref(''),password=ref(''),expanded=ref(false);
const run=useRunStore();
defineProps<{unified?:boolean}>();
const diagnosis=ref<Record<string,unknown>>(),diagnosisError=ref('');
async function diagnose(){diagnosisError.value='';try{diagnosis.value=await businessApi('proxy/diagnostics');}catch(e){diagnosisError.value=(e as Error).message;}}
let timer:ReturnType<typeof setInterval>;
async function connect(){await business.connect(account.value,password.value);password.value='';if(business.connected)expanded.value=false;}
onMounted(()=>{void business.refresh();timer=setInterval(()=>{if(document.visibilityState==='visible')void business.refresh();},30000);});onUnmounted(()=>clearInterval(timer));
</script>
<template>
 <section class="business-panel" aria-label="原系统连接与实际身份">
  <div class="business-panel__line"><b>{{business.connected?(unified?'主系统已连接':'原系统已连接'):(unified?'主系统连接不可用':'原系统未连接')}}</b><span v-if="business.profile">{{business.profile.username}} · {{({admin:'管理员',volunteer:'志愿者',student:'学生'} as Record<string,string>)[business.profile.identity]||business.profile.identity}}</span><span v-else>{{unified?'请核对当前登录状态':'当前为隔离演示工作区'}}</span><button v-if="!unified" type="button" @click="expanded=!expanded">{{expanded?'收起':'连接管理'}}</button><button v-if="business.profile?.identity==='admin'" @click="diagnose">连接诊断</button><a href="/operations.html?bridge=1" target="_blank" rel="noopener">备用工作台 ↗</a></div>
  <div v-if="expanded&&!unified" class="business-panel__detail">
   <form v-if="!business.connected" class="business-panel__form" @submit.prevent="connect"><label>原系统账号<input v-model="account" autocomplete="username" name="native-account" required></label><label>原系统密码<input v-model="password" type="password" autocomplete="current-password" name="native-password" required></label><button :disabled="business.busy||run.inputLocked">连接账号</button></form>
   <button v-else type="button" :disabled="business.busy||run.inputLocked" @click="business.disconnect">断开并吊销委托会话</button>
   <p v-if="run.inputLocked">本轮结束或取消后可切换业务账号。</p>
   <p>原系统操作按实际账号授权，人工确认后提交；换账号后须重新查询和准备方案。</p>
  </div>
  <details v-if="diagnosis" open><summary>连接诊断</summary><p>主系统 v{{diagnosis.version}} · 构建 {{diagnosis.build}} · 业务授权 {{diagnosis.authorized?'有效':'无效'}} · Agent {{diagnosis.agentReachable?'可达':'不可达'}} · Agent版本 {{diagnosis.agentVersion||'未知'}} · 持久目录 {{diagnosis.storageWritable?'可写':'不可写'}} · 时区 {{diagnosis.timezone}} · 查询 {{diagnosis.queriedAt}}</p><p>Agent构建 {{diagnosis.agentBuild||'未知'}} · 接口版本 {{diagnosis.agentContractVersion||'未知'}} · Agent数据库 {{diagnosis.agentDatabaseWritable?'可写':'需检查'}} · 凭证密钥 {{diagnosis.credentialKeyReady?'就绪':'需检查'}}</p><details><summary>最近请求与错误类别</summary><pre>{{JSON.stringify(diagnosis.requestHealth,null,2)}}</pre></details><p v-if="diagnosis.agentVersion&&diagnosis.agentVersion!==diagnosis.version">两端版本不同，请核对并升级。</p></details><p v-if="diagnosisError" role="alert">{{diagnosisError}}</p>
  <p v-if="business.error" role="status">{{business.error}}</p>
 </section>
</template>
<style scoped>
.business-panel{flex-shrink:0;border-bottom:1px solid var(--border);background:var(--surface);padding:10px 16px;font-size:12px;overflow-wrap:anywhere;z-index:2}.business-panel__line{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.business-panel__line b{color:var(--accent)}.business-panel__line button{margin-left:auto}.business-panel a{color:var(--text-muted)}button{border:1px solid var(--border-strong);background:var(--surface-2);color:var(--text);border-radius:7px;padding:6px 10px;cursor:pointer}.business-panel__form{display:flex;gap:10px;align-items:end;flex-wrap:wrap;padding-top:10px}.business-panel__form label{display:grid;gap:4px;flex:1;min-width:100px}input{width:100%;box-sizing:border-box;min-width:0;background:var(--surface-2);color:var(--text);border:1px solid var(--border-strong);padding:8px;border-radius:6px}.business-panel p{margin:8px 0 0;color:var(--text-muted)}@media(max-width:600px){.business-panel{padding:8px 10px}.business-panel__line{gap:6px}.business-panel__line a{font-size:11px}}
</style>
