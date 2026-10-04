import type { Dataset } from './store.ts';
import { activeClosures } from '../operations/overlays.ts';
/** Native data is authoritative. Sandbox overlays never contaminate connected live queries. */
export function closuresFor(ds:Dataset,date:string,period?:string){
  if(ds.sourceType==='live')return (ds.roomClosures||[]).filter(c=>c.status!=='revoked'&&c.startDate<=date&&c.endDate>=date&&(!period||!c.periodKeys.length||c.periodKeys.includes(period)));
  return [...(ds.roomClosures||[]).filter(c=>c.status!=='revoked'&&c.startDate<=date&&c.endDate>=date&&(!period||!c.periodKeys.length||c.periodKeys.includes(period))),...activeClosures(date,period)];
}
