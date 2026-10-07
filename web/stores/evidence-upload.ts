import {defineStore} from 'pinia';import {ref,shallowRef} from 'vue';import {actorHeaders} from '../actor';
export const useEvidenceUpload=defineStore('evidenceUpload',()=>{
 const file=shallowRef<File>(),requestId=ref(''),progress=ref(0),busy=ref(false),error=ref(''),receipt=ref<{id:string;sha256:string}|null>(null);let xhr:XMLHttpRequest|null=null,generation=0;
 function cancel(){generation++;xhr?.abort();xhr=null;busy.value=false;}
 function clearPrivate(){cancel();file.value=undefined;requestId.value='';progress.value=0;error.value='';receipt.value=null;}
 function select(value:File){cancel();file.value=value;requestId.value=crypto.randomUUID();progress.value=0;error.value='';receipt.value=null;}
 async function upload(scopeKey:string,targetKind:string,targetId:string){
  if(!file.value||busy.value)return null;const epoch=++generation,f=file.value;busy.value=true;error.value='';progress.value=0;
  try{
   if(f.size>3*1024*1024||!f.size)throw new Error('附件须为 1 字节至 3 MiB');
   const dataBase64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('文件读取失败，草稿已保留'));reader.readAsDataURL(f);});
   if(epoch!==generation)return null;
   const payload={scopeKey,targetKind,targetId,fileName:f.name,mimeType:f.type||'text/plain',dataBase64,requestId:requestId.value};
   const result=await new Promise<{attachment:{id:string;sha256:string}}>((resolve,reject)=>{
    xhr=new XMLHttpRequest();xhr.open('POST','/api/business/proxy/evidence/attachments');xhr.setRequestHeader('Content-Type','application/json');for(const [key,value] of Object.entries(actorHeaders()))xhr.setRequestHeader(key,String(value));xhr.timeout=45000;
    xhr.upload.onprogress=event=>{if(epoch===generation&&event.lengthComputable)progress.value=Math.min(99,Math.round(event.loaded/event.total*100));};
    xhr.onerror=()=>reject(new Error('网络中断，保留此附件与请求编号，重试会回查同一上传'));xhr.ontimeout=()=>reject(new Error('上传确认超时，保留草稿后按原编号重试'));xhr.onabort=()=>reject(new Error('已停止上传，附件草稿保留'));
    xhr.onload=()=>{let response;try{response=JSON.parse(xhr!.responseText);}catch{return reject(new Error('服务返回无效响应，草稿已保留'));}if(xhr!.status<200||xhr!.status>=300)return reject(new Error(response.message||response.error||'上传未成功'));resolve(response);};xhr.send(JSON.stringify(payload));
   });
   if(epoch!==generation)return null;receipt.value=result.attachment;progress.value=100;file.value=undefined;return result.attachment;
  }catch(e){if(epoch===generation)error.value=(e as Error).message;return null;}
  finally{if(epoch===generation){busy.value=false;xhr=null;}}
 }
 return {file,requestId,progress,busy,error,receipt,select,upload,cancel,clearPrivate};
});
