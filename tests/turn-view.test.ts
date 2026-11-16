import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@shared/'))return next(new URL('../shared/'+specifier.slice(8)+'.ts',import.meta.url).href,context);if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);return next(specifier,context);}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {buildTurnRenderUnit,shouldForceExpand,toolTitle}=await import('../web/lib/turn-view.ts');

type Step=Parameters<typeof buildTurnRenderUnit>[0][number];
function step(id:string,over:Partial<Step>={}):Step{
  return {id,kind:'tool',title:'查询课表',detail:'',status:'done',...over};
}
/** 复刻一次真实的 12 步序列：同一工具多次调用只应计一次 chosenTools */
function twelveSteps():Step[]{
  const out:Step[]=[{id:'s0',kind:'start',title:'任务已受理',detail:'',status:'done'}];
  const tools=['query_schedule','query_lab_status','query_schedule','query_free_rooms','prepare_issue_ticket','query_schedule','query_knowledge','query_lab_status','prepare_notification','query_schedule','prepare_duty_session','create_operations_report'];
  tools.forEach((t,i)=>out.push(step(`t${i}`,{tool:t,title:toolTitle(t)})));
  out.push({id:'ans',kind:'answer',title:'回答完成',detail:'',status:'done'});
  return out;
}

test('T2-01 12 步序列：toolCount 与 chosenTools 去重保序正确',()=>{
  const unit=buildTurnRenderUnit(twelveSteps(),{running:false,interrupted:false,serverMs:8400});
  assert.equal(unit.toolCount,12,'toolCount = 工具步数');
  assert.deepEqual(unit.chosenTools,['query_schedule','query_lab_status','query_free_rooms','prepare_issue_ticket','query_knowledge','prepare_notification','prepare_duty_session','create_operations_report']);
});

test('T2-02 回归陷阱：失败步标题为"查询未成功"时，chosenTools 不得出现该中文字符串',()=>{
  const steps=[
    step('a',{tool:'query_schedule',title:'查询未成功',status:'failed'}),
    step('b',{tool:'query_lab_status',title:'查询未成功',status:'failed'})
  ];
  const unit=buildTurnRenderUnit(steps,{running:false,interrupted:false,serverMs:null});
  assert.deepEqual(unit.chosenTools,['query_schedule','query_lab_status']);
  assert.ok(!unit.chosenTools.includes('查询未成功'),'必须用真实工具名，不能从中文标题反推');
});

test('T2-03 shouldForceExpand：运行中/中断/失败一律展开，仅正常完成收起',()=>{
  const steps=[step('a',{tool:'query_schedule'})];
  const running=buildTurnRenderUnit(steps,{running:true,interrupted:false,serverMs:null});
  assert.equal(running.workStatus.state,'running');
  assert.equal(shouldForceExpand(running),true);

  const interrupted=buildTurnRenderUnit(steps,{running:false,interrupted:true,serverMs:5000});
  assert.equal(interrupted.workStatus.state,'interrupted');
  assert.equal(shouldForceExpand(interrupted),true);

  const failed=buildTurnRenderUnit([step('a',{tool:'query_schedule',status:'failed'})],{running:false,interrupted:false,serverMs:5000});
  assert.equal(failed.hasFailure,true);
  assert.equal(shouldForceExpand(failed),true,'有失败步骤的正常终态也要展开');

  const ok=buildTurnRenderUnit(steps,{running:false,interrupted:false,serverMs:5000});
  assert.equal(ok.workStatus.state,'completed');
  assert.equal(shouldForceExpand(ok),false,'正常完成默认收起');
});

test('T2-04 orphan 场景：缺完成时间 → interrupted，且 label 不含任何数字',()=>{
  const unit=buildTurnRenderUnit([step('a',{tool:'query_schedule'})],{running:false,interrupted:false,serverMs:null});
  assert.equal(unit.workStatus.state,'interrupted','终态缺完成时间不得伪造 completed');
  assert.equal(unit.workStatus.label,'已停止');
  assert.ok(!/\d/.test(unit.workStatus.label),'interrupted 不得附带耗时');
});

test('T2-05 中断轮即使有服务端耗时也不显示数字',()=>{
  const unit=buildTurnRenderUnit([step('a',{tool:'query_schedule'})],{running:false,interrupted:true,serverMs:12345});
  assert.equal(unit.workStatus.state,'interrupted');
  assert.ok(!/\d/.test(unit.workStatus.label));
});

test('T2-06 已完成且拿到服务端毫秒 → 显示"已完成"（11-14 起不显示秒数）',()=>{
  const unit=buildTurnRenderUnit([step('a',{tool:'query_schedule'})],{running:false,interrupted:false,serverMs:8400});
  assert.equal(unit.workStatus.state,'completed');
  assert.equal(unit.workStatus.label,'已完成');
  assert.ok(!/\d/.test(unit.workStatus.label),'完成态不得再拼秒数');
});

test('T2-07 toolTitle 单一事实源：已知工具返回中文类别名，未知工具兜底',()=>{
  assert.equal(toolTitle('query_schedule'),'查询课表');
  assert.equal(toolTitle('prepare_issue_ticket'),'准备报修单');
  assert.equal(toolTitle('brand_new_tool'),'执行 brand_new_tool');
});
