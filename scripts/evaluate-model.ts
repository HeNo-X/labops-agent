/** Real-model evaluation only. A missing key is reported as not_run; the deterministic engine is never substituted silently. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labops-model-eval-'));process.env.LABOPS_DB_PATH=path.join(temp,'eval.sqlite');process.env.LIVE_DATA='0';
const {getConfig,PROJECT_ROOT}=await import('../server/config.ts');const cfg=getConfig();
const {isAgnesConfigured}=await import('../server/llm/agnes.ts');const {PROMPT_VERSION}=await import('../server/agent/prompts.ts');const {getDb}=await import('../server/persistence/db.ts');
const {runAgent}=await import('../server/agent/run.ts');const {requestIdentity}=await import('../server/security/context.ts');
const output=process.env.LABOPS_EVAL_OUTPUT||path.join(PROJECT_ROOT,'.evaluation','real-model.json');fs.mkdirSync(path.dirname(output),{recursive:true});
const file=path.join(PROJECT_ROOT,'evaluation','core-scenarios.json'),scenarios=JSON.parse(fs.readFileSync(file,'utf8')) as Array<{id:string;category:string;turns:string[];expect:Record<string,unknown>}>;
const version=JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT,'package.json'),'utf8')).version;
const commit=(()=>{try{return execFileSync('git',['rev-parse','HEAD'],{cwd:PROJECT_ROOT,encoding:'utf8'}).trim();}catch{return 'unavailable';}})();
const workingTreeDirty=(()=>{try{return Boolean(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:PROJECT_ROOT,encoding:'utf8'}).trim());}catch{return null;}})();
const basis={version,commit,workingTreeDirty,datasetMode:'bundled_snapshot',promptVersion:PROMPT_VERSION,model:cfg.agnes.model,scenarioSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),snapshotSha256:crypto.createHash('sha256').update(fs.readFileSync(cfg.data.snapshotPath)).digest('hex'),startedAt:new Date().toISOString(),runType:'real_model',scope:scenarios.length+'个独立模型查询/多轮/拒答场景；人工提交、联合原子性和移动端由独立测试/浏览器验收验证'};
if(!isAgnesConfigured()){
 fs.writeFileSync(output,JSON.stringify({...basis,status:'not_run',reason:'未配置AGNES_API_KEY；未调用真实模型。',scenariosPlanned:scenarios.length,samples:0,accuracy:null,cost:null},null,2));console.log('真实模型评测未运行：缺少AGNES_API_KEY。状态报告：'+output);fs.rmSync(temp,{recursive:true,force:true});process.exitCode=2;
}else{
 const results:Array<Record<string,unknown>>=[];const repeats=Math.max(1,Math.min(5,Number(process.env.LABOPS_EVAL_REPEATS)||1));
 try{for(let repeat=0;repeat<repeats;repeat++)for(const scenario of scenarios){
   const actor={id:`eval-${scenario.id}-${repeat}`,role:'admin' as const,label:'隔离评测'},sessionId=`eval-${scenario.id}-${repeat}`,events=[];const began=performance.now();
   for(const question of scenario.turns){const turn=[];await requestIdentity.run(actor,async()=>{for await(const e of runAgent({question,actor,sessionId,mode:'task'}))turn.push(e);});events.push(turn);}
   const last=events.at(-1)||[],done=last.find(e=>e.type==='run_completed')?.payload as Record<string,unknown>|undefined,failed=last.find(e=>e.type==='run_failed')?.payload as Record<string,unknown>|undefined;
   const facts=last.filter(e=>e.type==='tool_result'&&(e.payload as {ok:boolean}).ok).map(e=>e.payload as {resultKind:string;result:Record<string,unknown>});
   const expected=scenario.expect;const problems:string[]=[];
   if(expected['failure']){if(failed?.['code']!==expected['failure'])problems.push('拒答状态不匹配');}else if(!done)problems.push('未完成本轮');
   const fact=facts.find(f=>f.resultKind===expected['kind'])||facts[0];const text=String(done?.['answer']||'');
   if(expected['kind']&&!facts.some(f=>f.resultKind===expected['kind']))problems.push('缺少预期工具事实');
   for(const key of ['labName','date'])if(expected[key]&&fact?.result[key]!==expected[key])problems.push(key+'不匹配');
   if(expected['records']!==undefined&&Array.isArray(fact?.result['lessons'])&&fact.result['lessons'].length!==expected['records'])problems.push('记录数错误');
   if(expected['hits']!==undefined&&Array.isArray(fact?.result['hits'])&&fact.result['hits'].length!==expected['hits'])problems.push('知识命中数量错误');
   if(expected['strategy']&&done?.['strategy']!==expected['strategy'])problems.push('历史/重查策略错误');
   if(expected['tableRows']!==undefined&&text.split('\n').filter(l=>l.startsWith('|')).length-2!==expected['tableRows'])problems.push('表格行数错误');
   if(expected['contains']&&!text.includes(String(expected['contains'])))problems.push('预期展示字段缺失');
   const usage=events.flat().filter(e=>e.type==='run_completed').reduce((n,e)=>n+Number((e.payload as {usage?:{totalTokens:number}}).usage?.totalTokens||0),0);
   results.push({id:scenario.id,repeat,category:scenario.category,passed:!problems.length,problems,ms:performance.now()-began,totalTokens:usage,turns:events.map((turn,i)=>({question:scenario.turns[i],events:turn})),failure:failed||null});console.log(`${scenario.id} repeat=${repeat+1} ${problems.length?'FAIL':'PASS'}`);
 }
 const times=results.map(r=>Number(r['ms'])).sort((a,b)=>a-b),quantile=(p:number)=>times[Math.max(0,Math.ceil(times.length*p)-1)]??null;
 const report={...basis,status:'completed',endedAt:new Date().toISOString(),samples:results.length,passed:results.filter(r=>r['passed']).length,failed:results.filter(r=>!r['passed']).length,medianMs:quantile(.5),p95Ms:quantile(.95),totalTokens:results.reduce((n,r)=>n+Number(r['totalTokens']),0),cost:null,costNote:'实际费用未连接账单，以模型服务账单为准；不得以示例单价冒充实际费用。',results};fs.writeFileSync(output,JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;console.log('真实模型结果与失败样本：'+output);
 }finally{getDb().close();fs.rmSync(temp,{recursive:true,force:true});}
}
