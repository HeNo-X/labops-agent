import {defineStore} from 'pinia';
import {ref} from 'vue';
import {responseError} from '../http';
import {useSessionStore} from './session';
import {actorHeaders} from '../actor';
import type {NativeActor} from '@shared/business';
export async function businessApi<T>(path:string,body?:unknown):Promise<T>{
  if(body&&path.startsWith('proxy/')&&path!=='proxy/notifications/read'){const id=useSessionStore().currentId;if(id)body={...(body as Record<string,unknown>),conversationId:id};}
  const res=await fetch('/api/business/'+path,{method:body===undefined?'GET':'POST',headers:{...actorHeaders(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw await responseError(res);const data=await res.json();return data as T;
}
export const useBusinessStore=defineStore('business',()=>{
 const connected=ref(false),scopeKey=ref(''),profile=ref<NativeActor|null>(null),state=ref('disconnected'),error=ref(''),busy=ref(false);
 async function refresh(){try{const s=await businessApi<{connected:boolean;profile:NativeActor|null;state:string;scopeKey?:string;message?:string}>('status');connected.value=s.connected;profile.value=s.profile;state.value=s.state;scopeKey.value=s.connected?s.scopeKey||'':'';error.value=s.message||'';}catch(e){connected.value=false;scopeKey.value='';state.value='unavailable';error.value=(e as Error).message;}}
 async function connect(account:string,password:string){busy.value=true;error.value='';try{await businessApi('connect',{account,password});await refresh();}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
 async function disconnect(){busy.value=true;try{const r=await businessApi<{message:string}>('disconnect',{});await refresh();error.value=r.message;}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
 return {connected,scopeKey,profile,state,error,busy,refresh,connect,disconnect};
});
