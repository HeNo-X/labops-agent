import {ref,onUnmounted} from 'vue';
import Targets,{type Target} from '@shared/labops-targets.js';
export function useMobileNavigation(initial:Target){
 const route=ref<Target>(initial),error=ref(''),sheet=ref('');let depth=0;
 history.replaceState({labops:true,depth:0},'', '/mobile.html?'+Targets.search(initial));
 function pop(event:PopStateEvent){sheet.value='';depth=Number(event.state?.depth)||0;try{route.value=Targets.normalize(Object.fromEntries(new URLSearchParams(location.search)));error.value='';}catch(e){error.value=(e as Error).message;}}
 window.addEventListener('popstate',pop);onUnmounted(()=>window.removeEventListener('popstate',pop));
 function go(target:Target,replace=false){try{const safe=Targets.normalize(target);error.value='';sheet.value='';if(!replace)depth++;history[replace?'replaceState':'pushState']({labops:true,depth},'','/mobile.html?'+Targets.search(safe));route.value=safe;}catch(e){error.value=(e as Error).message;}}
 function openSheet(name:string){if(sheet.value)return;sheet.value=name;history.pushState({labops:true,depth,sheet:true},'',location.href);}
 function closeSheet(){if(sheet.value)history.back();}
 function back(){if(sheet.value){closeSheet();return;}if(depth>0)history.back();else go({view:route.value.view==='room'?'rooms':route.value.view==='job'?'automation':route.value.view==='notice'?'messages':route.value.view==='conversation'?'assistant':'home'},true);}
 return {route,error,sheet,go,back,openSheet,closeSheet};
}
