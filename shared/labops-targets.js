// Generated from Pages/lib/labops-targets.js; npm run sync:rules
const api=(()=>{
 'use strict';
 const VIEWS={home:[],assistant:['section'],sessions:['section'],settings:['category'],conversation:['conversationId'],rooms:[],room:['roomId','action'],automation:[],job:['jobId'],task:['taskId'],messages:[],notice:['noticeId'],profile:[],evidence:['roomId','issueId']};
 function normalize(raw){
  if(raw==null)return {view:'home'};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('跳转目标无效');
  const view=typeof raw.view==='string'&&Object.hasOwn(VIEWS,raw.view)?raw.view:'home',allowed=VIEWS[view];
  if(Object.keys(raw).some(k=>k!=='view'&&!allowed.includes(k)))throw new Error('跳转字段无效');
  const target={view};
  for(const key of allowed){const v=raw[key];if(v==null)continue;if(typeof v!=='string'||!(/^[A-Za-z0-9_-]{1,100}$/).test(v))throw new Error('目标编号无效');if(key==='category'&&!['personalization','general','advanced','account'].includes(v))throw new Error('设置分类无效');if(key==='section'&&!['work','chat'].includes(v)||key==='action'&&!['schedule','duty','issues','closures','notifications'].includes(v))throw new Error('目标动作无效');target[key]=v;}
  if(['conversation','room','job','task','notice'].includes(view)&&!target[allowed[0]])throw new Error('缺少目标编号');
  return target;
 }
 function search(target){return new URLSearchParams(normalize(target)).toString();}
 return {VIEWS,normalize,search};
})();
export default api;
