import crypto from 'node:crypto';import type {IncomingMessage,ServerResponse} from 'node:http';import {currentActor} from '../security/context.ts';import {readJsonBody} from './agent-chat.ts';import {getDb,createConversation,getConversationMeta} from '../persistence/db.ts';import {businessScope} from '../business/bridge.ts';
export async function importHistory(req:IncomingMessage,res:ServerResponse){
 const send=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(req.method!=='POST')return send(405,{message:'请通过POST导入本人已确认的旧记录'});
 const input=await readJsonBody(req,512*1024);if(!input.ok)return send(input.status,{message:input.message});const b=input.value as {confirmed?:boolean;messages?:unknown[]};
 if(!b||b.confirmed!==true||!Array.isArray(b.messages)||!b.messages.length||b.messages.length>200)return send(400,{message:'须人工确认旧记录属于本人，最多200条'});
 const messages:Array<{role:'user'|'assistant';text:string}>=[];
 for(const raw of b.messages){const m=raw as {role:string;text:string};if(!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||!m.text.trim()||m.text.length>3000)return send(400,{message:'旧记录必须是合法角色和1—3000字纯文本'});messages.push({role:m.role as 'user'|'assistant',text:m.text});}
 const owner=currentActor()!.id,digest=crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'),db=getDb();db.exec('CREATE TABLE IF NOT EXISTS history_imports(ownerId TEXT NOT NULL,digest TEXT NOT NULL,conversationId TEXT NOT NULL,importedAt TEXT NOT NULL,PRIMARY KEY(ownerId,digest))');
 const prior=db.prepare('SELECT conversationId FROM history_imports WHERE ownerId=? AND digest=?').get(owner,digest) as {conversationId:string}|undefined;if(prior&&getConversationMeta(prior.conversationId))return send(200,{id:prior.conversationId,replayed:true});
 db.exec('BEGIN IMMEDIATE');try{
  const now=new Date().toISOString(),c=createConversation('本人确认的本机旧聊天','chat');const insert=db.prepare('INSERT INTO messages (id,conversationId,role,text,status,meta,ordinal,createdAt) VALUES (?,?,?,?,?,?,?,?)');
  messages.forEach((m,i)=>insert.run('msg-'+crypto.randomUUID(),c.id,m.role,(m.role==='assistant'?'【本机旧记录，未经本次实时核验】\n':'')+m.text,'completed',JSON.stringify({responseMode:'chat',authorityScope:businessScope().scopeKey,toolCalls:[],provenance:'user_confirmed_legacy_history',importedAt:now,importedBy:owner}),i+1,now));
  db.prepare('INSERT OR REPLACE INTO history_imports VALUES (?,?,?,?)').run(owner,digest,c.id,now);db.exec('COMMIT');send(200,{id:c.id,imported:messages.length});
 }catch{db.exec('ROLLBACK');send(500,{message:'旧记录未导入，请稍后重试'});}
}
