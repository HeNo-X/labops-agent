import {clientFetch} from '../client';
import {requestScope,clearRequests} from '../auth/request-scope';
import {defineStore} from 'pinia';
import {ref} from 'vue';
import {responseError} from '../http';
import {useSessionStore} from './session';
import {initializePreferences} from '../preferences';
import {actorHeaders} from '../actor';
import type {NativeActor} from '@shared/business';
export async function businessApi<T>(path:string,body?:unknown):Promise<T>{
  // 2026-11-09 修：主系统的 /scheduled-jobs/delete 用严格字段白名单（只认 jobId+scopeKey），
  // 这里若再自动塞 conversationId 会被判「包含不支持的字段」。删除与当前会话无关，跳过注入。
  if(body&&path.startsWith('proxy/')&&!['proxy/notifications/read','proxy/notifications/read-batch','proxy/reminder-preferences','proxy/scheduled-jobs/delete'].includes(path)){const id=useSessionStore().currentId;if(id)body={...(body as Record<string,unknown>),conversationId:id};}
  const scope=requestScope();try{const res=await clientFetch('/api/business/'+path,{method:body===undefined?'GET':'POST',headers:{...actorHeaders(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([scope.signal,AbortSignal.timeout(15000)])});
  if(!res.ok)throw await responseError(res);const data=await res.json();if(!scope.current())throw new Error('账号范围已变化');return data as T;}finally{scope.done();}
}
export const useBusinessStore=defineStore('business',()=>{
 const accountLinks=ref<Record<string,string>>({});
 const connected=ref(false),scopeKey=ref(''),profile=ref<NativeActor|null>(null),state=ref('disconnected'),error=ref(''),busy=ref(false);
 let generation=0;
 function clearPrivate(){generation++;clearRequests();connected.value=false;scopeKey.value='';profile.value=null;accountLinks.value={};state.value='disconnected';error.value='';}
 async function refresh(){const epoch=++generation;try{const s=await businessApi<{connected:boolean;profile:NativeActor|null;state:string;scopeKey?:string;message?:string;accountLinks?:Record<string,string>}>('status');if(epoch!==generation)return;connected.value=s.connected;profile.value=s.profile;accountLinks.value=s.accountLinks||{};if(s.profile)initializePreferences(s.profile);state.value=s.state;scopeKey.value=s.connected?s.scopeKey||'':'';error.value=s.message||'';}catch(e){if(epoch!==generation)return;connected.value=false;scopeKey.value='';state.value='unavailable';profile.value=null;accountLinks.value={};error.value=(e as Error).message;}}
 async function connect(account:string,password:string){busy.value=true;error.value='';try{await businessApi('connect',{account,password});await refresh();}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
 async function disconnect(){busy.value=true;try{const r=await businessApi<{message:string}>('disconnect',{});await refresh();error.value=r.message;}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
 return {accountLinks,clearPrivate,connected,scopeKey,profile,state,error,busy,refresh,connect,disconnect};
});
