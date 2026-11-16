/* Shared SSE framing and durable terminal semantics; mirrors generated for Vue. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.LabOpsSSE=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function createDecoder(onEvent){
  const decoder=new TextDecoder();let buffer='',lastSeq=-2;
  function flush(){buffer=buffer.replace(/\r\n/g,'\n');let k;while((k=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,k);buffer=buffer.slice(k+2);const lines=block.split('\n'),name=lines.find(s=>s.startsWith('event:'))?.slice(6).trim(),data=lines.filter(s=>s.startsWith('data:')).map(s=>s.slice(5).replace(/^ /,'')).join('\n');if(!data)continue;let event;try{event=JSON.parse(data);}catch{continue;}if(!event.type)event.type=name;if(typeof event.seq==='number'){if(event.seq<=lastSeq)continue;lastSeq=event.seq;}onEvent(event);}}
  return {push(chunk){buffer+=typeof chunk==='string'?chunk:decoder.decode(chunk,{stream:true});flush();},finish(){buffer+=decoder.decode();flush();}};
 }
 function terminal(event){
  const p=event.payload||event,type=event.type;
  if(['save_failed','persistence_failed'].includes(type)||type==='end'&&p.saved===false)return {done:true,saved:false,status:'failed',error:p.message||p.saveError||'回答已生成，但历史保存失败；请保留内容并按会话编号回查，勿自动重发'};
  if(type==='run_failed')return {done:true,saved:false,status:'failed',error:p.message||p.error?.message||'查询失败'};
  if(type==='run_cancelled')return {done:true,saved:false,status:'cancelled',error:p.message||'已停止本轮'};
  if(type==='run_completed'&&p.durable===true)return {done:true,saved:true,status:'completed',error:null};
  if(type==='end'&&p.saved===true)return {done:true,saved:true,status:p.status||'completed',error:p.status==='failed'?'本轮失败，失败记录已保存，请按会话编号回查':p.status==='cancelled'?'本轮已停止，已有内容已保存':null};
  return null;
 }
 return {createDecoder,terminal};
});
