import crypto from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {getDb} from '../persistence/db.ts';
import {nativeRemote,nativeBaseUrl,encryptCredential,decryptCredential,rememberNativePrincipal} from '../business/bridge.ts';
import {nativeDelegation,requestIdentity,type NativeDelegation} from './context.ts';
import {readJsonBody} from '../api/agent-chat.ts';
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
export const authMode=()=>process.env.LABOPS_AUTH_MODE||'native';
function table(){getDb().exec('CREATE TABLE IF NOT EXISTS native_auth_sessions(tokenHash TEXT PRIMARY KEY,credential TEXT NOT NULL,expiresAt INTEGER NOT NULL)');}
function cookie(req:IncomingMessage){return /(?:^|;\s*)labops_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
function send(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function fail(message:string,status=401):never{throw Object.assign(new Error(message),{status});}
function principal(raw:unknown):NativeDelegation['profile']{
 const p=raw as Record<string,unknown>;if(!p||typeof p['username']!=='string'||!['admin','volunteer','student'].includes(String(p['identity'])))return fail('主系统未返回有效身份',502);
 if(p['mustChangePassword'])return fail('请先在主系统修改临时密码',403);
 // 2026-10-05 按用户要求：LabOps 仅对管理员与志愿者开放；学生账号一律拒绝（学生请用主系统学生端）。
 // 放在 principal() 内 → 登录与会话恢复两条路径都会拦，已登录的学生会话也会失效。
 if(p['identity']==='student')return fail('学生账号暂不能登录 LabOps（仅志愿者与管理员可用）',403);
 return {username:p['username'],identity:p['identity'] as NativeDelegation['profile']['identity'],className:String(p['className']||''),name:String(p['name']||p['username'])};
}
export async function authenticateNative(req:IncomingMessage):Promise<NativeDelegation>{
 table();let token:string|undefined;
 const shared=req.url?.startsWith('/api/shared-chat/');
 if(shared){token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];}
 else{const id=cookie(req);const row=id?getDb().prepare('SELECT credential FROM native_auth_sessions WHERE tokenHash=? AND expiresAt>?').get(hash(id),Date.now()) as {credential:string}|undefined:undefined;if(row){try{token=decryptCredential(row.credential);}catch{return fail('LabOps登录凭证无法解密，请重新登录并核对持久化密钥',401);}}}
 if(!token)return fail('请使用主系统账号登录');
 const result=await nativeRemote('/api/auth/profile','GET',token);return {token,profile:principal(result['profile']),sharedChat:Boolean(shared)};
}
export async function withNativeDelegation(d:NativeDelegation,next:()=>Promise<void>){
 const id='native-'+hash(JSON.stringify([nativeBaseUrl(),d.profile.username,d.profile.identity,d.profile.className||'']));
 await requestIdentity.run({id,role:d.profile.identity,label:d.profile.name||d.profile.username},async()=>nativeDelegation.run(d,async()=>{rememberNativePrincipal(d.profile,d.token);await next();}));
}
function setCookie(res:ServerResponse,value:string,seconds=604800){res.setHeader('Set-Cookie',`labops_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${process.env.LABOPS_SECURE_COOKIE==='1'?'; Secure':''}`);}
export async function handleNativeAuth(req:IncomingMessage,res:ServerResponse,p:string):Promise<boolean>{
 if(!p.startsWith('/api/auth/'))return false;
 try{
  if(p==='/api/auth/session'&&req.method==='GET'){
   if(authMode()==='demo'){send(res,200,{mode:'demo',authenticated:true});return true;}
   try{const d=await authenticateNative(req);send(res,200,{mode:'native',authenticated:true,profile:d.profile});}
   catch(e){const status=(e as {status?:number}).status||502;send(res,status===401?200:status,{mode:'native',authenticated:false,message:(e as Error).message,configured:Boolean(process.env.LABOPS_BUSINESS_URL)});}return true;
  }
  if(req.method!=='POST'||!['/api/auth/login','/api/auth/sso/exchange','/api/auth/logout'].includes(p)){send(res,404,{message:'认证入口不存在'});return true;}
  table();
  if(p==='/api/auth/logout'){
   const id=cookie(req);if(id){const row=getDb().prepare('SELECT credential FROM native_auth_sessions WHERE tokenHash=?').get(hash(id)) as {credential:string}|undefined;
    if(row){try{await nativeRemote('/api/auth/logout','POST',decryptCredential(row.credential),{});}catch{/* Local logout always clears the unreadable/expired delegated session. */}getDb().prepare('DELETE FROM native_auth_sessions WHERE tokenHash=?').run(hash(id));}}
   setCookie(res,'',0);send(res,200,{ok:true});return true;
  }
  const input=await readJsonBody(req);if(!input.ok){send(res,input.status,{message:input.message});return true;}
  const body=input.value as Record<string,unknown>;
  if(p==='/api/auth/login'&&(typeof body['account']!=='string'||typeof body['password']!=='string'))return send(res,400,{message:'请输入主系统账号和密码'}),true;
  if(p==='/api/auth/sso/exchange'&&(typeof body['ticket']!=='string'||!/^[a-f0-9]{64}$/.test(body['ticket'])))return send(res,400,{message:'登录票据无效'}),true;
  const result=await nativeRemote(p==='/api/auth/login'?'/api/auth/login':'/api/auth/labops-exchange','POST',undefined,p==='/api/auth/login'?{account:body['account'],password:body['password']}:{ticket:body['ticket']});
  if(typeof result['token']!=='string')return fail('主系统未返回登录会话',502);
  let profile:NativeDelegation['profile'];try{profile=principal(result['profile']);}catch(e){await nativeRemote('/api/auth/logout','POST',result['token'],{}).catch(()=>undefined);throw e;}
  const token=crypto.randomBytes(32).toString('hex');getDb().prepare('DELETE FROM native_auth_sessions WHERE expiresAt<?').run(Date.now());
  getDb().prepare('INSERT INTO native_auth_sessions VALUES (?,?,?)').run(hash(token),encryptCredential(result['token']),Date.now()+7*86400000);
  setCookie(res,token);await withNativeDelegation({token:result['token'],profile},async()=>undefined);
  send(res,200,{authenticated:true,mode:'native',profile,conversationId:result['conversationId']||null});return true;
 }catch(e){send(res,(e as {status?:number}).status||502,{message:(e as Error).message,code:'native_auth_failed'});return true;}
}
