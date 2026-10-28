import {computed,ref,watch} from 'vue';
import {DEFAULTS,parsePreferences,normalizePreferences,preferenceOwner,resolveLanguage,type Preferences} from './schema';
export const preferences=ref<Preferences>({...DEFAULTS}),preferenceError=ref('');
export const language=computed(()=>resolveLanguage(preferences.value.language,navigator.language));
export const mobile=location.pathname.endsWith('/mobile.html');
const media=matchMedia('(prefers-color-scheme: dark)');let owner='',key='';
const palettes={
 blue:['#1d4ed8','#1e40af','#eff6ff','#93c5fd','#93c5fd','#bfdbfe','#172554'],
 green:['#166534','#14532d','#f0fdf4','#86efac','#86efac','#bbf7d0','#052e16'],
 purple:['#6d28d9','#5b21b6','#f5f3ff','#c4b5fd','#c4b5fd','#ddd6fe','#2e1065'],
 amber:['#92400e','#78350f','#fffbeb','#fcd34d','#fcd34d','#fde68a','#451a03']
};
function apply(){
 const p=preferences.value,root=document.documentElement,dark=p.theme==='auto'?media.matches:p.theme==='dark';
 root.dataset.theme=dark?'dark':'light';root.dataset.accent=p.accent;root.dataset.reducedMotion=String(p.reducedMotion);root.lang=language.value;
 // F1：状态栏 theme-color 随主题同步（与 manifest 背景色一致：安装态外壳 + 浏览器顶栏）
 const themeMeta=document.querySelector('meta[name="theme-color"]');
 if(themeMeta)themeMeta.setAttribute('content',dark?'#202020':'#fafafa');
 root.style.setProperty('--ui-font-size',(mobile?p.mobileFont:p.desktopFont)+'px');root.style.setProperty('--reply-font-size',(mobile?p.mobileReply:p.desktopReply)+'px');
 const fields=['--primary','--primary-hover','--primary-weak','--primary-border','--primary-contrast','--focus'];
 if(p.accent==='neutral'){for(const name of fields)root.style.removeProperty(name);}
 else{const c=palettes[p.accent];const values=dark?[c[4],c[5],'#222',c[4],c[6],c[4]]:[c[0],c[1],c[2],c[3],'#ffffff',c[0]];fields.forEach((name,i)=>root.style.setProperty(name,values[i]!));}
}
export function initializePreferences(profile:{username:string;identity:string}|null){
 const next=preferenceOwner(profile);if(next===owner&&key)return;
 owner=next;key=next?'labops.preferences.v1:'+next:'';preferenceError.value='';
 try{preferences.value=key?parsePreferences(localStorage.getItem(key),localStorage.getItem('labops.theme')):{...DEFAULTS};}catch{preferences.value={...DEFAULTS};preferenceError.value='偏好暂时无法保存，当前调整仍可使用。';}
 apply();
}
export function updatePreferences(value:Partial<Preferences>){
 preferences.value=normalizePreferences({...preferences.value,...value});
 try{if(key)localStorage.setItem(key,JSON.stringify(preferences.value));preferenceError.value='';}catch{preferenceError.value='偏好暂时无法保存，当前调整仍可使用。';}
}
export function resetPreferences(){updatePreferences({...DEFAULTS});}
watch(preferences,apply,{deep:true,immediate:true});media.addEventListener('change',apply);
window.addEventListener('storage',event=>{if(key&&event.key===key){preferences.value=parsePreferences(event.newValue);apply();}});
