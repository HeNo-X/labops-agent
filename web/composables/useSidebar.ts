import {computed,onUnmounted,ref} from 'vue';
import {savedSidebar,sidebarLayout,SIDEBAR_MIN,SIDEBAR_RAIL} from '../sidebar-layout';
export function useSidebar(){
 let saved={width:240,collapsed:false};try{saved=savedSidebar(localStorage.getItem('labops.sidebar.v7'));}catch{}
 const width=ref(saved.width),collapsed=ref(saved.collapsed),resizing=ref(false),effectiveWidth=computed(()=>collapsed.value?SIDEBAR_RAIL:width.value);
 let hold:ReturnType<typeof setTimeout>|undefined,pointerId=-1,startX=0,startWidth=0,lastX=0,target:HTMLElement|null=null;
 function persist(){try{localStorage.setItem('labops.sidebar.v7',JSON.stringify({width:width.value,collapsed:collapsed.value}));}catch{}}
 function apply(value:number){const result=sidebarLayout(value);collapsed.value=result.collapsed;if(!result.collapsed)width.value=result.width;}
 function toggle(){collapsed.value=!collapsed.value;persist();}
 function stop(){clearTimeout(hold);hold=undefined;resizing.value=false;if(target?.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId);pointerId=-1;target=null;document.documentElement.classList.remove('sidebar-resizing');persist();}
 function down(event:PointerEvent){if(event.button!==0||window.innerWidth<=900)return;event.preventDefault();stop();pointerId=event.pointerId;startX=lastX=event.clientX;startWidth=effectiveWidth.value;target=event.currentTarget as HTMLElement;target.setPointerCapture(pointerId);hold=setTimeout(()=>{resizing.value=true;document.documentElement.classList.add('sidebar-resizing');apply(startWidth+lastX-startX);},180);}
 function move(event:PointerEvent){if(event.pointerId!==pointerId)return;lastX=event.clientX;if(resizing.value)apply(startWidth+lastX-startX);}
 function key(event:KeyboardEvent){if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();if(event.key==='Home')collapsed.value=true;else if(event.key==='End'){collapsed.value=false;width.value=Math.max(SIDEBAR_MIN,width.value);}else apply(event.key==='ArrowRight'&&collapsed.value?SIDEBAR_MIN:effectiveWidth.value+(event.key==='ArrowLeft'?-20:20));persist();}
 window.addEventListener('blur',stop);onUnmounted(()=>{stop();window.removeEventListener('blur',stop);});
 return {width,collapsed,resizing,effectiveWidth,toggle,down,move,stop,key};
}
