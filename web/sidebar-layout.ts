export const SIDEBAR_MIN=200, SIDEBAR_MAX=360, SIDEBAR_RAIL=56, SIDEBAR_DEFAULT=240;
export function sidebarLayout(raw:number):{width:number;collapsed:boolean}{
 const value=Number.isFinite(raw)?raw:SIDEBAR_DEFAULT;
 return value<SIDEBAR_MIN?{width:SIDEBAR_RAIL,collapsed:true}:{width:Math.min(SIDEBAR_MAX,Math.round(value)),collapsed:false};
}
export function savedSidebar(raw:string|null):{width:number;collapsed:boolean}{
 try{const value=JSON.parse(raw||'null');if(value&&typeof value.width==='number')return {width:sidebarLayout(Math.max(SIDEBAR_MIN,value.width)).width,collapsed:value.collapsed===true};}catch{/* A damaged presentation preference has no effect on authorization. */}
 return {width:SIDEBAR_DEFAULT,collapsed:false};
}
