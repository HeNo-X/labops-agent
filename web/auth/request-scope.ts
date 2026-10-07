let generation=0;const pending=new Set<AbortController>();
export function requestScope(){const controller=new AbortController(),epoch=generation;pending.add(controller);return {signal:controller.signal,current:()=>epoch===generation,done:()=>pending.delete(controller)};}
export function clearRequests(){generation++;for(const controller of pending)controller.abort();pending.clear();}
