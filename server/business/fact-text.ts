import type {BusinessResult} from '../../shared/business.ts';
const periods:Record<string,string>={am1:'上午第一节',am2:'上午第二节',pm1:'下午第一节',pm2:'下午第二节',eve_ab:'晚间 AB',eve_cd:'晚间 CD'};
const limit=<T>(rows:T[])=>rows.slice(0,30);
/** Facts are rendered by code. An LLM cannot fill missing values or invent a receipt. */
export function renderBusinessFacts(r:BusinessResult):string{
 const c=r.context,lines:string[]=[];
 if(r.scheduledRule){const p=r.scheduledRule;lines.push(p.spec.name+' 规则方案（待本人确认）', '时区：'+p.spec.timezone+'；接收对象：'+JSON.stringify(p.spec.recipients)+'；效果：'+p.spec.approvedEffects.join('、'));for(const o of p.futureOccurrences)lines.push('• '+o.local+'（UTC '+o.at+'）');lines.push('样例：\n'+p.sample.text);}
 else if(r.scheduledData){const d=r.scheduledData as {jobs?:Array<{id:string;status:string;version:number;nextRunAt:string;spec:{name:string}}> ;results?:Array<{id:string;text:string}>;result?:{text:string}};if(d.result)lines.push(d.result.text);for(const j of (d.jobs||[]).slice(0,30))lines.push(`• ${j.spec.name}｜${j.id}｜${j.status}｜v${j.version}｜下次 ${j.nextRunAt||'无'}`);for(const x of (d.results||[]).slice(0,10))lines.push(x.id+'\n'+x.text);if(!lines.length)lines.push('当前授权范围没有定时规则或已保存结果。');}
 else if(r.report){const report=r.report;lines.push(`${report.date} 日报（${report.scope.label}）`);for(const m of report.metrics)lines.push(`• ${m.label}：${m.value===null?'未知':m.value}；${m.note||'已记录'}；依据编号：${m.objectIds.join('、')||'无/未提供'}；统计时点：${m.effectiveAt}`);lines.push(report.note);}
 else if(c&&r.view==='schedule'){lines.push(`${r.date||c.date} 教学安排：`);for(const t of limit(c.timetable))lines.push(`• ${t.courseName||'课程未录入'}｜${t.labName||t.labId}｜${periods[t.periodKey]||t.periodKey}｜${(t.classNames||[t.className]).join('、')||'班级未录入'}｜教师：${t.teacher||'未录入'}｜编号 ${t.id}`);if(!c.timetable.length)lines.push('该范围没有有效课程记录。校历或课表不完整时，不能据此判断现场空闲。');}
 else if(c&&r.view==='duty'){lines.push('正式排班与交接：');for(const s of limit(c.shifts))lines.push(`• ${s.date} ${periods[s.periodKey]||s.periodKey}｜${s.roomName||s.roomId}｜${s.userId}｜班次 ${s.id}`);for(const h of limit(c.handovers))lines.push(`• 交接 ${h.id}｜${h.status}｜${h.note||'无说明'}｜检查：${h.checklist.map(x=>`${x.label||x.key}=${x.state==='unchecked'?'未确认':x.state==='abnormal'?'异常':'已检查'}`).join('、')}`);for(const i of limit(c.handoverItems||[]))lines.push(`• 遗留 ${i.id}｜${i.description}｜${i.assigneeId||'未指派'}｜截止 ${i.deadline||'未设定'}｜${i.state}`);if(!c.shifts.length)lines.push('当前身份没有正式班次记录。');if(!c.handovers.length)lines.push('当前范围没有交接记录；现场检查状态未知。');}
 else if(c&&r.view==='issues'){for(const i of limit(c.issues))lines.push(`• 工单 ${i.id}｜房间 ${i.roomId}｜${i.description}｜状态 ${i.status}｜负责人 ${i.assigneeId||'未指派'}｜创建 ${i.createdAt}`);if(!c.issues.length)lines.push('当前授权范围没有工单记录。');lines.push('工单登记或提交维修结果不代表现场已经修复。');}
 else if(c&&r.view==='notifications'){for(const n of limit(c.notifications))lines.push(`• 通知 ${n.id}｜${n.title}｜${n.content}｜发布 ${n.time}｜${n.readAt?'本人已读 '+n.readAt:'本人未读'}｜${n.deliveryStatus||'站内存储'}`);if(!c.notifications.length)lines.push('当前身份没有可见通知。');lines.push('站内存储不代表全部收件人已读。');}
 else if(c&&r.view==='closures'){for(const v of limit(c.closures))lines.push(`• 停用 ${v.id}｜${v.roomName||v.roomId}｜${v.startDate} 至 ${v.endDate}｜${v.periodKeys.join('、')}｜${v.reason}｜${v.status}`);if(!c.closures.length)lines.push('没有停用记录。');lines.push('停用日期结束不会自动证明设备修复或房间已开放。');}
 else if(r.view==='incidents'){for(const v of limit(r.incidents|| (r.incident?[r.incident]:[])))lines.push(`• 事件 ${v.id}｜${v.roomName}｜${v.date}｜${v.description}｜${v.status}｜工单 ${v.issueIds.join('、')||'无'}｜停用 ${v.closureIds.join('、')||'无'}｜通知 ${v.noticeIds.join('、')||'无'}`);if(!lines.length)lines.push('当前身份没有可见故障事件。');}
 else if(r.tasks){for(const t of limit(r.tasks.tasks))lines.push(`• 任务 ${t.id}｜${t.kind}｜${t.status}｜版本 ${t.revision}｜更新 ${t.updatedAt}`);if(!lines.length)lines.push('当前身份没有持久业务任务。');}
 else if(r.resourceHealth){const health=r.resourceHealth as {summary?:unknown;missing?:unknown;items?:unknown[]};lines.push('资源健康结果：'+JSON.stringify(health.summary||health.missing||health.items||r.resourceHealth));}
 else if(r.view==='checkin'&&r.plan){const p=r.plan.payload;lines.push('管理员代录方案（待本人确认）：');
  lines.push(`• 给 ${p.targetUsername||'未指定'}${p.className?'（'+p.className+'）':''} 补录 ${p.date||'未指定'} ${periods[p.periodKey||'']||p.periodKey||'未指定'} ${p.labName||p.labId||'未指定'}《${p.courseName||'未录入'}》的签到`);
  lines.push(`• 代录原因：${p.reason||'（缺失——主系统会拒绝无原因的代录）'}`);
  lines.push('提交后记录将标记 agent-manual 并写入审计（代录人与原因），时间以服务器为准；缺口请先现场核实，Agent 不代替现场事实。');}
 else lines.push(r.summary);
 if(r.summary.includes('执行部分请切换'))lines.push('执行部分请切换任务模式并人工确认，本轮未准备或提交业务。');
 if(r.plan)lines.push('方案 '+r.plan.id+' 尚待本人确认，业务未提交。');
 const groups=c?[c.timetable,c.shifts,c.handovers,c.handoverItems||[],c.issues,c.notifications,c.closures]:[r.incidents||[],r.tasks?.tasks||[]];if(groups.some(rows=>rows.length>30))lines.push('正文各组最多显示前 30 条，请缩小查询范围查看其余记录。');
 return lines.join('\n');
}
