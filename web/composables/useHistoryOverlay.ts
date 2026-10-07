import {watch,onUnmounted,type Ref} from 'vue';
/** Keep a same-URL history entry so native browser Back closes a dialog first. */
export function useHistoryOverlay(open:Ref<boolean>){
 let owns=false,fromHistory=false;
 const pop=()=>{if(owns){owns=false;fromHistory=true;open.value=false;queueMicrotask(()=>fromHistory=false);}};
 window.addEventListener('popstate',pop);
 watch(open,value=>{if(value&&!owns){history.pushState({...history.state,labopsOverlay:true},'',location.href);owns=true;}else if(!value&&owns&&!fromHistory){owns=false;history.back();}},{flush:'sync'});
 onUnmounted(()=>{window.removeEventListener('popstate',pop);if(owns&&history.state?.labopsOverlay)history.back();});
}
