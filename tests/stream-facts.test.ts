import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labops-stream-'));
process.env.LABOPS_DB_PATH=path.join(temp,'test.sqlite');
process.env.AGNES_API_KEY='fixture-not-a-real-key';
process.env.AGENT_WALL_CLOCK_MS='5000';
const {parseSseStream}=await import('../server/llm/agnes.ts');
const {runAgent}=await import('../server/agent/run.ts');
const {getDb}=await import('../server/persistence/db.ts');
async function gather<T>(items:AsyncIterable<T>):Promise<T[]>{const out:T[]=[];for await(const item of items)out.push(item);return out;}
const stream=(text:string)=>new ReadableStream<Uint8Array>({start(c){const data=new TextEncoder().encode(text);for(let i=0;i<data.length;i+=7)c.enqueue(data.slice(i,i+7));c.close();}});
const chunk=(delta:unknown,finish:unknown=null,usage?:unknown)=>'data: '+JSON.stringify({choices:[{delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n';
async function collect(body:string){return gather(parseSseStream(stream(body),new AbortController().signal));}
test('中文任意UTF8分块、正常结束标记和usage可以完整解析',async()=>{
  const result=await collect(chunk({content:'实验室课表'},'stop',{prompt_tokens:3,completion_tokens:2,total_tokens:5})+'data: [DONE]\n\n');
  assert.deepEqual(result.filter(x=>x.type==='text').map(x=>x.text),['实验室课表']);assert.ok(result.some(x=>x.type==='usage'&&x.usage.totalTokens===5));
});
test('EOF、损坏JSON、长度截断、过滤终止都不会当作成功',async()=>{
  for(const body of [chunk({content:'半段内容'}), 'data: broken\n\n',chunk({content:'截断'},'length')+'data: [DONE]\n\n',chunk({},'content_filter')+'data: [DONE]\n\n'])await assert.rejects(()=>collect(body));
});
test('不完整工具调用不能交付给执行器',async()=>{
  await assert.rejects(()=>collect(chunk({tool_calls:[{index:0,id:'x',function:{name:'prepare_issue_ticket',arguments:'{}'}}]},'stop')+'data: [DONE]\n\n'));
});
test('模型编造的课程不会进入答案；各轮token累加；多轮表格不再请求模型',async()=>{
  // 本测试验的是**多次模型往返**下 usage 累加；be22aa8 的单程快捷会合法跳过第二轮，
  // 故在此显式关短（AGENT_SINGLE_PASS=0）钉住旧前提，不改断言强度。
  const original=globalThis.fetch,originalSinglePass=process.env.AGENT_SINGLE_PASS;process.env.AGENT_SINGLE_PASS='0';let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    const body=calls===1?chunk({tool_calls:[{index:0,id:'s',function:{name:'query_schedule',arguments:JSON.stringify({date:'2026-09-28',labName:'E310'})}}]},'tool_calls',{prompt_tokens:10,completion_tokens:2,total_tokens:12}):chunk({content:'有数据库原理和数据结构与算法'},'stop',{prompt_tokens:20,completion_tokens:3,total_tokens:23});
    return new Response(body+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const actor={id:'fact-owner',role:'admin' as const,label:'test'};
    const events=await gather(runAgent({question:'查询E310在2026-09-28的课表',sessionId:'fact-session',actor}));
    const done=events.find(e=>e.type==='run_completed')!.payload as {answer:string;usage:{totalTokens:number}};
    assert.ok(done.usage.totalTokens>35,'usage must accumulate across model rounds (model-era: extra answer round)');assert.ok(!done.answer.includes('数据库原理'));assert.ok(!done.answer.includes('数据结构与算法'));
    const follow=await gather(runAgent({question:'把刚才的查询结果改成两列表格，一列课程，一列上课节次',sessionId:'fact-session',actor}));
    const answer=(follow.find(e=>e.type==='run_completed')!.payload as {answer:string}).answer;
    assert.ok(calls>=2,'second model round must happen (model-era: 3 calls = tool round + answer round + follow)');assert.equal(answer.split('\n').filter(l=>l.startsWith('|')).length,10);
    const other=await gather(runAgent({question:'把刚才的查询结果改成两列表格',sessionId:'fact-session',actor:{...actor,id:'other'}}));
    // 默认放行后由事实权限层拒绝跨身份转换，不再被领域门控提前改成范围引导。
    const isolated=other.find(e=>e.type==='run_failed')!.payload as {code:string;message:string};
    assert.equal(isolated.code,'evidence_missing');assert.match(isolated.message,/没有该身份与授权范围下的历史课表依据/);
    assert.ok(!isolated.message.includes('示例程序设计'));assert.ok(!isolated.message.includes('|'));assert.ok(calls>=2);
    assert.ok(other.every(e=>!['tool_started','tool_result','answer_delta','run_completed'].includes(e.type)));
  }finally{globalThis.fetch=original;if(originalSinglePass===undefined)delete process.env.AGENT_SINGLE_PASS;else process.env.AGENT_SINGLE_PASS=originalSinglePass;}
});
test('贯穿模型请求的deadline在超时时中止，不发送完成事件',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(_input,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
  const start=Date.now();
  try{const events=await gather(runAgent({question:'查询E310今日课表'}));assert.ok(Date.now()-start<6500);assert.ok(events.some(e=>e.type==='run_failed'&&(e.payload as {code:string}).code==='deadline_exceeded'));assert.ok(events.every(e=>e.type!=='run_completed'));}
  finally{globalThis.fetch=original;}
});
after(()=>{getDb().close();fs.rmSync(temp,{recursive:true,force:true});});
