import {onMounted,onUnmounted} from 'vue';
/** One bounded poll per visible view; cancellation and scope guards belong to the store. */
export function useVisibleRefresh(refresh:()=>Promise<void>,enabled:()=>boolean=()=>true){
 let timer:ReturnType<typeof setTimeout>|null=null,busy=false,disposed=false,delay=30000;
 function schedule(){if(timer)clearTimeout(timer);if(!disposed&&document.visibilityState==='visible')timer=setTimeout(tick,delay);}
 async function tick(){if(disposed||busy||document.visibilityState!=='visible')return;if(!enabled()){schedule();return;}busy=true;try{await refresh();delay=30000;}catch{delay=Math.min(delay*2,120000);}finally{busy=false;schedule();}}
 function wake(){if(timer)clearTimeout(timer);if(document.visibilityState==='visible')void tick();}
 onMounted(()=>{window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);schedule();});
 onUnmounted(()=>{disposed=true;if(timer)clearTimeout(timer);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);});
 return {refresh:tick};
}
