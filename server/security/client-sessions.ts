import crypto from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {getDb} from '../persistence/db.ts';
import {encryptCredential,decryptCredential,nativeBaseUrl} from '../business/bridge.ts';

const digest=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
type Purpose='full'|'password';
function table(){getDb().exec(`CREATE TABLE IF NOT EXISTS installed_client_sessions(
 tokenHash TEXT PRIMARY KEY, credential TEXT NOT NULL, origin TEXT NOT NULL,
 purpose TEXT NOT NULL, expiresAt INTEGER NOT NULL)`);}
export function clientToken(req:IncomingMessage):string|undefined{
 return /^Bearer ((?:lc|lp)_[a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1];
}
export function issueClientSession(credential:string,purpose:Purpose='full'){
 table();const token=(purpose==='full'?'lc_':'lp_')+crypto.randomBytes(32).toString('hex');
 const expiresAt=Date.now()+(purpose==='full'?7*86400000:10*60000);
 getDb().prepare('DELETE FROM installed_client_sessions WHERE expiresAt<=?').run(Date.now());
 getDb().prepare('INSERT INTO installed_client_sessions VALUES (?,?,?,?,?)').run(digest(token),encryptCredential(credential),nativeBaseUrl(),purpose,expiresAt);
 return {token,expiresAt};
}
export function readClientSession(req:IncomingMessage,allowPassword=false){
 table();const token=clientToken(req);
 const row=token?getDb().prepare('SELECT credential,purpose,expiresAt,origin FROM installed_client_sessions WHERE tokenHash=? AND expiresAt>?').get(digest(token),Date.now()) as {credential:string;purpose:Purpose;expiresAt:number;origin:string}|undefined:undefined;
 if(!row||row.origin!==nativeBaseUrl()||(!allowPassword&&row.purpose!=='full'))throw Object.assign(new Error('客户端登录已失效，请重新登录'),{status:401});
 try{return {...row,credential:decryptCredential(row.credential)};}catch{throw Object.assign(new Error('客户端凭证不可用，请重新登录'),{status:401});}
}
export function revokeClientSession(req:IncomingMessage){table();const token=clientToken(req);if(token)getDb().prepare('DELETE FROM installed_client_sessions WHERE tokenHash=?').run(digest(token));}
