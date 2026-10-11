import type {RoomSummary} from '../../shared/mobile.ts';
import {PERIOD_KEYS} from '../../shared/periods.ts';
export function roomFreeForPeriod(r:RoomSummary,period:string):boolean{
 return PERIOD_KEYS.includes(period as typeof PERIOD_KEYS[number])&&r.registryStatus!=='inactive'&&r.recordedDoorState==='open'&&r.serviceState==='normal'&&r.scheduleState!=='unknown'&&!r.schedule.some(l=>l.periodKey===period);
}
export function compareRoomSelection(ids:string[],id:string):string[]{
 return ids.includes(id)?ids.filter(v=>v!==id):ids.length<2?[...ids,id]:ids;
}
