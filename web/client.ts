/// <reference lib="dom" />
interface InstalledEnvironment {mainApiBase:string;agentApiBase:string;mainPublicBase:string}
interface InstalledDiagnostic {service:'main'|'agent';label:string;ok:boolean;status:number;message:string}
interface InstalledRuntime {
 isNative:boolean;
 config:{edition:'desktop'|'mobile';product:'main'|'labops';platform:string;version:string;mainApiBase:string;agentApiBase:string;mainPublicBase:string};
 fetch(input:RequestInfo|URL,init?:RequestInit,service?:string):Promise<Response>;
 apiUrl(path:string,service?:string):string;
 headers(input?:HeadersInit,service?:string):Headers;
 account():void;
 /** 打开客户端「设置 → 高级设置」页（服务器地址与连接检查）。 */
 advanced():void;
 /** 当前生效的三个服务地址。 */
 environment():InstalledEnvironment;
 /** 校验三个 HTTPS 地址；不合法时抛错。 */
 normalizeEnvironment(raw:Partial<InstalledEnvironment>):InstalledEnvironment;
 /** 退出登录并清空本机业务缓存（保留已保存的服务器地址）。 */
 clearLocalSession():Promise<void>;
 /** 校验地址 → 退出登录 → 写入本机 → 回到登录页（options.redirect=false 只写入不跳转）。 */
 applyEnvironment(raw:Partial<InstalledEnvironment>,options?:{redirect?:boolean}):Promise<InstalledEnvironment>;
 /** 逐一探测主系统与 LabOps 的 /api/health。 */
 diagnose():Promise<InstalledDiagnostic[]>;
}
declare global {interface Window {LabClient?:InstalledRuntime}}
export function clientFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{return window.LabClient?.isNative?window.LabClient.fetch(input,init):fetch(input,init);}
export function clientUrl(path:string):string{return window.LabClient?.isNative?window.LabClient.apiUrl(path):path;}
export function clientHeaders(input:Record<string,string>={}):Record<string,string>{const result={...input};if(window.LabClient?.isNative)window.LabClient.headers(input,'agent').forEach((v,k)=>{result[k]=v;});return result;}
export function isInstalledClient(){return Boolean(window.LabClient?.isNative);}
