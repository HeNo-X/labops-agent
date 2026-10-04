import { createRequire } from 'node:module';
import type { Dataset, TimetableRow } from './store.ts';
import type { TermConfig } from '../time/term.ts';
const require = createRequire(import.meta.url);
export const calendar = require('../../shared/calendar.cjs') as {
  dayContext(date:string,term:TermConfig): {weekNo:number|null;weekday:number;holiday:boolean;coverage:string};
  effective(date:string,ds:Dataset):TimetableRow[];
  stats(rows:TimetableRow[]):{recordCount:number;activityCount:number;classCount:number;occupiedPeriodCount:number;conflicts:Array<{slot:string;activityIds:string[];status:string}>};
};
export function effectiveSchedule(ds:Dataset,date:string):TimetableRow[]{return calendar.effective(date,ds);}
