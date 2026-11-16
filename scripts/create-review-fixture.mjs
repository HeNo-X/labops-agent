import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

/** Isolated fixture data for tests. Refuses to overwrite any existing business data. */
export function createReviewFixture(directory, date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())){
  directory=path.resolve(directory);
  if(fs.existsSync(path.join(directory,'state.json'))||fs.existsSync(path.join(directory,'credentials.json')))throw new Error('目录已有数据，拒绝覆盖；请使用新的空目录');
  fs.mkdirSync(directory,{recursive:true});
  const day=new Date(date+'T00:00:00Z'),weekday=day.getUTCDay();
  const monday=new Date(day.getTime()-((weekday+6)%7)*86400000),termEnd=new Date(monday.getTime()+139*86400000);
  const users=[{username:'review-admin',identity:'admin',name:'测试管理员'},{username:'review-volunteer',identity:'volunteer',name:'测试志愿者'},{username:'review-student',identity:'student',name:'测试学生',className:'测试示例班'}];
  const credentials={},accounts=[];
  for(const user of users){
    const password=crypto.randomBytes(12).toString('base64url'),salt=crypto.randomBytes(16).toString('hex');
    credentials[user.username]={...user,status:'active',salt,hash:crypto.scryptSync(password,salt,64).toString('hex'),mustChangePassword:false};
    accounts.push({account:user.username,password,identity:user.identity});
  }
  const state={version:9,fixture:true,fixtureNote:'隔离的测试数据，与真实排班和校历无关，不是学校实际排班或校历',users,
    labs:[{id:'fixture-e310',name:'E310',status:'active',capacity:40,equipment:['投影仪'],location:'演示楼E310',sortOrder:1},{id:'fixture-e312',name:'E312',status:'active',capacity:60,equipment:['投影仪'],location:'演示楼E312',sortOrder:2}],openLabs:[],
    classes:[{id:'fixture-class',name:'测试示例班',size:30}],classRoster:[{sno:'review-student',className:'测试示例班'}],
    courses:[{id:'fixture-course',name:'示例程序设计',requiredEquipment:['投影仪']}],
    timetable:[{id:'fixture-lesson',term:'测试学期',className:'测试示例班',classNames:['测试示例班'],courseId:'fixture-course',courseName:'示例程序设计',teacher:'示例教师',labId:'fixture-e310',labName:'E310',weekday,periodKey:'pm1',weeks:{from:1,to:20,parity:'all'},status:'normal',updatedAt:new Date().toISOString()}],
    sysConfig:{term:'测试学期',termStart:monday.toISOString().slice(0,10),termEnd:termEnd.toISOString().slice(0,10),holidays:[],specialDays:[]},
    dutyShifts:[{id:'fixture-shift',date,periodKey:'pm1',roomId:'fixture-e310',roomName:'E310',userId:'review-volunteer',createdBy:'review-admin'}],
    scheduleAdjust:[],keys:[],notifications:[],inspectionRecords:[],handoverRecords:[],checkinRecords:[],volunteerRecords:[],openLabRecords:[],openLabStatus:{},gamification:{}};
  for(const [file,value]of Object.entries({'state.json':{rev:1,state},'credentials.json':credentials,'sessions.json':{},'review-access.json':{fixture:true,date,accounts}}))fs.writeFileSync(path.join(directory,file),JSON.stringify(value,null,2),{mode:0o600});
  return {directory,date,accounts};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=createReviewFixture(process.argv[2]||fileURLToPath(new URL('../../.review-data',import.meta.url)));
  console.log('已创建隔离测试数据。账号与随机密码见：'+path.join(result.directory,'review-access.json'));
}
