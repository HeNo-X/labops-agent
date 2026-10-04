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
