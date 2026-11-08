export type Theme = 'auto'|'light'|'dark';
export type Language = 'auto'|'zh-CN'|'en';
export type Accent = 'neutral'|'blue'|'green'|'purple'|'amber';
export interface Preferences {
 version:1; theme:Theme; language:Language; accent:Accent;
 desktopFont:number; mobileFont:number;
 reducedMotion:boolean; defaultMode:'task'|'chat'; mobileStart:'assistant'|'home';
}
export const DEFAULTS:Preferences={version:1,theme:'auto',language:'zh-CN',accent:'neutral',desktopFont:13,mobileFont:15,reducedMotion:false,defaultMode:'task',mobileStart:'home'};
/** 界面缩放档位：界面字号按档位选取；回复内容字号 = 界面字号 + 1px（apply() 派生，不再单独调节） */
export const UI_SCALES=[
 {id:'compact',label:'紧凑',desktop:11,mobile:11},
 {id:'small',label:'很小',desktop:12,mobile:13},
 {id:'standard',label:'较小',desktop:13,mobile:15},
 {id:'large',label:'标准',desktop:15,mobile:16},
 {id:'xlarge',label:'偏大',desktop:16,mobile:18},
 {id:'xxlarge',label:'特大',desktop:17,mobile:19},
 {id:'max',label:'最大',desktop:18,mobile:20}
] as const;
export type UiScaleId = typeof UI_SCALES[number]['id'];
function size(value:unknown,fallback:number,min:number,max:number){return typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,Math.round(value))):fallback;}
function choice<T extends string>(value:unknown,values:readonly T[],fallback:T):T{return values.includes(value as T)?value as T:fallback;}
export function normalizePreferences(raw:unknown):Preferences {
 const v=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 return {version:1,theme:choice(v.theme,['auto','light','dark'],DEFAULTS.theme),language:choice(v.language,['auto','zh-CN','en'],DEFAULTS.language),accent:choice(v.accent,['neutral','blue','green','purple','amber'],DEFAULTS.accent),
 desktopFont:size(v.desktopFont,13,11,18),mobileFont:size(v.mobileFont,15,9,20),
 reducedMotion:v.reducedMotion===true,defaultMode:choice(v.defaultMode,['task','chat'],'task'),mobileStart:choice(v.mobileStart,['assistant','home'],'home')};
}
export function parsePreferences(raw:string|null,legacyTheme:string|null=null){try{return normalizePreferences(raw?JSON.parse(raw):{theme:legacyTheme});}catch{return normalizePreferences({theme:legacyTheme});}}
export function preferenceOwner(profile:{username:string;identity:string}|null){return profile&&['admin','volunteer','student'].includes(profile.identity)&&profile.username?profile.identity+':'+profile.username:'';}
export function resolveLanguage(language:Language,system:string):'zh-CN'|'en'{return language==='auto'?(/^zh(?:-|$)/i.test(system)?'zh-CN':'en'):language;}
