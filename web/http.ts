/** Safe, single-prefix API failures. Proxy HTML and credentials never enter the UI. */
export async function responseError(response:Response):Promise<Error>{
 let data:Record<string,unknown>={};try{const raw:unknown=await response.json();if(raw&&typeof raw==='object'&&!Array.isArray(raw))data=raw as Record<string,unknown>;}catch{/* HTML from a proxy is summarized by status only. */}
 const fallback:Record<number,string>={401:'登录已失效，请重新登录',403:'权限或请求来源未获授权',429:'请求过于频繁，请稍后重试',502:'上游服务不可用',503:'服务暂未就绪'};
 const raw=data['message']||data['error'],message=typeof raw==='string'&&!/[<>]/.test(raw)?raw.slice(0,300):fallback[response.status]||`服务返回 HTTP ${response.status}`;
 const request=response.headers.get('X-Request-ID'),retry=response.headers.get('Retry-After');
 return new Error(message+(retry?`（${retry} 秒后重试）`:'')+(request?`（请求 ${request}）`:''));
}
