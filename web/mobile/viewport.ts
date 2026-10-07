import {ref,onMounted,onUnmounted} from 'vue';
export function useMobileViewport(){
 const keyboard=ref(false);let largest=innerHeight;
 function update(){const viewport=window.visualViewport,height=viewport?.height||innerHeight,focused=document.activeElement?.matches('input,textarea,[contenteditable=true]');if(!focused)largest=innerHeight;keyboard.value=Boolean(focused&&largest-height>120);document.documentElement.style.setProperty('--app-height',Math.round(height)+'px');document.documentElement.style.setProperty('--viewport-top',Math.round(viewport?.offsetTop||0)+'px');}
 onMounted(()=>{update();window.visualViewport?.addEventListener('resize',update);window.visualViewport?.addEventListener('scroll',update);window.addEventListener('resize',update);document.addEventListener('focusin',update);document.addEventListener('focusout',update);});
 onUnmounted(()=>{window.visualViewport?.removeEventListener('resize',update);window.visualViewport?.removeEventListener('scroll',update);window.removeEventListener('resize',update);document.removeEventListener('focusin',update);document.removeEventListener('focusout',update);});
 return {keyboard};
}
