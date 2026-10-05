import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn,type ChildProcess} from 'node:child_process';import {fileURLToPath} from 'node:url';
// @ts-expect-error The fixture is a plain JavaScript CLI.
import {createReviewFixture} from '../scripts/create-review-fixture.mjs';
test('A13/A14/A29 实际主系统进程重启后按真实时钟投递，退出源会话且无Agent/浏览器仍可运行',async()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'labops-live-jobs-')),fixture=createReviewFixture(folder),socket=http.createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));const base='http://127.0.0.1:'+port;let child:ChildProcess|undefined,logs='';
 async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await exited;}
 async function start(){child=spawn(process.execPath,[fileURLToPath(new URL('../../Pages/serve.js',import.meta.url))],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:folder,LABOPS_SCHEDULER_ENABLED:'1',LABOPS_AGENT_URL:'',LABOPS_PUBLIC_URL:'',REGISTER_OPEN:'0',ENABLE_BASE_SEED:'0',ENABLE_SEED_ACCOUNTS:'0'},stdio:['ignore','ignore','pipe']});child.stderr!.on('data',d=>logs+=d.toString());for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('主系统启动失败 '+logs);try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('主系统启动超时');}
 async function request(route:string,token?:string,body?:unknown){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200,route);return await r.json();}
 const account=fixture.accounts.find((a:any)=>a.identity==='volunteer');
 try{
  await start();const auth=await request('/api/auth/login',undefined,account),token=auth.token;
  await request('/api/integration/reminder-preferences',token,{enabled:true,quietStart:'00:00',quietEnd:'00:00',categories:['daily_report'],maxPerDay:8,maxPerEvent:3,minIntervalMinutes:0});
  const draft=await request('/api/integration/scheduled-jobs/preview',token,{spec:{kind:'daily_report',trigger:{type:'once',at:new Date(Date.now()+2000).toISOString()},approvedEffects:['report','inbox']}}),confirmed=await request('/api/integration/scheduled-jobs/confirm',token,{planId:draft.plan.id});
  await request('/api/auth/logout',token,{});await stop();await start();
  const fresh=(await request('/api/auth/login',undefined,account)).token;let rows:any[]=[];
  // SIGTERM deliberately leaves the old 15-second lease intact. Recovery must
  // wait for its expiry plus the five-second poll, rather than steal it early.
  for(let i=0;i<50;i++){rows=(await request('/api/integration/scheduled-results',fresh)).results;if(rows.some(r=>r.jobId===confirmed.job.id))break;await new Promise(r=>setTimeout(r,500));}
  const before=await request('/api/integration/scheduled-jobs/'+confirmed.job.id,fresh);assert.equal(rows.filter(r=>r.jobId===confirmed.job.id).length,1,JSON.stringify({status:before.job.status,runs:before.runs,logs}));assert.equal(before.runs.length,1);assert.equal(before.runs[0].status,'success');const saved=JSON.parse(fs.readFileSync(path.join(folder,'state.json'),'utf8')).state;assert.equal(saved.notifications.filter((n:any)=>n.jobId===confirmed.job.id).length,1);assert.equal(saved.scheduledReceipts.filter((r:any)=>r.jobId===confirmed.job.id).length,2);
  await stop();await start();const again=(await request('/api/auth/login',undefined,account)).token,after=await request('/api/integration/scheduled-jobs/'+confirmed.job.id,again);assert.equal(after.runs[0].id,before.runs[0].id);assert.equal(after.runs[0].status,'success');assert.equal((await request('/api/integration/scheduled-results',again)).results.filter((r:any)=>r.jobId===confirmed.job.id).length,1);
 }finally{await stop();fs.rmSync(folder,{recursive:true,force:true});}
});
