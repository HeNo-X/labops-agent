export type Target={view:string;section?:string;conversationId?:string;roomId?:string;jobId?:string;taskId?:string;noticeId?:string;action?:string;issueId?:string};
declare const api:{VIEWS:Record<string,string[]>;normalize(raw:unknown):Target;search(target:Target):string};
export default api;
