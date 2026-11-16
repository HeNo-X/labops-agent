import {registerHooks} from 'node:module';
// 解析钩子：@shared/* 无扩展名补 .ts；带 .js 的映射到仓库里真实的 shared/*.js
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@shared/')){
    const rest=specifier.slice(8);
    if(/\.js$/i.test(rest))return next(new URL('../shared/'+rest,import.meta.url).href,context);
    if(!/\.[a-z]+$/i.test(rest))return next(new URL('../shared/'+rest+'.ts',import.meta.url).href,context);
  }
  if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)&&context.parentURL?.includes('/web/'))return next(new URL(specifier+'.ts',context.parentURL).href,context);
  return next(specifier,context);
}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {
  buildCommands,commandsForState,filterCommands,groupCommands,parseQuery,GROUP_TITLES,GROUP_ORDER,MAX_RECENT
}=await import('../web/lib/command-registry.ts');
import type {CommandContext} from '../web/lib/command-registry.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
/** 每个 run 都用可观测的桩，同时记录被调用次数 */
function ctx(over:Partial<CommandContext>={}):CommandContext & {calls:Record<string,number>}{
  const calls:Record<string,number>={};
  const hit=(k:string)=>()=>{calls[k]=(calls[k]??0)+1;};
  return {
    calls,
    busy:false,
    focusSidebarSearch:hit('focus'),
    newChat:hit('newChat'),
    openOperations:hit('operations'),
    openVision:hit('vision'),
    openAutomation:hit('automation'),
    openSettings:hit('settings'),
    stopRun:hit('stop'),
    actorRole:'admin',
    actorOptions:[{role:'admin',label:'管理员'},{role:'volunteer',label:'志愿者'}],
    switchActor:hit('switchActor'),
    recentSessions:[{id:'c1',title:'E310 课表'},{id:'c2',title:'D526 报修'},{id:'c3',title:'第三'},{id:'c4',title:'第四'}],
    openSession:hit('openSession'),
    ...over
  } as CommandContext & {calls:Record<string,number>};
}

test('T7-01 注册表 id 唯一、分组合法、run 可调用，且每条都能真的执行一次',async()=>{
  const c=ctx();
  const cmds=buildCommands(c);
  const ids=cmds.map(x=>x.id);
  assert.equal(new Set(ids).size,ids.length,'命令 id 必须唯一');
  for(const x of cmds){
    assert.ok(GROUP_ORDER.includes(x.group),`${x.id} 分组非法`);
    assert.ok(x.title.length>0&&x.keywords.length>0,`${x.id} 缺标题或关键词`);
    assert.equal(typeof x.run,'function');
    await x.run();
  }
  // demo 身份：当前角色不重复挂出
  assert.ok(ids.includes('switch-actor-volunteer'));
  assert.ok(!ids.includes('switch-actor-admin'));
  // 最近会话 ≤3，且不挂空标题
  assert.equal(ids.filter((i)=>i.startsWith('session-')).length,MAX_RECENT);
});

test('T7-02 停止当前任务只在 busy 时出现（空闲时不给点了没反应的项）',()=>{
  const idle=commandsForState(buildCommands(ctx({busy:false})),{busy:false});
  const busy=commandsForState(buildCommands(ctx({busy:true})),{busy:true});
  assert.ok(!idle.some((c)=>c.id==='stop-run'));
  assert.ok(busy.some((c)=>c.id==='stop-run'));
});

test('T7-03 模糊匹配中英关键词都能命中（"设"→设置、settings→设置）',()=>{
  const cmds=buildCommands(ctx());
  const zh=filterCommands(cmds,'设','all').map((c)=>c.id);
  assert.ok(zh.includes('open-settings'),'"设" 应命中设置');
  const en=filterCommands(cmds,'settings','all').map((c)=>c.id);
  assert.ok(en.includes('open-settings'),'英文关键词也应命中');
  const sessions=filterCommands(cmds,'#D526','all').map((c)=>c.id);
  assert.deepEqual(sessions,['session-c2'],'# 前缀只看会话且只命中匹配项');
  assert.ok(!sessions.includes('open-settings'),'# 前缀只看会话');
  const commandsOnly=filterCommands(cmds,'>设','all').map((c)=>c.id);
  assert.ok(commandsOnly.includes('open-settings'));
  assert.ok(commandsOnly.every((i)=>!i.startsWith('session-')));
});

test('T7-04 范围 tabs 是筛选：空搜索切 tab 仍出该范围默认内容',()=>{
  const cmds=buildCommands(ctx());
  const all=filterCommands(cmds,'','all');
  const actions=filterCommands(cmds,'','actions');
  const sessions=filterCommands(cmds,'','sessions');
  assert.ok(all.length>actions.length,'全部应包含会话');
  assert.ok(actions.every((c)=>c.group!=='session'));
  assert.ok(sessions.length>0,'空搜索切到会话 tab 也不能空');
  assert.ok(sessions.every((c)=>c.group==='session'));
});

test('T7-05 分组不渲染空标题：没有会话时该组整体消失，但顺序与文案表不删减',()=>{
  const cmds=buildCommands(ctx({recentSessions:[]}));
  const groups=groupCommands(cmds);
  assert.ok(!groups.some((g)=>g.group==='session'),'无会话时不应出现空的"最近会话"标题');
  assert.deepEqual(groups.map((g)=>g.group),['suggested','navigate','configure']);
  // 文案表与顺序仍完整（不能因为本轮没内容就从注册表里删掉）
  assert.deepEqual(GROUP_ORDER,['suggested','navigate','configure','session']);
  assert.ok(GROUP_TITLES.session.length>0);
});

test('T7-06 parseQuery：> 与 # 前缀互斥且剥离前缀',()=>{
  assert.deepEqual(parseQuery('>new'),{text:'new',commandOnly:true,sessionOnly:false});
  assert.deepEqual(parseQuery('  #会话'),{text:'会话',commandOnly:false,sessionOnly:true});
  assert.deepEqual(parseQuery('设置'),{text:'设置',commandOnly:false,sessionOnly:false});
});

test('T7-07 命令引用的 store 成员真实存在（对 store 源码做轻量反射，不引入 auth/i18n 依赖链）',()=>{
  const session=fs.readFileSync(path.join(root,'web/stores/session.ts'),'utf8');
  const run=fs.readFileSync(path.join(root,'web/stores/run.ts'),'utf8');
  // 这些是命令面板真正调用的成员，必须出现在 store 的对外返回块里
  for(const key of ['openConversation','startDraft','conversations']){
    assert.match(session,new RegExp(`\\b${key}\\b`),`session store 缺 ${key}`);
  }
  for(const key of ['inputLocked','cancelRun']){
    assert.match(run,new RegExp(`\\b${key}\\b`),`run store 缺 ${key}`);
  }
  // 侧栏聚焦通道必须是可调用函数（命令面板"聚焦会话搜索"依赖它）
  const focus=fs.readFileSync(path.join(root,'web/lib/sidebar-focus.ts'),'utf8');
  assert.match(focus,/export function requestSidebarSearchFocus/);
  // 命令面板引用的 labops-target 通道在三个面板里都已存在（不引入新机制）
  for(const panel of ['web/components/VisionPanel.vue','web/components/automation/AutomationPanel.vue','web/components/NativeWorkPanel.vue']){
    assert.match(fs.readFileSync(path.join(root,panel),'utf8'),/labops-target/,`${panel} 未接入 labops-target`);
  }
});

test('T7-08 全局只有一个 Ctrl/Cmd+K 监听（静态断言：其余组件不得再绑该键）',()=>{
  const palette=fs.readFileSync(path.join(root,'web/components/CommandPalette.vue'),'utf8');
  assert.ok(/ctrlKey\s*\|\|\s*e\.metaKey/.test(palette),'命令面板必须绑定 Ctrl/Cmd');
  assert.ok(/=== ?'k'/.test(palette.replace(/\s/g,'')),'命令面板绑定 K 键');
  const sidebar=fs.readFileSync(path.join(root,'web/components/AgentSidebar.vue'),'utf8');
  assert.ok(!/ctrlKey/.test(sidebar),'侧栏不得再监听 Ctrl 组合键（已上提到命令面板）');
  // 全仓扫描：只有命令面板同时出现 ctrlKey 与 k 判定
  const offenders:string[]=[];
  const walk=(dir:string)=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const p=path.join(dir,entry.name);
      if(entry.isDirectory()){if(!['node_modules','dist'].includes(entry.name))walk(p);continue;}
      if(!/\.(vue|ts)$/.test(entry.name))continue;
      const src=fs.readFileSync(p,'utf8');
      if(/ctrlKey/.test(src)&&/===\s*'k'/.test(src))offenders.push(path.relative(root,p).split(path.sep).join('/'));
    }
  };
  walk(path.join(root,'web'));
  assert.deepEqual(offenders,['web/components/CommandPalette.vue'],`Ctrl+K 监听者应唯一，实际：${offenders.join('、')}`);
});
