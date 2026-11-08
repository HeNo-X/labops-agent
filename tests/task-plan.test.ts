/**
 * A5 任务计划复述（todo recitation）+ 计划面板
 * ============================================================================
 *  借鉴 Manus 经验 6 / ZCode TodoWrite：多步任务让模型维护步骤计划，每轮重读。
 *  本文件锁死：① 步骤规范化边界（≤12 步、80 字、状态回退）；② 工具执行口径
 *  （工作记录，空计划拒绝）；③ 注册表暴露面（chat/task 都可用）；④ 事件契约
 *  （plan_updated 在 RUN_EVENT_TYPES）；⑤ UI 装配（PC/移动共用一个面板，R6）。
 */
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@shared/'))return next(new URL('../shared/'+specifier.slice(8)+'.ts',import.meta.url).href,context);if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);return next(specifier,context);}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {normalizePlanSteps, executeTaskPlan, PLAN_MAX_STEPS, PLAN_MAX_TEXT} from '../server/tools/task-plan.ts';
import {toolsForMode, executeTool} from '../server/tools/registry.ts';
import {RUN_EVENT_TYPES} from '../shared/types.ts';

test('A5-01 normalize：全量替换语义、id 稳定、状态回退 pending',()=>{
  const out=normalizePlanSteps([{text:' 查询 E310 课表 ',status:'pending'},{text:'比对空闲房间',status:'weird'},{text:'登记提案',status:'done'}]);
  assert.equal(out.steps.length,3);
  assert.deepEqual(out.steps.map(s=>s.id),['s1','s2','s3']);
  assert.equal(out.steps[0].text,'查询 E310 课表','首尾空白必须裁掉');
  assert.equal(out.steps[1].status,'pending','非法状态回退 pending（不猜语义）');
  assert.equal(out.steps[2].status,'done');
  assert.equal(out.droppedCount,0);
  assert.equal(out.invalidCount,0);
});

test('A5-02 normalize 边界：空 text 计 invalid、超 12 步丢弃并如实计数、超长文本截断',()=>{
  const many=normalizePlanSteps(Array.from({length:PLAN_MAX_STEPS+3},(_,i)=>({text:`步骤${i+1}`,status:'pending'})));
  assert.equal(many.steps.length,PLAN_MAX_STEPS);
  assert.equal(many.droppedCount,3,'超出上限的步骤必须如实计数丢弃');
  const trimmed=normalizePlanSteps([{text:'y'.repeat(PLAN_MAX_TEXT+10),status:'pending'}]);
  assert.equal(trimmed.steps[0].text.length,PLAN_MAX_TEXT,'单步文字截到上限');
  const invalid=normalizePlanSteps([{text:'  '},{text:42}]);
  assert.equal(invalid.steps.length,0);
  assert.equal(invalid.invalidCount,2,'空白与非字符串 text 都算非法');
});

test('A5-03 executeTaskPlan：正常登记返回 task_plan（不冒充业务结果）；空计划拒绝',()=>{
  const ok=executeTaskPlan({steps:[{text:'查询课表',status:'done'},{text:'准备停用方案',status:'pending'}]});
  assert.equal(ok.ok,true);
  if(ok.ok){
    assert.equal(ok.resultKind,'task_plan');
    assert.equal(ok.result.steps.length,2);
    assert.match(ok.summary,/2 步（1 完成、1 待办、0 放弃）/);
  }
  const empty=executeTaskPlan({steps:[]});
  assert.equal(empty.ok,false);
  if(!empty.ok)assert.equal(empty.code,'empty_plan');
});

test('A5-04 注册表暴露面：chat/task 两种模式都可用（effect=read，工作记录不分模式）',()=>{
  const names=(m:'chat'|'task')=>toolsForMode(m).map(t=>t.name);
  assert.ok(names('task').includes('maintain_task_plan'));
  assert.ok(names('chat').includes('maintain_task_plan'));
});

test('A5-05 executeTool 集成：经注册表真实调用返回 task_plan 计划',async()=>{
  const r=await executeTool('maintain_task_plan',{steps:[{text:'查询 D517 状态',status:'pending'},{text:'汇总给用户',status:'pending'}]},{mode:'task',dataset:{} as never,now:{} as never});
  assert.equal(r.ok,true);
  if(r.ok){
    assert.equal(r.resultKind,'task_plan');
    const steps=(r.result as {steps:Array<{id:string;text:string}>}).steps;
    assert.equal(steps[0].id,'s1');
    assert.match(r.summary,/任务计划已更新/);
  }
});

test('A5-06 事件契约：plan_updated 已登记进 RUN_EVENT_TYPES',()=>{
  assert.ok(RUN_EVENT_TYPES.includes('plan_updated' as (typeof RUN_EVENT_TYPES)[number]));
});

test('A5-07 UI 装配：PlanPanel 存在、被 ChatMessage 引用、活跃轮与历史轮同源（R6 无平台分支）',()=>{
  const panelSrc=readFileSync(fileURLToPath(new URL('../web/components/PlanPanel.vue',import.meta.url)),'utf8');
  const chatSrc=readFileSync(fileURLToPath(new URL('../web/components/ChatMessage.vue',import.meta.url)),'utf8');
  assert.ok(panelSrc.includes('data-testid="task-plan"'),'面板必须带稳定测试锚点');
  assert.ok(panelSrc.includes('tr('),'新增中文文案必须走 i18n（R2）');
  assert.ok(!/isMobile|platform\s*===|userAgent/.test(panelSrc),'共享组件不得做平台分支（R6）');
  assert.ok(chatSrc.includes("import PlanPanel from './PlanPanel.vue'"));
  assert.ok(chatSrc.includes('props.msg.plan'),'历史轮必须能从消息 meta.plan 回放');
  // 提示词纪律行已入 system prompt（稳定前缀的一部分），版本号随之递增
  const promptsSrc=readFileSync(fileURLToPath(new URL('../server/agent/prompts.ts',import.meta.url)),'utf8');
  assert.ok(promptsSrc.includes('maintain_task_plan'));
  assert.ok(promptsSrc.includes('labops-1.0.6-stable-prefix-v3'));
});
