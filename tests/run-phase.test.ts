import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@shared/'))return next(new URL('../shared/'+specifier.slice(8)+'.ts',import.meta.url).href,context);if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);return next(specifier,context);}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
// run.ts 在动作里用 window.setInterval/clearInterval（node:test 进程里补最小外壳）。
// 计时器必须 unref：否则 beginRun 起的 interval 会让测试进程永不退出。
Object.assign(globalThis,{window:{
  setInterval:(fn:()=>void,ms:number)=>{const t=setInterval(fn,ms);(t as unknown as {unref?:()=>void}).unref?.();return t;},
  clearInterval:(t:number|NodeJS.Timeout)=>clearInterval(t as NodeJS.Timeout)
}});
const {PHASE_TRANSITIONS,canTransitionPhase,transitionPhase}=await import('../web/stores/run.ts');
const {createPinia,setActivePinia}=await import('pinia');
const {useRunStore}=await import('../web/stores/run.ts');

type RunPhase=keyof typeof PHASE_TRANSITIONS;
const ALL=Object.keys(PHASE_TRANSITIONS) as RunPhase[];

/** 构造一条归属当前运行的事件并送进 store */
function feed(store:ReturnType<typeof useRunStore>,seq:number,type:string,payload:Record<string,unknown>={}):void{
  store.ingest({seq,v:1,runId:store.runId??'run-x',type:type as never,ts:new Date().toISOString(),payload});
}

test('T1-01 转移白名单表：同态重入恒允许，表外全部拒绝且严格版抛错',()=>{
  for(const from of ALL)for(const to of ALL){
    const allowed=PHASE_TRANSITIONS[from].includes(to);
    assert.equal(canTransitionPhase(from,to),allowed,`${from} -> ${to} 判定与表不一致`);
    if(allowed)assert.equal(transitionPhase(from,to),to);
    else assert.throws(()=>transitionPhase(from,to),/invalid phase transition/);
  }
  // 三个终态出边为空（除自环）：迟到事件不得把终态翻回中间态
  for(const t of ['completed','failed','cancelled'] as RunPhase[]){
    assert.deepEqual(PHASE_TRANSITIONS[t].filter(x=>x!==t),[],`${t} 不应有出边`);
  }
});

test('T1-02 事件序列：run_started→tool→need_confirm→继续→回答→完成，awaiting_confirm 是可见中间态',()=>{
  setActivePinia(createPinia());
  const store=useRunStore();
  store.beginRun('D517 投影仪没有信号，帮我报修');
  assert.equal(store.phase,'planning');
  feed(store,0,'run_started',{engine:'demo',sourceType:'snapshot',serverNow:{iso:'',date:'',time:'',weekday:1,weekdayLabel:'',timezone:''},term:{term:'',termStart:null,weekNo:null,weekDeterminable:false,note:''},allowedTools:[]});
  feed(store,1,'tool_started',{tool:'query_lab_status',toolCallId:'tc1',args:{},step:1});
  assert.equal(store.phase,'tool');
  feed(store,2,'tool_result',{tool:'query_lab_status',toolCallId:'tc1',ok:true,ms:12,summary:'ok',step:1});
  feed(store,3,'tool_started',{tool:'prepare_issue_ticket',toolCallId:'tc2',args:{},step:2});
  feed(store,4,'need_confirm',{taskId:'t1',proposal:{},allowedDecisions:['confirm','reject']});
  assert.equal(store.phase,'awaiting_confirm');
  assert.equal(store.runStatus,'running','need_confirm 不改 runStatus：输入互斥不放宽');
  // 本人确认后（无独立事件，REST 决策），Agent 继续产出 → 相位离开 awaiting_confirm
  feed(store,5,'answer_delta',{text:'已生成草稿'});
  assert.equal(store.phase,'answering');
  feed(store,6,'run_completed',{steps:2,toolCalls:2,ms:1200,answer:'done',durable:true});
  assert.equal(store.phase,'completed');
  assert.equal(store.runStatus,'completed');
});

test('T1-03 负向：need_confirm 之后直接 run_failed，相位必须收敛 failed，不得残留 awaiting_confirm',()=>{
  setActivePinia(createPinia());
  const store=useRunStore();
  store.beginRun('查询 E310 今天有哪些课');
  feed(store,0,'run_started',{engine:'demo',sourceType:'snapshot',serverNow:{iso:'',date:'',time:'',weekday:1,weekdayLabel:'',timezone:''},term:{term:'',termStart:null,weekNo:null,weekDeterminable:false,note:''},allowedTools:[]});
  feed(store,1,'need_confirm',{taskId:'t1',proposal:{},allowedDecisions:['confirm','reject']});
  assert.equal(store.phase,'awaiting_confirm');
  feed(store,2,'run_failed',{code:'llm_unavailable',message:'模型链均不可用'});
  assert.equal(store.phase,'failed');
  assert.equal(store.runStatus,'failed');
  assert.equal(store.error?.code,'llm_unavailable');
});

test('T1-04 取消是正常结束：cancelled 相位收敛、不置 error',()=>{
  setActivePinia(createPinia());
  const store=useRunStore();
  store.beginRun('查询房间状态');
  feed(store,0,'run_started',{engine:'demo',sourceType:'snapshot',serverNow:{iso:'',date:'',time:'',weekday:1,weekdayLabel:'',timezone:''},term:{term:'',termStart:null,weekNo:null,weekDeterminable:false,note:''},allowedTools:[]});
  feed(store,1,'tool_started',{tool:'query_lab_status',toolCallId:'tc1',args:{},step:1});
  feed(store,2,'run_cancelled',{ms:300,message:'你取消了本次任务。'});
  assert.equal(store.phase,'cancelled');
  assert.equal(store.runStatus,'cancelled');
  assert.equal(store.error,null,'取消不得置 error');
  // 终态后迟到事件不得翻回中间态
  feed(store,3,'run_completed',{steps:1,toolCalls:1,ms:400,answer:'late',durable:true});
  assert.equal(store.phase,'cancelled');
  assert.equal(store.runStatus,'cancelled');
});

test('T1-05 工具全部返回且未出正文 → 回 model；再次 tool_started → tool',()=>{
  setActivePinia(createPinia());
  const store=useRunStore();
  store.beginRun('查询课表');
  feed(store,0,'run_started',{engine:'demo',sourceType:'snapshot',serverNow:{iso:'',date:'',time:'',weekday:1,weekdayLabel:'',timezone:''},term:{term:'',termStart:null,weekNo:null,weekDeterminable:false,note:''},allowedTools:[]});
  feed(store,1,'tool_started',{tool:'query_schedule',toolCallId:'a',args:{},step:1});
  feed(store,2,'tool_started',{tool:'query_lab_status',toolCallId:'b',args:{},step:2});
  feed(store,3,'tool_result',{tool:'query_schedule',toolCallId:'a',ok:true,ms:5,summary:'ok',step:1});
  assert.equal(store.phase,'tool','还有一个工具未返回，保持 tool');
  feed(store,4,'tool_result',{tool:'query_lab_status',toolCallId:'b',ok:true,ms:6,summary:'ok',step:2});
  assert.equal(store.phase,'model','工具全部返回、尚未出正文 → model');
  feed(store,5,'tool_started',{tool:'query_free_rooms',toolCallId:'c',args:{},step:3});
  assert.equal(store.phase,'tool');
});

test('T1-06 白名单外的异常事件序列：store 降级告警维持原相位，不抛出',()=>{
  setActivePinia(createPinia());
  const store=useRunStore();
  // 未 beginRun（phase=idle）就先来 tool_started：idle→tool 不在白名单
  assert.doesNotThrow(()=>{feed(store,1,'tool_started',{tool:'query_schedule',toolCallId:'a',args:{},step:1});});
  assert.equal(store.phase,'idle','非法转移被降级为告警，相位维持原状');
  assert.equal(store.events.length,1,'事件本身仍入轨迹（展示事实不受相位约束）');
});
