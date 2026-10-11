import {nextTick,onUnmounted,watch,type Ref} from 'vue';

/** Keep keyboard focus in a visible dialog and return it to its launcher. */
export function useModal(open:Ref<boolean>,selector:string,enabled=()=>true){
 let previous:HTMLElement|null=null;
 const focusable=()=>[...document.querySelector(selector)?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')||[]].filter(e=>e.getClientRects().length>0);
 function key(event:KeyboardEvent){
  if(!open.value||!enabled())return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();open.value=false;return;}
  if(event.key!=='Tab')return;
  const items=focusable();if(!items.length){event.preventDefault();return;}
  const index=items.indexOf(document.activeElement as HTMLElement);
  if(index<0||event.shiftKey&&index===0||!event.shiftKey&&index===items.length-1){event.preventDefault();items[event.shiftKey?items.length-1:0].focus();}
 }
 watch(()=>open.value&&enabled(),async active=>{
  document.removeEventListener('keydown',key);
  if(active){previous=document.activeElement as HTMLElement;await nextTick();if(!open.value||!enabled())return;document.addEventListener('keydown',key);focusable()[0]?.focus();}
  else if(previous?.isConnected){previous.focus();previous=null;}
 },{immediate:true});
 onUnmounted(()=>document.removeEventListener('keydown',key));
}
