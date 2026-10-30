import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@shared/'))return next(new URL('../shared/'+specifier.slice(8)+'.ts',import.meta.url).href,context);if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);return next(specifier,context);}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {toolNames}=await import('../server/tools/registry.ts');
const {
  toolFamily,buildToolDisplay,clampText,terminalStateOf,TERMINAL_LABELS,DISPLAY_TEXT_BUDGET,familyLabel
}=await import('../web/lib/tool-display.ts');

test('T4-01 全部已注册工具都有明确族与双文案，无一落入 unknown',()=>{
  // 名单以 registry 的 toolNames() 为唯一事实源，不手写数组
  const names=Array.from(toolNames()) as string[];
  assert.ok(names.length>=18,`工具数量应不少于 18，实际 ${names.length}`);
  for(const name of names){
    const family=toolFamily(name);
    assert.notEqual(family,'unknown',`${name} 缺展示族（会退化成通用卡片）`);
    const running=buildToolDisplay({tool:name,ok:null,args:{}},{running:true});
    const done=buildToolDisplay({tool:name,ok:true,args:{},summary:'ok'},{running:false});
    assert.ok(running.runningLabel.length>0,`${name} 缺运行态动作名`);
    assert.ok(done.finalLabel.length>0,`${name} 缺终态类别名`);
    // 运行态必须是动作名（"正在…"），终态必须是类别名（不得再带"正在"）
    assert.match(running.runningLabel,/^正在/ ,`${name} 运行态应为动作名`);
    assert.doesNotMatch(done.finalLabel,/^正在/,`${name} 终态不得是动作名`);
  }
});

test('T4-02 未知工具兜底为 unknown 且有可读文案（不丢事实、不冒充已知族）',()=>{
  assert.equal(toolFamily('brand_new_tool'),'unknown');
  const d=buildToolDisplay({tool:'brand_new_tool',ok:true,args:{}},{running:false});
  assert.equal(d.family,'unknown');
  assert.equal(d.finalLabel,familyLabel('unknown',false));
  assert.match(d.primaryText,/brand_new_tool/);
});

test('T4-03 终态文案表覆盖四种状态，非成功终态不得借用成功文案',()=>{
  assert.deepEqual(Object.keys(TERMINAL_LABELS).sort(),['cancelled','failed','ok','running']);
  assert.equal(terminalStateOf(null),'running');
  assert.equal(terminalStateOf(true),'ok');
  assert.equal(terminalStateOf(false),'failed');
  assert.equal(terminalStateOf(true,true),'cancelled','取消优先于 ok');
  // 遍历断言：四种状态各有非空且互不相同的文案
  const labels=Object.values(TERMINAL_LABELS);
  assert.equal(new Set(labels).size,4);
  for(const l of labels) assert.ok(l.length>0);
  const failed=buildToolDisplay({tool:'query_schedule',ok:false,error:{code:'tool_error',message:'超时'}},{running:false});
  assert.equal(failed.stateLabel,TERMINAL_LABELS.failed);
  assert.notEqual(failed.stateLabel,TERMINAL_LABELS.ok);
  assert.equal(failed.hint,undefined,'失败时不得给出"结果去哪看"的成功引导');
});

test('T4-04 clampText 边界：恰好预算内不截断，超出按**字符**截断（中文多字节不按字节算）',()=>{
  const n=DISPLAY_TEXT_BUDGET.output;
  assert.equal(clampText('a'.repeat(n),n).truncated,false);
  const over=clampText('a'.repeat(n+1),n);
  assert.equal(over.truncated,true);
  assert.equal(Array.from(over.text).length,n);
  // 中文：2000 个汉字 = 2000 字符（UTF-8 下 6000 字节，若按字节算会提前截断）
  const zh=clampText('实'.repeat(n+500),n);
  assert.equal(zh.truncated,true);
  assert.equal(Array.from(zh.text).length,n);
  assert.ok(!zh.text.endsWith('\uFFFD'),'不得把多字节字符劈成半个');
  // emoji（代理对）不得被劈开
  const emoji=clampText('😀'.repeat(10),5);
  assert.equal(Array.from(emoji.text).length,5);
  assert.equal(emoji.text,'😀😀😀😀😀');
});

test('T4-05 长知识检索摘要按预算截断并置 truncated，UI 因此能提示"已截断"',()=>{
  const long='段落依据。'.repeat(800);
  const d=buildToolDisplay({tool:'query_knowledge',ok:true,summary:long},{running:false});
  assert.equal(d.output?.truncated,true);
  assert.ok(Array.from(d.output!.text).length<=DISPLAY_TEXT_BUDGET.output);
  assert.equal(d.primaryTruncated,true,'一行摘要也应有自己的预算');
  assert.ok(Array.from(d.primaryText).length<=DISPLAY_TEXT_BUDGET.primary);
  assert.equal(d.family,'knowledge');
});

test('T4-06 族的引导语：草稿明示"未执行"，视觉明示"非人工核验"，且都不重复正文',()=>{
  const draft=buildToolDisplay({tool:'prepare_issue_ticket',ok:true,summary:'草稿已生成'},{running:false});
  assert.equal(draft.family,'draft');
  assert.match(draft.hint??'',/未执行/);
  const vision=buildToolDisplay({tool:'analyze_evidence_image',ok:true,summary:'观察'},{running:false});
  assert.equal(vision.family,'vision');
  assert.match(vision.hint??'',/非人工核验/);
  assert.equal(vision.showInput,false,'视觉只关心附件编号，不展开参数');
});

test('T4-07 视觉与日报族不重复渲染完整内容（showOutput 仅在确有摘要时为真）',()=>{
  const vision=buildToolDisplay({tool:'analyze_evidence_image',ok:true},{running:false});
  assert.equal(vision.showOutput,false,'无摘要时不展开空块');
  const report=buildToolDisplay({tool:'create_operations_report',ok:true,summary:'日报 2026-10-30'},{running:false});
  assert.equal(report.family,'report');
  assert.match(report.hint??'',/卡片/);
});
