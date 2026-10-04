/** Current-version browser acceptance. Starts only isolated fictional local services. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createReviewFixture} from '../scripts/create-review-fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),agentRoot=path.join(root,'labops-agent');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'labops-review-browser-'));
const fixture=createReviewFixture(path.join(temp,'native'));
const shots=path.join(agentRoot,'.screenshots','review');fs.mkdirSync(shots,{recursive:true});
const results=[],children=[];let browser,debugPage,logs='';
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function launch(file,env){const child=spawn(process.execPath,[file],{cwd:agentRoot,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',c=>{logs+=c.toString();});child.stderr.on('data',c=>{logs+=c.toString();});return child;}
async function ready(url,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('启动失败：'+logs);try{if((await fetch(url+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('启动超时：'+logs);}
async function record(name,fn){console.log('RUN '+name);await fn();results.push({name,pass:true});console.log('PASS '+name);}
// Optional local font for CJK visual QA in minimal CI images; no product asset changes.
async function reviewFonts(context){
 const cssPath=process.env.LABOPS_QA_FONT_CSS;if(!cssPath)return;
 const dir=path.dirname(cssPath);
 await context.route('**/__qa_fonts/**',route=>{const name=new URL(route.request().url()).pathname.slice('/__qa_fonts/'.length);const file=path.resolve(dir,name);if(!file.startsWith(dir+path.sep))return route.abort();return route.fulfill({path:file,contentType:file.endsWith('.css')?'text/css':'font/woff2'});});
 await context.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{const l=document.createElement('link');l.rel='stylesheet';l.href='/__qa_fonts/400.css';document.head.appendChild(l);const s=document.createElement('style');s.textContent='*{font-family:"Noto Sans SC",sans-serif !important}';document.head.appendChild(s);}));
}
async function overflow(page){return page.evaluate(()=>Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth));}
async function send(page,message){const n=await page.locator('.msg--assistant').count();await page.locator('#cmd').fill(message);await page.locator('.bar__btn').click();await page.waitForFunction(count=>document.querySelectorAll('.msg--assistant').length>count,n,{timeout:15000});await page.waitForFunction(()=>{const m=[...document.querySelectorAll('.msg--assistant')].at(-1);return m&&m.dataset.status!=='streaming';},null,{timeout:15000});assert.equal(await page.locator('.msg--assistant').last().getAttribute('data-status'),'completed');}
try{
 const nativePort=await freePort(),agentPort=await freePort();
 const nativeUrl=`http://127.0.0.1:${nativePort}`,base=`http://127.0.0.1:${agentPort}`;
 const native=await launch(path.join(root,'Pages','serve.js'),{HOST:'127.0.0.1',PORT:String(nativePort),DATA_DIR:path.join(temp,'native'),REGISTER_OPEN:'0',ENABLE_SEED_ACCOUNTS:'0',ENABLE_BASE_SEED:'0'});
 const agent=await launch(path.join(agentRoot,'server','index.ts'),{HOST:'127.0.0.1',PORT:String(agentPort),LABOPS_DB_PATH:path.join(temp,'agent.sqlite'),LABOPS_BUSINESS_URL:nativeUrl,AGNES_API_KEY:'',LIVE_DATA:'0',LABOPS_AUTH_MODE:'demo',LABOPS_SECURE_COOKIE:'0',LOG_LEVEL:'warn'});
 await ready(nativeUrl,native);await ready(base,agent);
 const executablePath=[process.env.LABOPS_BROWSER_PATH,'/usr/bin/chromium','/usr/bin/google-chrome','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));
 if(!executablePath)throw new Error('请安装 Chrome 并设置 LABOPS_BROWSER_PATH 为浏览器可执行文件');
 browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage',...JSON.parse(process.env.LABOPS_BROWSER_ARGS_JSON||'[]')]});
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),errors=[];
 await reviewFonts(context);debugPage=page;page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.route('**/login-characters.js*',r=>r.abort());
 await record('动画脚本不可用时仍可进入隔离演示会话',async()=>{await page.goto(base);await page.locator('#username').fill('browser-review');await page.locator('#password').fill('demo-only');await page.locator('.login-btn').click();await page.locator('#cmd').waitFor({state:'visible'});});
 await record('E310八条课表追问转换为八行两列表格',async()=>{await send(page,'查询E310在2026-09-28的课表');await send(page,'把刚才的课表改成两列表格，一列课程，一列上课节次');assert.equal(await page.locator('.msg--assistant').last().locator('.safe-markdown tbody tr').count(),8);assert.equal(await page.locator('.msg--assistant').last().locator('.safe-markdown thead th').count(),2);});
 await record('刷新恢复事实表格，桌面无整页横向溢出',async()=>{await page.reload();await page.locator('.safe-markdown table').waitFor();await page.locator('.safe-markdown table').scrollIntoViewIfNeeded();assert.equal(await page.locator('.safe-markdown tbody tr').count(),8);assert.ok(await overflow(page)<=1);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(shots,'agent-desktop.png'),fullPage:true});});
 await record('390px手机会话表格可阅读且无整页横向溢出',async()=>{await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('.safe-markdown table').waitFor();await page.locator('.safe-markdown table').scrollIntoViewIfNeeded();assert.ok(await overflow(page)<=1);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(shots,'agent-mobile.png'),fullPage:true});});
 const adminCtx=await browser.newContext({viewport:{width:1365,height:900}}),admin=await adminCtx.newPage();await reviewFonts(adminCtx);admin.on('pageerror',e=>errors.push(e.message));
 async function loginBusiness(p,role,url=base+'/operations.html?bridge=1'){await p.goto(url);const a=fixture.accounts.find(a=>a.identity===role);await p.locator('#account').fill(a.account);await p.locator('#password').fill(a.password);await p.locator('#login-form button').click();await p.locator('#workspace').waitFor({state:'visible'});}
 await record('管理员候选比较、人工确认、原系统同编号调课回查',async()=>{await loginBusiness(admin,'admin');await admin.locator('#reason').fill('隔离演示：投影故障，需要替换教室');await admin.locator('#schedule button').click();const row=admin.locator('#options tr').filter({hasText:'E312'}).filter({hasText:'下午第一大节'});await row.locator('button').click();await admin.locator('#confirm').waitFor({state:'visible'});await admin.evaluate(()=>document.fonts.ready);await admin.screenshot({path:path.join(shots,'schedule-confirm.png'),fullPage:false});await admin.locator('#commit').click();await admin.locator('#confirm').waitFor({state:'hidden'});await admin.waitForFunction(()=>document.querySelector('#receipts').textContent.includes('business-plan-'));await admin.locator('[data-receipt]').first().click();await admin.waitForFunction(()=>document.querySelector('#status').textContent.includes('已回查原系统'));});
 const volCtx=await browser.newContext({viewport:{width:390,height:844}}),vol=await volCtx.newPage();await reviewFonts(volCtx);vol.on('pageerror',e=>errors.push(e.message));
 await record('手机志愿者正式班次逐项交接与异常工单',async()=>{await loginBusiness(vol,'volunteer',nativeUrl+'/operations.html');await vol.locator('#shift').selectOption('fixture-shift');await vol.locator('#check-power').selectOption('abnormal');await vol.locator('#note').fill('隔离演示：投影异常，待管理员跟进；其他项目未确认');await vol.locator('#issue').check();assert.ok(await overflow(vol)<=1);await vol.evaluate(()=>document.fonts.ready);await vol.screenshot({path:path.join(shots,'handover-mobile.png'),fullPage:true});await vol.locator('#handover button').click();await vol.locator('#commit').click();await vol.locator('#confirm').waitFor({state:'hidden'});await vol.waitForFunction(()=>document.querySelector('#receipts').textContent.includes('business-plan-'));assert.ok(await overflow(vol)<=1);});
 await record('定向通知：管理员发布、志愿者手机已读、管理员回查',async()=>{await admin.locator('[data-tab="notices"]').click();await admin.locator('#title').fill('隔离通知');await admin.locator('#notice-content').fill('本通知只发给志愿者，用于本地验收');await admin.locator('#audience').selectOption('volunteer');await admin.locator('#notice button').click();await admin.waitForFunction(()=>document.querySelector('#content').textContent.includes('隔离通知'));await vol.reload();await vol.locator('[data-tab="notices"]').click();await vol.locator('[data-read]').first().click();await vol.waitForFunction(()=>document.querySelector('[data-read]')?.disabled);await admin.reload();await admin.locator('[data-tab="notices"]').click();await admin.waitForFunction(()=>document.querySelector('#content').textContent.includes('已读 1 人'));});
 await record('原管理员移动页使用新巡检记录显示异常，历史导出兼容新结构',async()=>{
   const account=fixture.accounts.find(a=>a.identity==='admin');const login=await fetch(nativeUrl+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)}).then(r=>r.json());
   const n=await volCtx.newPage();n.on('pageerror',e=>errors.push(e.message));await n.goto(nativeUrl+'/operations.html');
   await n.evaluate(({token,profile})=>{localStorage.setItem('vol_user_token',token);localStorage.setItem('lab_current_user',JSON.stringify(profile));},login);
   await n.goto(nativeUrl+'/admin-mobile.html');await n.waitForFunction(()=>document.querySelector('#app')?.__vue__?.inspectionSummary?.status==='abnormal',null,{timeout:15000});
   assert.ok(await n.locator('.stat-grid').innerText().then(t=>t.includes('存在异常')));
   assert.equal(await n.evaluate(()=>document.querySelector('#app').__vue__.inspectionHistory[0].results.length),5);
   await n.evaluate(()=>document.fonts.ready);await n.screenshot({path:path.join(shots,'native-admin-mobile.png'),fullPage:false});await n.close();
 });
 await record('原学生桌面与移动页今日课表反映已确认的指定日期调课',async()=>{
   const account=fixture.accounts.find(a=>a.identity==='student');const login=await fetch(nativeUrl+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(account)}).then(r=>r.json());
   const c=await browser.newContext({viewport:{width:390,height:844}});await reviewFonts(c);const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(nativeUrl+'/operations.html');await p.evaluate(({token,profile})=>{localStorage.setItem('vol_user_token',token);localStorage.setItem('lab_current_user',JSON.stringify(profile));},login);
   await p.goto(nativeUrl+'/student-mobile.html');await p.waitForFunction(()=>document.querySelector('#app')?.__vue__?.todayLessons?.some(x=>x.labName==='E312'),null,{timeout:15000});await p.setViewportSize({width:1365,height:900});await p.goto(nativeUrl+'/student.html');await p.waitForFunction(()=>document.querySelector('#app')?.__vue__?.todayLessons?.some(x=>x.labName==='E312'),null,{timeout:15000});await c.close();
 });
 await record('业务工作台手机布局及脚本运行无错误',async()=>{await admin.setViewportSize({width:390,height:844});assert.ok(await overflow(admin)<=1);await admin.evaluate(()=>document.fonts.ready);await admin.screenshot({path:path.join(shots,'notices-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);});
 console.log(JSON.stringify({passed:results.length,failed:0,results},null,2));
 fs.writeFileSync(path.join(shots,'results.json'),JSON.stringify({passed:results.length,failed:0,results},null,2));
}catch(e){console.error(e);if(debugPage)console.error(await debugPage.evaluate(()=>({url:location.pathname,text:document.body.textContent.slice(0,1200),inputs:[...document.querySelectorAll('input')].map(i=>({id:i.id,length:i.value.length}))})));if(debugPage){console.error((await debugPage.locator('body').innerText()).slice(-5000));await debugPage.screenshot({path:path.join(shots,'failure.png'),fullPage:true});}console.error(logs.slice(-3000));process.exitCode=1;}finally{await browser?.close();for(const child of children)child.kill('SIGTERM');await Promise.all(children.map(c=>new Promise(r=>{if(c.exitCode!==null||c.signalCode!==null)return r();c.once('exit',r);setTimeout(()=>{c.kill('SIGKILL');r();},1000);})));fs.rmSync(temp,{recursive:true,force:true});}
