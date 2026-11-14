import {clientFetch} from '../client';
import {ref,watch} from 'vue';
import {useRunStore} from '../stores/run';
import {useSessionStore,type ChatMessage} from '../stores/session';
import {useAgentStream} from './useAgentStream';
import {actorHeaders} from '../actor';
import {useFeedback} from '../mobile/feedback';
/** Retained by the mobile shell while changing views; navigation never cancels a run. */
export function useConversationController(onAccepted?:(id:string)=>void){
 const run=useRunStore(),session=useSessionStore(),stream=useAgentStream(),feedback=useFeedback(),submitting=ref(false),error=ref(''),activeConversation=ref<string|null>(null);let token='',messageId='';
 function live(){return activeConversation.value?session.messages[activeConversation.value]?.find(m=>m.id===messageId):null;}
 function update(){const target=live();if(!target)return;target.text=run.stream;target.status=run.runStatus==='running'?'streaming':run.runStatus==='completed'?'completed':run.runStatus==='cancelled'?'cancelled':'failed';target.toolCalls=[...run.toolCalls];target.engine=run.engine;target.model=run.model;target.sourceType=run.sourceType;target.ms=run.elapsedMs;target.error=run.error?{...run.error}:null;}
 watch(()=>[run.stream,run.runStatus,run.elapsedMs,run.toolCalls],update);
 async function submit(text:string,mode:'chat'|'task'='task'){
  if(submitting.value||run.inputLocked||!text.trim()||session.currentId&&session.activeRuns[session.currentId])return;
  const question=text.trim(),clientRequestId=session.uid('req');submitting.value=true;error.value='';
  try{
   const id=await session.ensureConversation(question,session.currentId,clientRequestId,mode);
   if(!session.messages[id]?.some(m=>m.id===`local-u-${clientRequestId}`))session.appendLocal(id,{id:`local-u-${clientRequestId}`,role:'user',text:question,status:'completed',toolCalls:[],createdAt:new Date().toISOString()});
   const clientRun=run.beginRun(question);token=clientRun;activeConversation.value=id;messageId=`live-${clientRun}`;
   session.appendLocal(id,{id:messageId,role:'assistant',text:'',status:'streaming',toolCalls:[],responseMode:session.currentMode(),createdAt:new Date().toISOString()});onAccepted?.(id);submitting.value=false;
   await stream.start({message:question,conversationId:id,clientRequestId,runId:clientRun,onEvent:event=>{
    if(token!==clientRun)return;
    if(event.type==='run_accepted'){const p=event.payload as Record<string,unknown>;run.adoptRunId(String(event.runId));session.adoptIds(id,clientRequestId,clientRun,String(p['userMessageId']),String(p['assistantMessageId']));messageId=String(p['assistantMessageId']);session.saveDraft(id,'');session.saveDraft('__new','');return;}
    if(event.type==='run_queued'){const p=event.payload as Record<string,unknown>;feedback.toast(typeof p['message']==='string'?String(p['message']):'正在排队，稍后自动开始');return;}
    run.ingest(event);update();
   },onError:failure=>{if(token===clientRun){run.failRun(failure);session.saveDraft(id,question);update();}},onClose:()=>{if(token!==clientRun)return;run.finishRun();update();activeConversation.value=null;token='';void session.loadConversations();}});
  }catch(e){error.value=(e as Error).message;session.saveDraft(session.currentId||'__new',question);}
  finally{submitting.value=false;}
 }
 async function stop(){const id=run.runId;if(id)await clientFetch('/api/runs/'+encodeURIComponent(id)+'/cancel',{method:'POST',headers:actorHeaders()}).catch(()=>undefined);stream.cancel();}
 function dispose(){token='';stream.cancel();activeConversation.value=null;submitting.value=false;}
 function retryText(message:ChatMessage){return message.text;}
 return {submitting,error,activeConversation,submit,stop,dispose,retryText};
}
