/* Shared installed-client runtime. Ordinary web pages retain their original transport. */
(function (g) {
  'use strict';
  const cfg=g.__QZ_CLIENT__ || null, native=!!cfg, browserFetch=g.fetch.bind(g);
  const key='qz.client.session:'+(cfg?cfg.mainApiBase+'|'+cfg.agentApiBase:'web');
  const listeners=new Set(), nativeAny=AbortSignal.any&&AbortSignal.any.bind(AbortSignal); let failedWrite=false;
  function session(){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
  function clearSession(){localStorage.removeItem(key);sessionStorage.removeItem('qz.password-token');}
  function notify(message,error=true){
    if(!native)return;
    const show=()=>{
      let box=document.getElementById('qz-client-status');
      if(!box){box=document.createElement('div');box.id='qz-client-status';box.setAttribute('role','status');document.body.appendChild(box);}
      box.textContent=message;box.className=error?'qz-client-error':'';box.hidden=false;
      if(notify.timer)clearTimeout(notify.timer);
      notify.timer=setTimeout(()=>{box.hidden=true;},error?6000:2600);
    };
    if(document.body)show();else document.addEventListener('DOMContentLoaded',show,{once:true});
  }
  // 原生设置/账号页用于继承当前角色主题（配色、夜间模式、字体），保证与站内其它页面一致
  function rememberTheme(){
    try{
      const root=getComputedStyle(document.documentElement), body=getComputedStyle(document.body);
      const names=['--primary','--primary-dark','--primary-light','--danger','--success','--warning','--info',
        '--card-bg','--main-bg','--main-grad','--gray-50','--gray-100','--gray-200','--gray-300','--gray-400',
        '--gray-500','--gray-600','--gray-700','--gray-800','--gray-900','--font-serif'];
      const vars={};for(const n of names){const v=root.getPropertyValue(n).trim();if(v)vars[n]=v;}
      vars.text=body.color;vars.bg=body.backgroundColor;vars.font=body.fontFamily;vars.size=body.fontSize;
      sessionStorage.setItem('qz.native.theme',JSON.stringify(vars));
    }catch(e){}
  }
  function apiUrl(path,service){
    if(!native)return path;
    const u=new URL(String(path),location.href);
    if(!u.pathname.startsWith('/api/'))return u.href;
    const target=service||(cfg.product==='labops'?'agent':'main');
    let route=u.pathname;
    if(target==='agent'){
      const auth={'/api/auth/login':'/api/auth/client/login','/api/auth/session':'/api/auth/client/session','/api/auth/logout':'/api/auth/client/logout','/api/auth/sso/exchange':'/api/auth/client/sso-exchange'};
      route=auth[route]||route;
    }
    return (target==='agent'?cfg.agentApiBase:cfg.mainApiBase).replace(/\/$/,'')+route+u.search;
  }
  function token(service){return service==='main'?localStorage.getItem('vol_user_token')||'':session()?.accessToken||'';}
  function headers(input,service){const h=new Headers(input||{});if(native){h.delete('X-Labops-Sandbox-Role');const t=token(service);if(t)h.set('Authorization','Bearer '+t);}return h;}
  function combine(signals){
    if(nativeAny)return nativeAny(signals);
    const c=new AbortController();for(const s of signals){if(s.aborted)c.abort(s.reason);else s.addEventListener('abort',()=>c.abort(s.reason),{once:true});}return c.signal;
  }
  async function request(input,options,service){
    if(!native)return browserFetch(input,options);
    const chosen=service||(cfg.product==='labops'?'agent':'main'),original=new URL(String(input),location.href);
    if(!original.pathname.startsWith('/api/'))return browserFetch(input,options);
    const url=apiUrl(input,chosen),u=new URL(url),opts=Object.assign({},options||{}),method=(opts.method||'GET').toUpperCase();
    if(chosen==='agent'&&u.pathname==='/api/auth/client/session'&&!session()?.accessToken)return new Response(JSON.stringify({mode:'native',authenticated:false,clientProtocol:1}),{headers:{'Content-Type':'application/json'}});
    opts.headers=headers(opts.headers,chosen);opts.credentials='omit';
    const streaming=/\/messages$|\/agent\/chat$|\/ai\/chat$/.test(u.pathname)&&method==='POST';
    const timeout=new AbortController();const timer=setTimeout(()=>timeout.abort(),streaming?180000:15000);
    opts.signal=combine([timeout.signal,...(opts.signal?[opts.signal]:[])]);
    try{
      const res=await browserFetch(url,opts);
      if(chosen==='main'&&u.pathname==='/api/auth/login'&&res.ok){const out=await res.clone().json();let old;try{old=JSON.parse(localStorage.getItem('lab_current_user')||'null');}catch{}if(old?.username!==out.profile?.username){localStorage.removeItem('lab_system_state');sessionStorage.clear();}if(out.token){localStorage.setItem('vol_user_token',out.token);if(g.QzVault)await g.QzVault.flush();}}
      // Do not consume streaming bodies here. The existing SSE parser owns them.
      if(chosen==='agent'&&/\/client\/(login|sso-exchange)$/.test(u.pathname)&&res.ok){
        const out=await res.clone().json();
        if(out.passwordChangeToken){clearSession();sessionStorage.setItem('qz.password-token',out.passwordChangeToken);location.assign('/client/account.html?required=1');throw new Error('请先修改临时密码');}
        if(out.accessToken){
          const old=session();if(old?.profile?.username!==out.profile?.username){for(let i=sessionStorage.length-1;i>=0;i--){const k=sessionStorage.key(i);if(k&&k.startsWith('labops.'))sessionStorage.removeItem(k);}}
          localStorage.setItem(key,JSON.stringify(out));sessionStorage.removeItem('labops.manual-logout');
          if(g.QzVault)await g.QzVault.flush();
        }
      }
      if(u.pathname.endsWith('/logout')){if(chosen==='agent')clearSession();else localStorage.removeItem('vol_user_token');if(g.QzVault)await g.QzVault.flush();}
      if(res.status===401&&!/\/login$|change-password$/.test(u.pathname)){
        if(chosen==='agent')clearSession();else localStorage.removeItem('vol_user_token');
        g.dispatchEvent(new CustomEvent('qz-auth-expired'));
      }
      if(!res.ok&&method!=='GET'&&method!=='HEAD'){failedWrite=true;notify('本次操作未获服务器确认，请检查页面错误后重试。');}
      if(res.ok&&method!=='GET'&&method!=='HEAD'&&!streaming&&!u.pathname.startsWith('/api/auth/')){failedWrite=false;}
      return res;
    }catch(e){if(method!=='GET'&&method!=='HEAD'){failedWrite=true;notify('连接中断，本次操作未确认。请回查服务器记录，不要重复提交。');}throw e;}
    finally{clearTimeout(timer);}
  }
  // —— 安装版「设置 → 高级设置」：服务器地址与连接检查（登录后可改；登录页只留低调文字入口）——
  function environment(){return {mainApiBase:cfg.mainApiBase,agentApiBase:cfg.agentApiBase,mainPublicBase:cfg.mainPublicBase};}
  function normalizeEnvironment(raw){
    const values={};
    for(const key of ['mainApiBase','agentApiBase','mainPublicBase']){
      const text=String((raw&&raw[key])||'').trim();
      if(!text)throw new Error('请填写主系统、LabOps 与签到分享三个 HTTPS 地址。');
      let u;try{u=new URL(text);}catch{throw new Error('地址格式不正确，请填写 HTTPS 域名和端口。');}
      if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('请填写 HTTPS 域名和端口，不附带路径或登录凭证。');
      values[key]=u.origin;
    }
    return values;
  }
  async function clearLocalSession(){
    try{await request('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}
    const environment=localStorage.getItem('qz.client.environment');
    localStorage.clear();sessionStorage.clear();
    if(environment)localStorage.setItem('qz.client.environment',environment);
    if(g.QzVault)await g.QzVault.flush();
  }
  function loginPage(){return cfg.product==='main'?'/login.html':cfg.edition==='mobile'?'/mobile.html':'/index.html';}
  async function applyEnvironment(raw,options){
    const values=normalizeEnvironment(raw);
    await clearLocalSession();
    localStorage.setItem('qz.client.environment',JSON.stringify(values));
    if(!options||options.redirect!==false)location.replace(loginPage());
    return values;
  }
  async function diagnose(){
    const out=[];
    for(const service of ['main','agent']){
      const label=service==='main'?'主系统':'LabOps';
      try{const r=await request('/api/health',{},service);out.push({service,label,ok:r.ok,status:r.status,message:label+'：HTTP '+r.status+(r.ok?'，可连接':'，请检查服务配置')});}
      catch{out.push({service,label,ok:false,status:0,message:label+'：连接失败，请检查网络、证书与服务器跨域配置'});}
    }
    return out;
  }
  const bridge=()=>g.QzNative;
  async function waitBridge(){if(bridge())return bridge();for(let n=0;n<80;n++){await new Promise(r=>setTimeout(r,50));if(bridge())return bridge();}throw new Error('设备功能尚未准备完成，请重新打开应用');}
  async function base64(blob){const bytes=new Uint8Array(await blob.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=16384)raw+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(raw);}
  async function saveFile(blob,name){const b=await waitBridge();return b.saveFile({name:name||'export.bin',mime:blob.type||'application/octet-stream',data:await base64(blob)});}
  async function openCompanion(product,target){
    const name=product==='labops'?'qizhen-labops':'qizhen-lab',u=new URL(name+'://open');
    for(const [k,v] of Object.entries(target||{}))if(typeof v==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(v))u.searchParams.set(k,v);
    if(cfg.product==='main'&&product==='labops'&&token('main')){
      try{const response=await request('/api/auth/labops-ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:target||{view:'home'}})},'main');if(!response.ok)throw new Error('无法获取配套应用登录票据');const result=await response.json(),ticket=new URLSearchParams(new URL(result.url).hash.slice(1)).get('labops-ticket');if(ticket&&/^[a-f0-9]{64}$/.test(ticket))u.hash='labops-ticket='+ticket;}catch(e){notify(e.message);return;}
    }
    try{await (await waitBridge()).openUrl(u.href);}catch{notify('尚未找到对应应用，请先安装。账户资料也可以在本应用设置中处理。');}
  }
  function deepLink(raw,ready){
    if(!ready&&location.pathname==='/client/boot.html'){sessionStorage.setItem('qz.pending-link',raw);return;}
    let u;try{u=new URL(raw);}catch{return;}
    if(u.protocol!==(cfg.product==='labops'?'qizhen-labops:':'qizhen-lab:'))return;
    const params=new URLSearchParams();
    for(const [k,v] of u.searchParams)if(['view','conversationId','roomId','jobId','taskId','noticeId','category','section'].includes(k)&&/^[A-Za-z0-9_.-]{1,100}$/.test(v))params.set(k,v);
    if(cfg.product==='main'){
      if(params.has('category')){location.assign('/client/account.html?'+params.toString());return;}
      let current;try{current=JSON.parse(localStorage.getItem('lab_current_user')||'null');}catch{}
      const role=current?.identity;
      location.assign(token('main')&&['admin','volunteer','student'].includes(role)?'/'+role+(cfg.edition==='mobile'?'-mobile':'')+'.html':'/login.html');return;
    }
    const ticket=new URLSearchParams(u.hash.slice(1)).get('labops-ticket');
    location.assign((cfg.edition==='mobile'?'/mobile.html':'/index.html')+'?'+params.toString()+(ticket&&/^[a-f0-9]{64}$/.test(ticket)?'#labops-ticket='+ticket:''));
  }
  const geo={getCurrentPosition(ok,fail,options){
    if(!native||cfg.platform==='windows'){navigator.geolocation.getCurrentPosition(ok,fail,options);return;}
    waitBridge().then(b=>b.getLocation(options||{})).then(p=>ok({coords:{latitude:p.latitude,longitude:p.longitude,accuracy:p.accuracy},timestamp:p.timestamp||Date.now()})).catch(e=>fail({code:e.code==='PERMISSION_DENIED'?1:2,message:e.message}));
  }};
  g.LabClient={isNative:native,config:cfg,fetch:request,apiUrl,headers,session,clearSession,notify,saveFile,openCompanion,deepLink,geolocation:geo,
    publicBase:()=>native?cfg.mainPublicBase:location.origin,
    edition:fallback=>native?cfg.edition:fallback,
    writeFailure(error){failedWrite=true;notify(error?.message||'未保存到服务器，请联网后重新提交');},
    get hasWriteFailure(){return failedWrite;},
    toast(message,type){return native&&type==='success'&&/保存|删除|更新|提交|发布|成功|已改/.test(message)?{message:'正在处理，请以服务器确认结果为准。',type:'info'}:{message,type};},
    onResume(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    resume(){for(const fn of listeners)try{fn();}catch{}g.dispatchEvent(new Event('qz-resume'));document.dispatchEvent(new Event('visibilitychange'));},
    account(){rememberTheme();location.assign('/client/account.html');},
    settings(){rememberTheme();location.assign('/client/settings.html');},
    advanced(){rememberTheme();location.assign('/client/settings.html#advanced');},
    environment,normalizeEnvironment,clearLocalSession,applyEnvironment,diagnose,loginPage
  };
  if(!native)return;
  document.documentElement.dataset.qzPlatform=cfg.platform;
  if(cfg.product==='main'){const match=/^\/(admin|volunteer|student)(-mobile)?\.html$/.exec(location.pathname);if(match){const target='/'+match[1]+(cfg.edition==='mobile'?'-mobile':'')+'.html';if(location.pathname!==target)location.replace(target+location.search);}}
  if(!AbortSignal.timeout)AbortSignal.timeout=ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;};
  if(!AbortSignal.any)AbortSignal.any=combine;
  if(!Object.hasOwn)Object.hasOwn=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const originalClick=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download&&/^(blob:|data:)/.test(this.href)){browserFetch(this.href).then(r=>r.blob()).then(b=>saveFile(b,this.download)).then(saved=>{if(saved!==false)notify('文件已交给系统保存。',false);}).catch(e=>notify(e.message));return;}
    return originalClick.call(this);
  };
  document.addEventListener('click',function(e){
    // 各端「设置 → 高级设置」入口（标记元素在各页里默认隐藏，仅安装版 CSS 显示）
    const entry=e.target.closest?.('[data-qz-advanced]');
    if(entry){e.preventDefault();g.LabClient.advanced();return;}
    const a=e.target.closest?.('a[href]');if(!a)return;
    const u=new URL(a.href,location.href);
    if(a.download&&/^(blob:|data:)/.test(u.href)){e.preventDefault();a.click();return;}
    if(u.origin===new URL(cfg.mainPublicBase).origin&&u.searchParams.has('labops-account')){e.preventDefault();location.assign('/client/account.html?category='+encodeURIComponent(u.searchParams.get('labops-account')));return;}
    if(['http:','https:'].includes(u.protocol)&&u.origin!==location.origin&&!u.pathname.startsWith('/api/')){e.preventDefault();waitBridge().then(b=>b.openUrl(u.href)).catch(x=>notify(x.message));}
  },true);
  g.addEventListener('offline',()=>notify('网络未连接。界面保留在本机，业务提交需要联网。'));
  g.addEventListener('online',()=>{notify('网络已恢复，请回查刚才的操作结果。',false);g.LabClient.resume();});
  g.addEventListener('qz-auth-expired',()=>{
    if(location.pathname.startsWith('/client/')||/login\.html$/.test(location.pathname))return;
    notify('登录已失效，请重新登录。');
    setTimeout(()=>location.replace(cfg.product==='main'?'/login.html':cfg.edition==='mobile'?'/mobile.html':'/index.html'),50);
  });
  document.addEventListener('DOMContentLoaded',()=>{
    const css=document.createElement('link');css.rel='stylesheet';css.href='/client/native.css';document.head.appendChild(css);
    // 取消「应用设置」悬浮按钮：登录页只保留一个低调的文字入口，登录后的入口在各页「设置 → 高级设置」。
    if(cfg.product==='main'&&/\/login\.html$/.test(location.pathname)){
      const link=document.createElement('button');link.type='button';link.className='qz-conn-link';link.textContent='连接设置';link.setAttribute('aria-label','连接设置：核对服务器地址与连接状态');link.onclick=()=>g.LabClient.advanced();document.body.appendChild(link);
    }
    if(!navigator.onLine)notify('网络未连接。可查看本地界面，联网后再登录。');
  },{once:true});
})(window);
