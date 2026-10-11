export type Theme = 'auto'|'light'|'dark';
export type Language = 'auto'|'zh-CN'|'en';
export type Accent = 'neutral'|'blue'|'green'|'purple'|'amber';
export interface Preferences {
 version:1; theme:Theme; language:Language; accent:Accent;
 desktopFont:number; mobileFont:number; desktopReply:number; mobileReply:number;
 reducedMotion:boolean; defaultMode:'task'|'chat'; mobileStart:'assistant'|'home';
}
export const DEFAULTS:Preferences={version:1,theme:'auto',language:'zh-CN',accent:'neutral',desktopFont:13,mobileFont:9,desktopReply:14,mobileReply:9,reducedMotion:false,defaultMode:'task',mobileStart:'assistant'};
function size(value:unknown,fallback:number,min:number,max:number){return typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,Math.round(value))):fallback;}
function choice<T extends string>(value:unknown,values:readonly T[],fallback:T):T{return values.includes(value as T)?value as T:fallback;}
export function normalizePreferences(raw:unknown):Preferences {
 const v=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
 return {version:1,theme:choice(v.theme,['auto','light','dark'],DEFAULTS.theme),language:choice(v.language,['auto','zh-CN','en'],DEFAULTS.language),accent:choice(v.accent,['neutral','blue','green','purple','amber'],DEFAULTS.accent),
 desktopFont:size(v.desktopFont,13,11,18),mobileFont:size(v.mobileFont,9,9,16),desktopReply:size(v.desktopReply,14,12,24),mobileReply:size(v.mobileReply,9,9,20),
 reducedMotion:v.reducedMotion===true,defaultMode:choice(v.defaultMode,['task','chat'],'task'),mobileStart:choice(v.mobileStart,['assistant','home'],'assistant')};
}
export function parsePreferences(raw:string|null,legacyTheme:string|null=null){try{return normalizePreferences(raw?JSON.parse(raw):{theme:legacyTheme});}catch{return normalizePreferences({theme:legacyTheme});}}
export function preferenceOwner(profile:{username:string;identity:string}|null){return profile&&['admin','volunteer','student'].includes(profile.identity)&&profile.username?profile.identity+':'+profile.username:'';}
export function resolveLanguage(language:Language,system:string):'zh-CN'|'en'{return language==='auto'?(/^zh(?:-|$)/i.test(system)?'zh-CN':'en'):language;}
