import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@shared/'))return next(new URL('../shared/'+specifier.slice(8)+'.ts',import.meta.url).href,context);if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);return next(specifier,context);}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {decideContextBudget,estimateTokens,describeBudget}=await import('../shared/context-budget.ts');

const base={
  enabled:true,contextWindow:100000,outputReserveTokens:8000,thresholdRatio:0.75,
  estimatedTokens:0,historyTurns:3,consecutiveFailures:0,circuitBreakerAfter:3
};

test('T6-01 disabled：关闭开关时恒不精简，但估算值仍如实报出',()=>{
  const d=decideContextBudget({...base,enabled:false,estimatedTokens:999999});
  assert.equal(d.shouldTrim,false);
  assert.equal(d.reason,'disabled');
  assert.equal(d.estimatedTokens,999999,'关闭也要能看到估算（可观测性不能被开关关掉）');
  assert.match(describeBudget(d),/已关闭/);
});

test('T6-02 not_enough_turns：没有可精简的历史时不动作',()=>{
  const d=decideContextBudget({...base,historyTurns:0,estimatedTokens:100});
  assert.equal(d.shouldTrim,false);
  assert.equal(d.reason,'not_enough_turns');
});

test('T6-03 below_threshold / above_threshold：阈值分母已先扣输出预留',()=>{
  // 有效窗口 = 100000-8000 = 92000；阈值 = 92000*0.75 = 69000
  const under=decideContextBudget({...base,estimatedTokens:68999});
  assert.equal(under.reason,'below_threshold');
  assert.equal(under.effectiveContextWindow,92000);
  assert.equal(under.threshold,69000);
  const over=decideContextBudget({...base,estimatedTokens:69001});
  assert.equal(over.reason,'above_threshold');
  assert.equal(over.shouldTrim,true);
});

test('T6-04 circuit_breaker：连续失败达阈值后停止再处理，且如实报告原因',()=>{
  const d=decideContextBudget({...base,estimatedTokens:999999,consecutiveFailures:3});
  assert.equal(d.shouldTrim,false);
  assert.equal(d.reason,'circuit_breaker');
  assert.match(describeBudget(d),/停止再处理/);
});

test('T6-05 effectiveContextWindow 永不为负：预留超过窗口时被夹到窗口本身',()=>{
  const d=decideContextBudget({...base,contextWindow:4096,outputReserveTokens:999999});
  assert.equal(d.effectiveContextWindow,0);
  assert.ok(d.effectiveContextWindow>=0);
  assert.equal(d.outputReserveTokens,4096,'预留不能超过窗口');
  assert.equal(d.threshold,0);
});

test('T6-06 估算口径：中文按字符≈1 token，拉丁按 4 字符≈1 token（保守），且标注 estimate',()=>{
  assert.equal(estimateTokens(''),0);
  assert.equal(estimateTokens('中文五个字'),5);
  assert.equal(estimateTokens('abcd'),1);
  assert.equal(estimateTokens('abcdefgh'),2);
  const d=decideContextBudget({...base,estimatedTokens:estimateTokens('实'.repeat(1000))});
  assert.equal(d.tokenSource,'estimate','禁止把估算标成真实 usage');
  assert.equal(d.estimatedTokens,1000);
});

test('T6-07 describeBudget：五种 reason 都有可读说明，且都带估算值',()=>{
  for(const reason of ['disabled','not_enough_turns','below_threshold','above_threshold','circuit_breaker'] as const){
    const d=decideContextBudget({...base,estimatedTokens:12345});
    const forced={...d,reason};
    const text=describeBudget(forced);
    assert.ok(text.length>0,`${reason} 缺说明`);
    assert.match(text,/上下文/);
  }
});

test('T6-08 敏感事实不在精简范围内：决策对象只描述"精简了几条工具结果"，不含任何业务字段',()=>{
  const d=decideContextBudget({...base,estimatedTokens:90000,trimmed:{toolResultsDropped:4,historyTurnsDropped:0}});
  assert.deepEqual(d.trimmed,{toolResultsDropped:4,historyTurnsDropped:0});
  assert.ok(!('scopeKey' in d)&&!('version' in d),'预算对象不得携带权限作用域/版本字段');
  assert.match(describeBudget(d),/已精简 4 条/);
});
