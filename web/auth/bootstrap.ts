import {clientFetch} from '../client';
import {ref} from 'vue';
import Targets,{type Target} from '@shared/labops-targets.js';
import {chooseLayout,saveLayout,type Layout} from './device-routing';
import {initializePreferences,preferences} from '../preferences';
import {responseError} from '../http';
export interface Profile {username:string;identity:'admin'|'volunteer';name?:string;className?:string}
export const auth={defaultEntry:ref(!new URLSearchParams(location.search).has('view')&&!new URLSearchParams(location.hash.slice(1)).has('labops-ticket')),loading:ref(true),authenticated:ref(false),mode:ref<'native'|'demo'>('native'),profile:ref<Profile|null>(null),error:ref(''),target:ref<Target>({view:'home'})};
let initial:Promise<void>|null=null,generation=0;
export function urlTarget():Target{
 const raw=Object.fromEntries(new URLSearchParams(location.search));delete raw.desktop;delete raw.mobile;
 return Targets.normalize(raw);
}
async function verify(){
 const epoch=++generation;auth.loading.value=true;auth.error.value='';
 try{
  const fragment=new URLSearchParams(location.hash.slice(1)),ticket=fragment.get('labops-ticket');
  // The credential is removed BEFORE any network operation or edition redirect.
  if(location.hash)history.replaceState(history.state,'',location.pathname+location.search);
  let selected:Target;try{selected=urlTarget();}catch(e){selected={view:'home'};auth.error.value=(e as Error).message;}
  const response=await clientFetch(ticket?'/api/auth/sso/exchange':'/api/auth/session',ticket?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})}:{});
  if(!response.ok)throw await responseError(response);
  const data=await response.json();if(epoch!==generation)return;
  auth.mode.value=data.mode==='demo'?'demo':'native';
  auth.authenticated.value=auth.mode.value==='demo'?Boolean(sessionStorage.getItem('labops.auth')):Boolean(data.authenticated)&&sessionStorage.getItem('labops.manual-logout')!=='1';
  if(data.profile?.identity==='student')throw new Error('学生账号只能使用主系统共享聊天，不能进入完整 LabOps');
  auth.profile.value=data.profile||null;initializePreferences(auth.authenticated.value?auth.profile.value:null);
  if(auth.defaultEntry.value)selected=preferences.value.mobileStart==='assistant'?{view:'assistant'}:{view:'home'};
  if(ticket&&data.target)selected=Targets.normalize(data.target);else if(ticket&&data.conversationId)selected={view:'conversation',conversationId:data.conversationId};
  auth.target.value=selected;
  if(ticket)history.replaceState(history.state,'',location.pathname+'?'+Targets.search(selected));
  if(!data.authenticated&&data.message)auth.error.value=data.message;
 }catch(e){if(epoch===generation){auth.authenticated.value=false;auth.profile.value=null;initializePreferences(null);auth.error.value=(e as Error).message;}}
 finally{if(epoch===generation)auth.loading.value=false;}
}
export function bootstrapAuth(force=false):Promise<void>{if(force||!initial)initial=verify();return initial;}
/** Called once by each entry, never on resize/keyboard/rotation. */
export function routeEdition():boolean{
 const query=new URLSearchParams(location.search);if(query.get('desktop')==='1')saveLayout('desktop');else if(query.get('mobile')==='1')saveLayout('mobile');
 const layout=chooseLayout(),current=location.pathname.endsWith('/mobile.html')?'mobile':'desktop';
 if(layout===current)return false;
 location.replace((layout==='mobile'?'/mobile.html':'/index.html')+(auth.defaultEntry.value?'':'?'+Targets.search(auth.target.value)));return true;
}
export function switchEdition(layout:Layout,target:Target=auth.target.value){if(window.LabClient?.isNative)return;saveLayout(layout);location.assign((layout==='mobile'?'/mobile.html':'/index.html')+'?'+Targets.search(target));}
export function clearAuth(){generation++;auth.authenticated.value=false;auth.profile.value=null;auth.error.value='';initial=null;initializePreferences(null);sessionStorage.removeItem('labops.auth');}
