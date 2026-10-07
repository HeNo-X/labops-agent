export interface DeviceInput {userAgent:string;platform:string;maxTouchPoints:number;width:number}
export type Layout='mobile'|'desktop';
export function detectedLayout(input:DeviceInput):Layout{
 const ipad=/iPad/i.test(input.userAgent)||input.platform==='MacIntel'&&input.maxTouchPoints>1;
 return ipad||/Mobi|Android|iPhone|iPod/i.test(input.userAgent)||input.width<=768?'mobile':'desktop';
}
export function preferredLayout(input:DeviceInput,override:unknown,now=Date.now()):Layout{
 const saved=override as {layout?:unknown;until?:unknown}|null;
 return saved&&['mobile','desktop'].includes(String(saved.layout))&&typeof saved.until==='number'&&saved.until>now?saved.layout as Layout:detectedLayout(input);
}
export function chooseLayout():Layout{
 let override:unknown;try{override=JSON.parse(localStorage.getItem('labops.layout')||'null');}catch{/* No override. */}
 return preferredLayout({userAgent:navigator.userAgent,platform:navigator.platform,maxTouchPoints:navigator.maxTouchPoints,width:innerWidth},override);
}
export function saveLayout(layout:Layout){localStorage.setItem('labops.layout',JSON.stringify({layout,until:Date.now()+7*86400000}));}
