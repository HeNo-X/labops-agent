import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../Pages/lib/sync-client.js',import.meta.url),'utf8');
function harness(fetchImpl:(url:string,options:any)=>Promise<unknown>){
 const memory=new Map<string,string>([['lab_current_user',JSON.stringify({username:'signed-volunteer',identity:'volunteer'})],['vol_user_token','fixture-token'],['lab_system_state',JSON.stringify({volunteerRecords:[]})]]);
 const window:any={location:{protocol:'http:',search:''}};
 const context={window,location:window.location,localStorage:{getItem:(k:string)=>memory.get(k)||null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)},fetch:fetchImpl,setInterval:()=>1,console};
 vm.runInNewContext(source,context);return {api:window.LabSync,memory};
}
test('原签到客户端将409校验失败视为失败且不写成功缓存',async()=>{
 const h=harness(async()=>({ok:false,status:409,json:async()=>({error:'本人正式班次未配置'})}));
 await assert.rejects(h.api.addVolunteerRecord({id:'r1',type:'checkin'}),/正式班次未配置/);
 assert.equal(JSON.parse(h.memory.get('lab_system_state')!).volunteerRecords.length,0);
});
test('原签到客户端断网拒绝，不降级伪造已提交',async()=>{
 const h=harness(async()=>{throw new Error('network unavailable');});
 await assert.rejects(h.api.addVolunteerRecord({id:'r2',type:'checkin'}),/network unavailable/);
 assert.equal(JSON.parse(h.memory.get('lab_system_state')!).volunteerRecords.length,0);
});
test('原签到客户端成功后才写缓存，并使用登录账号替换显示姓名',async()=>{
 let sent:any;const h=harness(async(_url,options)=>{sent=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({ok:true,rev:8})};});
 await h.api.addVolunteerRecord({id:'r3',type:'checkin',username:'显示姓名'});
 assert.equal(sent.records[0].username,'signed-volunteer');assert.equal(JSON.parse(h.memory.get('lab_system_state')!).volunteerRecords[0].id,'r3');
});
