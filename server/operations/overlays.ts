import { getDb } from '../persistence/db.ts';
import { currentActor } from '../security/context.ts';
export function activeClosures(date:string, period?:string):Array<{roomId:string;periodKeys:string[]}> {
  const actor=currentActor();
  if (!actor) return [];
  const rows=getDb().prepare("SELECT roomId,periodKeys FROM biz_closures WHERE createdById=? AND status='active' AND startDate<=? AND endDate>=?").all(actor.id,date,date) as Array<{roomId:string;periodKeys:string}>;
  return rows.map(r=>({roomId:r.roomId,periodKeys:JSON.parse(r.periodKeys) as string[]})).filter(r=>!period||r.periodKeys.includes(period));
}
