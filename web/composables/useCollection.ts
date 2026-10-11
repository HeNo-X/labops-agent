import {ref,watch} from 'vue';
export function useCollection(kind:string,owner:()=>string){
 const ids=ref<string[]>([]);
 watch(owner,value=>{ids.value=[];if(!value)return;try{const saved=JSON.parse(localStorage.getItem('labops.preference:'+kind+':'+value)||'[]');if(Array.isArray(saved))ids.value=saved.filter((id:unknown)=>typeof id==='string').slice(0,100);}catch{}},{immediate:true});
 function toggle(id:string){if(!owner())return;ids.value=ids.value.includes(id)?ids.value.filter(v=>v!==id):[...ids.value,id].slice(-100);try{localStorage.setItem('labops.preference:'+kind+':'+owner(),JSON.stringify(ids.value));}catch{}}
 return {ids,toggle};
}
