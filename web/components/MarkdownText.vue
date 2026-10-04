<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{text:string}>();
type Block={kind:'text';text:string}|{kind:'table';header:string[];rows:string[][]};
const cells=(line:string)=>line.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
const blocks=computed<Block[]>(()=>{
  const lines=props.text.split('\n'),out:Block[]=[];let text:string[]=[];
  const flush=()=>{if(text.length){out.push({kind:'text',text:text.join('\n')});text=[];}};
  for(let i=0;i<lines.length;i++){
    if(lines[i]?.trim().startsWith('|')&&/^\s*\|?[\s:|-]+\|\s*$/.test(lines[i+1]||'')&&lines[i+1]?.includes('---')){
      flush();const header=cells(lines[i]!);i+=2;const rows:string[][]=[];
      for(;i<lines.length&&lines[i]?.trim().startsWith('|');i++)rows.push(cells(lines[i]!));
      i--;out.push({kind:'table',header,rows});
    }else text.push(lines[i]||'');
  }flush();return out;
});
</script>
<template>
  <div class="safe-markdown">
    <template v-for="(block,index) in blocks" :key="index">
      <div v-if="block.kind==='table'" class="table-scroll" tabindex="0" aria-label="查询结果表格">
        <table><thead><tr><th v-for="(cell,c) in block.header" :key="c" scope="col">{{ cell }}</th></tr></thead>
          <tbody><tr v-for="(row,r) in block.rows" :key="r"><td v-for="(cell,c) in row" :key="c">{{cell}}</td></tr></tbody></table>
      </div>
      <p v-else>{{block.text}}</p>
    </template>
  </div>
</template>
<style scoped>
.safe-markdown{line-height:1.7;overflow-wrap:anywhere}.safe-markdown p{white-space:pre-wrap;margin:.45rem 0}.table-scroll{overflow:auto;margin:1rem 0}table{border-collapse:collapse;min-width:100%;font-size:14px}th,td{padding:10px 14px;text-align:left;border:1px solid var(--border,#dce3ec)}th{background:var(--surface-soft,#f3f6fa)}
</style>
