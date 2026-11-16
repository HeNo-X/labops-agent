<script setup lang="ts">
import {t as tr} from "../i18n";
import { computed } from 'vue';
/**
 * 安全的轻量 Markdown 渲染（**加粗** 与 "- " 列表）
 * ============================================================================
 *  服务端渲染器的答案采用"重点加粗先行 + 列表化明细"的形态，
 *  因此只支持两种最小语法：
 *    · **加粗**  —— 内联分段渲染（纯数组 + <strong>，**不用 v-html**，无注入面）
 *    · - / · / • 开头的行 —— 聚合成无序列表
 *  管道表格照旧。其余一切按纯文本转义输出，绝不过 HTML。
 */
const props = defineProps<{text:string}>();
type Inline=Array<{b:boolean;t:string}>;
type Block={kind:'text';text:string}|{kind:'list';items:string[]}|{kind:'table';header:string[];rows:string[][]};
const cells=(line:string)=>line.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
const inline=(line:string):Inline=>{
  const out:Inline=[];const re=/\*\*([^*]+)\*\*/g;let last=0,m:RegExpExecArray|null;
  while((m=re.exec(line))){
    if(m.index>last)out.push({b:false,t:line.slice(last,m.index)});
    out.push({b:true,t:m[1]!});last=m.index+m[0].length;
  }
  if(last<line.length)out.push({b:false,t:line.slice(last)});
  return out.length?out:[{b:false,t:line}];
};
const blocks=computed<Block[]>(()=>{
  const lines=props.text.split('\n'),out:Block[]=[];let text:string[]=[],list:string[]=[];
  const flushText=()=>{if(text.length){out.push({kind:'text',text:text.join('\n')});text=[];}};
  const flushList=()=>{if(list.length){out.push({kind:'list',items:list});list=[];}};
  const flushAll=()=>{flushText();flushList();};
  for(let i=0;i<lines.length;i++){
    const line=lines[i]??'';
    if(line.trim().startsWith('|')&&/^\s*\|?[\s:|-]+\|\s*$/.test(lines[i+1]||'')&&lines[i+1]?.includes('---')){
      flushAll();const header=cells(lines[i]!);i+=2;const rows:string[][]=[];
      for(;i<lines.length&&lines[i]?.trim().startsWith('|');i++)rows.push(cells(lines[i]!));
      i--;out.push({kind:'table',header,rows});continue;
    }
    const li=/^\s*[-·•]\s+(.+)$/.exec(line);
    if(li){flushText();list.push(li[1]!);continue;}
    flushAll();text.push(line);
  }
  flushAll();return out;
});
</script>
<template>
  <div class="safe-markdown">
    <template v-for="(block,index) in blocks" :key="index">
      <div v-if="block.kind==='table'" class="table-scroll" tabindex="0" :aria-label="tr('查询结果表格')">
        <table><thead><tr><th v-for="(cell,c) in block.header" :key="c" scope="col">{{ cell }}</th></tr></thead>
          <tbody><tr v-for="(row,r) in block.rows" :key="r"><td v-for="(cell,c) in row" :key="c">{{cell}}</td></tr></tbody></table>
      </div>
      <ul v-else-if="block.kind==='list'" class="md-list">
        <li v-for="(item,i2) in block.items" :key="i2"><template v-for="(seg,i3) in inline(item)" :key="i3"><strong v-if="seg.b">{{seg.t}}</strong><template v-else>{{seg.t}}</template></template></li>
      </ul>
      <p v-else><template v-for="(seg,i4) in inline(block.text)" :key="i4"><strong v-if="seg.b">{{seg.t}}</strong><template v-else>{{seg.t}}</template></template></p>
    </template>
  </div>
</template>
<style scoped>
.safe-markdown{line-height:1.7;overflow-wrap:anywhere}.safe-markdown p{white-space:pre-wrap;margin:.45rem 0}.md-list{margin:.45rem 0;padding-left:1.35rem;display:flex;flex-direction:column;gap:.25rem}.md-list li{margin:0}.table-scroll{overflow:auto;margin:1rem 0}table{border-collapse:collapse;min-width:100%;font-size:calc(var(--ui-font-size) * 1.07692)}th,td{padding:10px 14px;text-align:left;border:1px solid var(--border,#dce3ec)}th{background:var(--surface-soft,#f3f6fa)}
</style>
