import {test} from 'node:test';import assert from 'node:assert/strict';
import {responseError} from '../web/http.ts';import {renderDemoAnswer} from '../server/agent/demo-engine.ts';import {loadDataset} from '../server/data/store.ts';import {runQuerySchedule} from '../server/tools/query-schedule.ts';import {serverNow} from '../server/time/term.ts';
test('A03 代理HTML、JSON null与429使用安全摘要和单一操作前缀',async()=>{
 const html=await responseError(new Response('<html><script>SECRET-PROXY-PAGE</script></html>',{status:403,headers:{'X-Request-ID':'request-test-403'}}));assert.match(html.message,/权限或请求来源/);assert.match(html.message,/request-test-403/);assert.ok(!html.message.includes('SECRET'));
 const nil=await responseError(new Response('null',{status:502}));assert.equal(nil.message,'上游服务不可用');
 const limit=await responseError(new Response(JSON.stringify({message:'请求过于频繁'}),{status:429,headers:{'Retry-After':'60','X-Request-ID':'request-test-429'}}));assert.match(limit.message,/60 秒后重试/);const displayed='创建会话失败：'+limit.message;assert.equal(displayed.split('创建会话失败').length-1,1);
});
test('A07 纯文本课表逐项保留中间课程、时间、班级、对象与取证信息',()=>{
 const ds=structuredClone(loadDataset()),row=ds.timetable.find(r=>r.labId===ds.labs.find(l=>l.name==='E310')!.id)!;ds.timetable=['首门课','中间课程','最后课程'].map((courseName,i)=>({...row,id:'text-lesson-'+i,weekday:1,periodKey:(['am1','pm1','eve_ab'] as const)[i]!,courseName,classNames:['文本测试班'],className:'文本测试班',weeks:{from:1,to:99,parity:'all' as const}}));
 const result=runQuerySchedule({labName:'E310',date:'2026-09-28'},ds,serverNow(new Date('2026-09-28T04:00:00Z'))),answer=renderDemoAnswer(result,{dateWasDefaulted:false,periodFiltered:false,textOnly:true,scopeLabel:'本人授权范围'});
 for(const name of ['首门课','中间课程','最后课程','text-lesson-0','text-lesson-1','text-lesson-2','文本测试班','查询时间','数据版本'])assert.ok(answer.includes(name),name);assert.ok(!answer.includes('下方课表卡'));assert.ok(!answer.includes('下方结果卡'));
});
