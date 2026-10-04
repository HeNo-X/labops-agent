import type {BusinessResult} from '@shared/business';
export interface DraftEnvelope {schemaVersion:2;scopeKey:string;cardId:string;taskId:string;view:BusinessResult['view'];entityId:string;revision:number|string;savedAt:string;fields:Record<string,unknown>}
export interface DraftStorage {getItem(key:string):string|null;setItem(key:string,value:string):void}
const ttl=7*86400000;
export function draftPrefix(scope:string,card:string){return `labops.native-draft:v2:${scope}:${card}`;}
export function writeDraft(storage:DraftStorage,d:DraftEnvelope){const key=draftPrefix(d.scopeKey,d.cardId);storage.setItem(key+':'+d.entityId,JSON.stringify(d));storage.setItem(key+':selected',d.entityId);}
export function selectedDraftEntity(storage:DraftStorage,scope:string,card:string){return storage.getItem(draftPrefix(scope,card)+':selected')||'';}
export function readDraft(storage:DraftStorage,scope:string,card:string,entity:string,revision:number|string,now=Date.now()):{draft:DraftEnvelope|null;warning:string}{
 try{const d=JSON.parse(storage.getItem(draftPrefix(scope,card)+':'+entity)||'null') as DraftEnvelope|null;
  if(!d||d.schemaVersion!==2||d.scopeKey!==scope||d.cardId!==card||d.entityId!==entity)return {draft:null,warning:''};
  if(!Number.isFinite(Date.parse(d.savedAt))||now-Date.parse(d.savedAt)>ttl)return {draft:null,warning:'本地草稿已超过7天，请根据最新记录重新填写。'};
  if(d.revision!==revision)return {draft:d,warning:'原系统对象版本已变化；已保留本地草稿，请核对后手动恢复。'};
  return {draft:d,warning:''};
 }catch{return {draft:null,warning:'本地草稿无法读取，请按原系统记录继续。'};}
}
