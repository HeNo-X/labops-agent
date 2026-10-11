/** Public account destinations are configuration, never request input. */
export function accountLinks(profile:{identity?:string}|null,explicit=process.env.LABOPS_MAIN_PUBLIC_URL,upstream=process.env.LABOPS_BUSINESS_URL):Record<string,string>{
 if(!profile||!['admin','volunteer'].includes(profile.identity||''))return {};
 try{
  const url=new URL(explicit||upstream||'');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return {};
  const h=url.hostname.toLowerCase();
  if(!explicit&&(url.protocol!=='https:'||!h.includes('.')||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)||h.endsWith('.local')||h==='[::1]'))return {};
  if(!url.pathname.endsWith('/'))url.pathname+='/';
  const page=profile.identity==='admin'?'admin.html':'volunteer.html';
  return Object.fromEntries(['profile','password'].map(category=>{const link=new URL(page,url);link.searchParams.set('labops-account',category);return [category,link.href];}));
 }catch{return {};}
}
