export type DomainDecision='query'|'redirect'|'capabilities'|'clarify';
const BUSINESS=/实验室|实验安排|课表|排课|课程|调课|停课|教室|房间|空闲|签到|签退|钥匙|借还|设备|报修|维修|投影|巡检|检查清单|值班|班次|交接|工单|停用|恢复开放|故障|通知|日报|运营|定时|提醒|自动化|资料|规程|手册|制度|操作说明|怎么用|登录|登陆|账号|权限|主系统|LabOps|lab(?:oratory)?|timetable|schedule|handover|inspection|repair|work\s*order|room\s*(status|availability)/i;
const EXTERNAL=/天气|股票行情|推荐股票|炒股|旅游攻略|菜谱|做饭|星座|(?:写|编|讲|来).{0,8}(?:一首诗|诗歌|小说|笑话|代码|程序)|讲个笑话|帮我.{0,6}解题|解数学题|政治新闻|(?:法国|美国|英国|日本).{0,6}首都|\b(?:weather|horoscope|recipe|stock\s*price|capital\s+of)\b|\b(?:write|tell).{0,20}\b(?:poem|joke|novel|code)\b/i;
const GREETING=/^(?:你好|您好|嗨|hi|hello|哈喽|谢谢|多谢|感谢|辛苦了?|收到|明白|了解了|好的?|嗯+|ok)[！!。.~，,～\s]*$/i;
const CAPABILITY=/^(?:你|这个助手|LabOps)?(?:是干什么的|能做什么|可以做什么|有什么功能|有什么用|怎么用|帮助|help|what can you do)[？?！!。.\s]*$/i;
const FOLLOWUP=/^(?:选|确认|执行|准备|提交|取消|拒绝|同意|不要|列出|显示|查看|那|那么|还有|再|改|换|重新|继续|昨天|明天|下周|今天|只看|仅看|按|把|用|第|前|刚才|上面|这|它|多少|哪个|为什么|如何|能否|可以|for|what about|and|change|show|same|again)/i;
export function classifyLabRequest(question:string,hasContext=false):DomainDecision{
 const q=question.trim();
 if(GREETING.test(q)||CAPABILITY.test(q))return 'capabilities';
 if(EXTERNAL.test(q))return 'redirect';
 if(BUSINESS.test(q)||/\b[A-Za-z]{1,3}[- ]?\d{2,5}\b/.test(q))return 'query';
 if(hasContext&&FOLLOWUP.test(q))return 'query';
 if(/^(?:帮我|请帮我|查一下|查查|查询|看看|继续|怎么办|帮助我|help me)[？?！!。.\s]*$/i.test(q))return 'clarify';
 return 'redirect';
}
export function scopeAnswer(decision:Exclude<DomainDecision,'query'>):string{
 const intro=decision==='redirect'?'这类问题超出了实验室助手的服务范围，暂时无法为你解答。':decision==='clarify'?'可以，请告诉我实验室名称、日期或你要办理的事项。':'你好，我是启真实验室工作助手。';
 return intro+'\n\n我可以查询课表、房间状态、空闲节次和钥匙登记，检索实验室操作说明，也能协助报修、巡检交接、通知和定时提醒。\n例如：“E310 今天有哪些课？”或“E310 投影没有信号，帮我报修”。';
}
