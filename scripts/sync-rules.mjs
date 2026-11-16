import fs from 'node:fs';
/**
 * 共享契约镜像同步 —— 上游源双源解析
 * ============================================================================
 *  上游是主系统 Pages/lib/（工作区里两侧并存时以它为准）；
 *  独立 clone 没有外层 Pages/ 时改用仓内 vendor/pages/ 快照（源副本）。
 *  SYNC_RULES_SOURCE=vendor 可强制走仓内源（用于验证独立 clone 语义）。
 *  生成物（shared/、public/lib|operations.html）与源位置无关，逐字节稳定。
 */
const forceVendor = process.env.SYNC_RULES_SOURCE === 'vendor';
function sourceUrl(rel) {
  const outer = new URL('../../' + rel, import.meta.url);
  if (!forceVendor && fs.existsSync(outer)) return outer;
  const vendored = new URL('../vendor/pages/' + rel.replace(/^Pages\//, ''), import.meta.url);
  if (!fs.existsSync(vendored)) throw new Error('契约源缺失：' + rel + '（外层 Pages/ 与仓内 vendor/pages/ 均未找到）');
  return vendored;
}
const source = sourceUrl('Pages/lib/calendar.js');
const mirror = new URL('../shared/calendar.cjs', import.meta.url);
function compare(a,b,label){
  const src=fs.readFileSync(a,'utf8');
  if(!fs.existsSync(b))throw new Error(label+' 镜像缺失：'+b+' 不存在，执行 npm run sync:rules');
  if(src!==fs.readFileSync(b,'utf8'))throw new Error(label+' mirror differs; run npm run sync:rules');
}
if (process.argv.includes('--check')) {
  compare(source,mirror,'calendar');
} else fs.copyFileSync(source,mirror);

for (const [from,to] of [['Pages/operations.html','../public/operations.html'],['Pages/lib/operations-ui.js','../public/lib/operations-ui.js'],['Pages/lib/client-runtime.js','../public/lib/client-runtime.js']]) {
  const source = sourceUrl(from), target = new URL(to,import.meta.url);
  if(process.argv.includes('--check')) compare(source,target,'工作台');
  else {fs.mkdirSync(new URL('.',target),{recursive:true});fs.copyFileSync(source,target);}
}

for(const [name,globalName] of [['sse','LabOpsSSE'],['labops-targets','LabOpsTargets']]){
 const source=sourceUrl('Pages/lib/'+name+'.js'),target=new URL('../shared/'+name+'.js',import.meta.url);
 const raw=fs.readFileSync(source,'utf8'),body=raw.slice(raw.indexOf('function(){')+'function(){'.length,raw.lastIndexOf('});'));
 const contents='// Generated from Pages/lib/'+name+'.js; npm run sync:rules\nconst api=(()=>{'+body+'})();\nexport default api;\n';
 if(process.argv.includes('--check')){if(fs.readFileSync(target,'utf8')!==contents)throw new Error(name+' mirror differs');}else fs.writeFileSync(target,contents);
}

for(const name of ['scheduled-params']){const from=sourceUrl('Pages/lib/'+name+'.json'),to=new URL('../shared/'+name+'.json',import.meta.url);if(process.argv.includes('--check')){if(fs.readFileSync(from,'utf8')!==fs.readFileSync(to,'utf8'))throw new Error(name+' mirror differs');}else fs.copyFileSync(from,to);}

// 镜像清单只能保证"清单内的文件一致"，保证不了"清单是完整的"——清单漏掉某个引用文件时，
// check:rules 全绿、页面却 404。这里补上引用侧的闭环：HTML 引用的本地资源必须真实存在。
const publicDir = new URL('../public/', import.meta.url);
const broken = [];
for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
  const html = fs.readFileSync(new URL(entry.name, publicDir), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/g)) {
    if (/^(?:https?:|data:|mailto:|\/\/|\/)/.test(ref)) continue;
    if (!fs.existsSync(new URL(ref, publicDir))) broken.push(`${entry.name} -> ${ref}`);
  }
}
if (broken.length) {
  throw new Error('HTML 引用了不存在的本地资源（把它加进上面的镜像清单，或修正引用）：\n  ' + broken.join('\n  '));
}
