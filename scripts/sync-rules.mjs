import fs from 'node:fs';
const source = new URL('../../Pages/lib/calendar.js',import.meta.url);
const mirror = new URL('../shared/calendar.cjs',import.meta.url);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(source,'utf8') !== fs.readFileSync(mirror,'utf8')) throw new Error('calendar mirror differs; run npm run sync:rules');
} else fs.copyFileSync(source,mirror);

for (const [from,to] of [['../../Pages/operations.html','../public/operations.html'],['../../Pages/lib/operations-ui.js','../public/lib/operations-ui.js']]) {
  const source = new URL(from,import.meta.url), target = new URL(to,import.meta.url);
  if(process.argv.includes('--check')) {if(fs.readFileSync(source,'utf8')!==fs.readFileSync(target,'utf8'))throw new Error('Workbench mirror differs');}
  else {fs.mkdirSync(new URL('.',target),{recursive:true});fs.copyFileSync(source,target);}
}

for(const [name,globalName] of [['sse','LabOpsSSE'],['labops-targets','LabOpsTargets']]){
 const source=new URL('../../Pages/lib/'+name+'.js',import.meta.url),target=new URL('../shared/'+name+'.js',import.meta.url);
 const raw=fs.readFileSync(source,'utf8'),body=raw.slice(raw.indexOf('function(){')+'function(){'.length,raw.lastIndexOf('});'));
 const contents='// Generated from Pages/lib/'+name+'.js; npm run sync:rules\nconst api=(()=>{'+body+'})();\nexport default api;\n';
 if(process.argv.includes('--check')){if(fs.readFileSync(target,'utf8')!==contents)throw new Error(name+' mirror differs');}else fs.writeFileSync(target,contents);
}

for(const name of ['scheduled-params']){const from=new URL('../../Pages/lib/'+name+'.json',import.meta.url),to=new URL('../shared/'+name+'.json',import.meta.url);if(process.argv.includes('--check')){if(fs.readFileSync(from,'utf8')!==fs.readFileSync(to,'utf8'))throw new Error(name+' mirror differs');}else fs.copyFileSync(from,to);}
