declare const api:{createDecoder(onEvent:(event:any)=>void):{push(chunk:Uint8Array|string):void;finish():void};terminal(event:any):null|{done:boolean;saved:boolean;status:string;error:string|null}};
export default api;
