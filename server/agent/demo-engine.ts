import {renderBusinessFacts} from '../business/fact-text.ts';
import type { KnowledgeResult, BusinessPlanResult } from '../../shared/types.ts';
/**
 * 演示引擎 —— 不依赖大模型的确定性兜底（无 AGNES_API_KEY 时启用）
 * ============================================================================
 *  定位：**等价替换**，不是"假装修好了"。它产出的 SSE 事件与 Agnes 引擎完全同构
 *  （run_started → tool_started → tool_result → answer_delta → run_completed），
 *  所以前端、组件、状态机一行都不用改。
 *
 *  它换掉的是「意图理解 + 工具选择 + 组织语言」这一段：用服务端规则解析代替模型。
 *  这是诚实的降级 —— 界面与回答里都会写明「演示引擎·未接入大模型」，
 *  且**不会**把规则引擎的措辞说成"AI 分析"。
 *
 *  它不换的是数据层：数据仍然走注册表里的只读工具，数据来源仍如实标注。
 *  阶段 2A：支持三个工具的路由（query_schedule / query_lab_status / query_free_rooms）。
 */

import type { FreeRoomsResult, LabStatusResult, OperationsReportResult, QueryScheduleArgs, ScheduleQueryResult, ToolResultKind } from '../../shared/types.ts';
import type { Proposal } from '../../shared/operations-contract.ts';
import type { Dataset } from '../data/store.ts';
import { weekdayOf } from '../time/term.ts';
import type { Intent } from './intent.ts';
import { executeTool } from '../tools/registry.ts';
import type { ToolContext, ToolExecution } from '../tools/registry.ts';

export interface DemoPlan {
  /** 本次要调的工具名 */
  tool: string;
  /** 是否要调工具 */
  callTool: boolean;
  args: Record<string, unknown>;
  /** 不调工具时直接给的话（越界/能力外问题） */
  directReply: string | null;
  needsDisclosure: string[];
}

const OUT_OF_SCOPE_PATTERNS: Array<[RegExp, string]> = [
  [/爬虫|爬取|抓取网页|批量注册|绕过|破解|刷量|外挂/, '这类需求超出本系统的能力与合规边界，我不能协助。'],
  [
    /几个人|多少人|在室|签到|签退|谁在|补签/,
    '在室人数、签到记录属于记录类数据，签到办理（含异常申诉）尚未接入（没有数据来源），我无法提供，也不能估计。'
  ],
  [/换班|排班|排值班|值班表|排岗/, '值班编排与换班（F05）尚未接入：沙盒只有"开始值班/收尾交接"。'],
  [/课表导入|导入课表|调课|代课|换教室/, '指定日期调课已在原系统业务工作台提供：先连接原系统账号，再比较候选并人工确认。对话演示引擎不会直接修改课表。'],
  [/预约|借用|申请用房|订房间|包场/, '临时用房申请与审批（F09）尚未接入，"课表空闲"不等于"可以预约"。'],
  [/积分|补记分|加分明细/, '积分核对与补记（F11）尚未接入。'],
  [/白名单|导入名单|导入学生|批量导入人员/, '人员导入预审（F12）尚未接入。'],
  [/故障|怎么用|怎么办|规定|制度|手册|坏了[^。]{0,6}(怎么办|如何处理)/, '知识库问答（RAG）不在本阶段范围内，尚未接入，所以我无法给出制度或手册类回答。'],
  [/钥匙(在|去哪|在哪|在谁|是谁)|门禁/, '钥匙台账与交接（F07）尚未接入，我无法查询钥匙位置。'],
  [/去年|历史|平均使用率|趋势|统计[^。]{0,4}报表/, '本系统只覆盖当前学期的课表数据，不含历史统计，我无法给出这类数字。']
];

/** 「哪些房间空着/找空教室」类问题：不需要房间号（导出供 run.ts 做继承判定） */
export const FREE_ROOMS_RE = /哪些.{0,6}(空|闲)|空(着|的|教室|实验室|房间)|空闲|没(有)?被占用|可以(用|借)/;
/** 房间档案/状态类问题：需要房间号，且在问开放/容量/状态等 */
export const LAB_STATUS_RE = /开放吗|开(着|放)吗|还开|状态|容量|多大|能坐|位置|在哪|什么情况|简介|介绍|下一?节/;
/** 纯寒暄/致谢（导出供 run.ts 做继承判定） */
export const SMALLTALK_RE = /^(谢谢|多谢|感谢|辛苦了|辛苦|好的|好|嗯+|噢|哦|ok|OK|Ok|收到|明白|了解了|你好|您好|嗨|hi|hello|哈喽)[！!。.~，,～\s]*$/;

export function planDemo(question: string, intent: Intent, ds: Dataset): DemoPlan {
  const q = String(question ?? '');
  if(/制度|规程|手册|怎么用|操作说明|时间窗口/.test(q)) return {tool:'query_knowledge',callTool:true,args:{query:q},directReply:null,needsDisclosure:[]};
  if(/下次值班|下一次值班|正式排班|我的班次/.test(q)) return {tool:'query_duty_context',callTool:true,args:{},directReply:null,needsDisclosure:[]};

  // F13：寒暄/确认类输入直接回应，不查任何数据、不沿用任何条件
  if (SMALLTALK_RE.test(q.trim())) {
    return {
      tool: '',
      callTool: false,
      args: {},
      directReply: '不客气！有实验室查询需要随时说，例如「E310 2026-09-30 有哪些课？」。',
      needsDisclosure: []
    };
  }

  // F10：显式非法日期必须报错，绝不静默回落到今天或沿用上一问
  if (intent.dateInvalid) {
    return {
      tool: '',
      callTool: false,
      args: {},
      directReply: `日期输入有误：${intent.dateInvalid.reason}。合法示例：2026-09-30、9月30日、下周三。`,
      needsDisclosure: ['未查询任何数据（日期非法）']
    };
  }

  for (const [re, reply] of OUT_OF_SCOPE_PATTERNS) {
    if (re.test(q)) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply: reply,
        needsDisclosure: ['本回答由服务端规则引擎给出，未调用大模型，也未查询数据']
      };
    }
  }

  // ---- ops.v1（阶段 2B）：业务办理路由 —— 只生成办理单，执行必须经提案卡确认 ----
  const opsPlan = planOpsDemo(q, intent, ds);
  if (opsPlan) return opsPlan;

  // ---- 找空房间：不要求房间号，也不继承单房间条件（F13/F16 范围语义）----
  if (FREE_ROOMS_RE.test(q)) {
    const disclosures = intent.date ? [] : ['你没有说明日期，我按服务端当天处理'];
    for (const n of intent.notes) if (n.includes('沿用')) disclosures.push(n);
    if (intent.periodKeys) disclosures.push(`时间范围：${intent.periodKeys.join('、')}（未指定单一节次）`);
    return {
      tool: 'query_free_rooms',
      callTool: true,
      args: {
        ...(intent.date ? { date: intent.date.date } : {}),
        ...(intent.periodKey ? { periodKey: intent.periodKey } : {}),
        ...(intent.periodKeys ? { periodKeys: intent.periodKeys } : {})
      },
      directReply: null,
      needsDisclosure: disclosures
    };
  }

  // ---- N08：追问"那 E312 呢"仅替换房间，保留上一问的任务类型 ----
  const isFollowUp = /^(那|换|再问|还有)?\s*.{0,12}(呢|呢？|怎么样|如何)\s*[？?！!。.]*$/.test(q.trim()) && Boolean(intent.labName);
  const defaultTool = isFollowUp && intent.lastTask === 'lab_status' ? 'query_lab_status' : 'query_schedule';

  // ---- 房间档案/状态：要求房间号 ----
  if (intent.labName && LAB_STATUS_RE.test(q)) {
    const disclosures = intent.date ? [] : ['你没有说明日期，我按服务端当天处理'];
    for (const n of intent.notes) if (n.includes('沿用')) disclosures.push(n);
    return {
      tool: 'query_lab_status',
      callTool: true,
      args: {
        labName: intent.labName,
        ...(intent.date ? { date: intent.date.date } : {})
      },
      directReply: null,
      needsDisclosure: disclosures
    };
  }

  if (!intent.labName) {
    return {
      tool: '',
      callTool: false,
      args: {},
      directReply:
        '我没有识别到房间号。请把问题写得具体一点，例如「E310 2026-09-30 有哪些课？」或「明天下午哪些实验室空着？」。' +
        `系统当前收录的房间号有：${[...ds.labs, ...ds.openLabs].map((l) => l.name).join('、')}。`,
      needsDisclosure: ['未识别到房间号（查课表必须给出房间号；找空房间可以不带）']
    };
  }

  // ---- 默认：查课表 ----
  const disclosures = intent.date ? [] : ['你没有说明日期，我按服务端当天处理'];
  for (const n of intent.notes) if (n.includes('沿用')) disclosures.push(n);
  if (defaultTool === 'query_lab_status') {
    return {
      tool: 'query_lab_status',
      callTool: true,
      args: {
        labName: intent.labName,
        ...(intent.date ? { date: intent.date.date } : {})
      },
      directReply: null,
      needsDisclosure: disclosures
    };
  }
  return {
    tool: 'query_schedule',
    callTool: true,
    args: {
      // 没识别到日期时不猜：交给工具用服务端当天，并在回答里显式声明这是缺省值
      ...(intent.date ? { date: intent.date.date } : {}),
      labName: intent.labName!,
      ...(intent.periodKey ? { periodKey: intent.periodKey } : {})
    } satisfies QueryScheduleArgs,
    directReply: null,
    needsDisclosure: disclosures
  };
}

// ===========================================================================
//  ops.v1 业务办理路由（阶段 2B）—— 规则解析，只产出 prepare 工具调用
// ============================================================================
//  纪律：路由只负责"选工具 + 收敛参数"；用户原话作为事实描述原样传递，
//  绝不代用户虚构内容（如通知正文、检查项状态）。缺关键条件就明确追问。
// ===========================================================================

const DUTY_CHECKLIST_KEYS = ['power', 'lights', 'doors', 'keys', 'todo'] as const;

/** 从用户原话推断报修分类（确定性规则，不猜） */
function inferIssueCategory(q: string): string {
  if (/网络|网线|wi-?fi|断网|上不了网/i.test(q)) return 'network';
  if (/卫生|打扫|垃圾|脏|清洁|消毒/.test(q)) return 'environment';
  if (/灯|照明|门窗|门锁|窗户|锁/.test(q)) return 'door_window_lighting';
  if (/投影|电脑|设备|机器|空调|电源|打印机|座椅|多媒体|开不了机|无法开机|黑屏|没有信号|漏水|损坏/.test(q)) return 'equipment';
  return 'other';
}

/** 从用户陈述推断交接清单状态：提到的按陈述定，没提到的一律 unchecked（绝不代勾） */
function buildChecklistFromText(q: string, note: string): Array<{ key: string; label: string; state: 'done' | 'abnormal' | 'unchecked' }> {
  const labels: Record<(typeof DUTY_CHECKLIST_KEYS)[number], string> = {
    power: '关闭电源与设备',
    lights: '关灯',
    doors: '锁好门窗',
    keys: '钥匙交接',
    todo: '未完事项已记录并交接'
  };
  const stateOf = (key: (typeof DUTY_CHECKLIST_KEYS)[number]): 'done' | 'abnormal' | 'unchecked' => {
    switch (key) {
      case 'power':
        if (/没断电|没关电源|设备没关|没关设备/.test(q)) return 'abnormal';
        if (/断电|关电源|关(了)?设备|设备已关/.test(q)) return 'done';
        return 'unchecked';
      case 'lights':
        if (/没关灯|灯没关/.test(q)) return 'abnormal';
        if (/关灯|灯已关/.test(q)) return 'done';
        return 'unchecked';
      case 'doors':
        if (/没锁|未锁|门窗没关/.test(q)) return 'abnormal';
        if (/锁(好|了)?(门|窗)|已锁|门窗已关/.test(q)) return 'done';
        return 'unchecked';
      case 'keys':
        if (/钥匙没(有)?交|没(有)?交钥匙|钥匙未交|钥匙还没|还没交钥匙/.test(q)) return 'abnormal';
        if (/钥匙已(经)?交|交了钥匙|钥匙已(经)?还|归还钥匙|已还钥匙/.test(q)) return 'done';
        return 'unchecked';
      case 'todo':
        if (/没记|未记录/.test(q)) return 'abnormal';
        if (note.trim().length > 0) return 'done';
        return 'unchecked';
    }
  };
  return DUTY_CHECKLIST_KEYS.map((key) => ({ key, label: labels[key], state: stateOf(key) }));
}

function opsDisclosure(): string[] {
  return ['业务办理路由由服务端规则给出；办理单只在沙盒执行，需你在提案卡确认'];
}

function planOpsDemo(q: string, intent: Intent, ds: Dataset): DemoPlan | null {
  // ---- F06 值班开始 / 收尾交接 ----
  if (/开始值班|开始.{0,12}值班|值个班|值班开始/.test(q)) {
    if (!intent.labName) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply: '开始值班需要说明房间号，例如「开始今天在 D526 的值班」。',
        needsDisclosure: opsDisclosure()
      };
    }
    return {
      tool: 'prepare_duty_session',
      callTool: true,
      args: { mode: 'start', roomId: intent.labName },
      directReply: null,
      needsDisclosure: opsDisclosure()
    };
  }
  if (/结束值班|值班交接|交接班|收尾|下班前/.test(q)) {
    const note = q;
    return {
      tool: 'prepare_duty_session',
      callTool: true,
      args: {
        mode: 'handover',
        checklist: buildChecklistFromText(q, note),
        note
      },
      directReply: null,
      needsDisclosure: [
        ...opsDisclosure(),
        '检查清单按你的陈述预填：提到的项按陈述标记，没提到的保持「未确认」——确认前可在提案卡逐项修改'
      ]
    };
  }

  // ---- F02 临时停用 ----
  if (intent.labName && /(停用|封闭|暂停开放|暂停使用)/.test(q)) {
    if (!intent.date) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply: `登记 ${intent.labName} 停用需要明确日期与节次，例如「${intent.labName} 9月30日下午停用检修」。`,
        needsDisclosure: opsDisclosure()
      };
    }
    const periodKeys = intent.periodKeys ?? (intent.periodKey ? [intent.periodKey] : null);
    if (!periodKeys || !periodKeys.length) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply: `请说明 ${intent.date.date} 停用哪些节次（如「下午」「全天」），我再生成停用办理单。`,
        needsDisclosure: opsDisclosure()
      };
    }
    const reasonM = /(?:原因[:：])?\s*(检修|维修|维护|装修|清洁|消毒)[^，。；]*/.exec(q);
    return {
      tool: 'prepare_room_closure',
      callTool: true,
      args: {
        roomId: intent.labName,
        startDate: intent.date.date,
        endDate: intent.date.date,
        periodKeys,
        reason: reasonM ? reasonM[1] : '检修',
        createIssue: true,
        prepareNotice: /通知|告知|班级/.test(q)
      },
      directReply: null,
      needsDisclosure: opsDisclosure()
    };
  }

  // ---- F01 报修 ----
  const issueIntent =
    /(报修|报障|建单|创建工单|提交工单|工单|维修单|登记问题|登记故障)/.test(q) ||
    (intent.labName && /(坏了|故障|没有信号|开不了机|无法开机|黑屏|漏水|损坏|需要检修|要检修)/.test(q));
  if (issueIntent) {
    if (!intent.labName) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply:
          '报修需要说明房间号，例如「E310 投影没有信号，帮我报修」。系统当前收录的房间号有：' +
          [...ds.labs, ...ds.openLabs].map((l) => l.name).join('、') +
          '。',
        needsDisclosure: opsDisclosure()
      };
    }
    return {
      tool: 'prepare_issue_ticket',
      callTool: true,
      args: {
        roomId: intent.labName,
        category: inferIssueCategory(q),
        description: q
      },
      directReply: null,
      needsDisclosure: opsDisclosure()
    };
  }

  // ---- F03 站内通知 ----
  if (/通知|公告|发布/.test(q)) {
    const titleM = /《(.+?)》/.exec(q);
    if (!titleM) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply:
          '发布通知需要标题与正文。请用这样的格式：发布通知《标题》：正文内容，发给……（接收范围可以是"全部学生/全部志愿者/全体"或具体班级名）。',
        needsDisclosure: opsDisclosure()
      };
    }
    const title = titleM[1]!;
    const content = q.slice((titleM.index ?? 0) + titleM[0].length).replace(/^[:：\s]+/, '').trim();
    if (!content) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply: `通知《${title}》还缺正文。请补充内容，例如：《${title}》：请各位同学……`,
        needsDisclosure: opsDisclosure()
      };
    }
    // 受众解析：先看明示分组，再看具体班级，最后尝试按"房间+日期"的上课班级推算
    let audience: Record<string, unknown> | null = null;
    if (/全体|所有人|所有用户/.test(q)) audience = { kind: 'all' };
    else if (/全部?学生|所有学生/.test(q)) audience = { kind: 'role_scope', role: 'student' };
    else if (/全部?志愿者|所有志愿者/.test(q)) audience = { kind: 'role_scope', role: 'volunteer' };
    if (!audience) {
      const known = [...new Set(ds.timetable.map((r) => r.className))];
      const hit = known.filter((c) => q.includes(c)).slice(0, 20);
      if (hit.length) audience = { kind: 'class_ids', classIds: hit };
    }
    if (!audience && intent.labName && intent.date) {
      const hit = [...new Set(
        ds.timetable
          .filter((r) => r.labName === intent.labName && r.weekday === weekdayOf(intent.date!.date))
          .flatMap((r) => r.classNames)
      )];
      if (hit.length) audience = { kind: 'class_ids', classIds: hit };
    }
    if (!audience) {
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply: `通知《${title}》还需要接收范围。请说明发给谁（如"发给全部学生""发给 XXX 班"），或先查该房间当天的课表再说"通知相关班级"。`,
        needsDisclosure: opsDisclosure()
      };
    }
    return {
      tool: 'prepare_notification',
      callTool: true,
      args: {
        title,
        content,
        audience,
        level: /紧急|急|立即/.test(q) ? 'urgent' : /警告|注意/.test(q) ? 'warning' : 'info'
      },
      directReply: null,
      needsDisclosure: opsDisclosure()
    };
  }

  // ---- F10 运营日报 ----
  if (/日报|运营报告|运营情况|生成报告|总结报告|运营简报/.test(q)) {
    return {
      tool: 'create_operations_report',
      callTool: true,
      args: {
        ...(intent.date ? { startDate: intent.date.date, endDate: intent.date.date } : {})
      },
      directReply: null,
      needsDisclosure: [...opsDisclosure(), '统计只覆盖沙盒业务数据与课表快照；缺数据源的指标会如实标"未知"']
    };
  }

  return null;
}

/** 规则引擎执行工具（与 Agnes 引擎共用同一份注册表实现；ops.v1 起为异步并携带身份） */
export async function runDemoTool(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  return executeTool(tool, args, ctx);
}

/** 把结构化结果渲染成可读回答（不调用模型）。**结论式短文案**：明细指向结构化结果卡，不逐条重复 */
export function renderDemoAnswer(
  result: ScheduleQueryResult | { kind: ToolResultKind; payload: unknown },
  extras: { dateWasDefaulted: boolean; periodFiltered: boolean; textOnly?:boolean; scopeLabel?:string }
): string {
  if(extras.textOnly){
    const kind='kind' in result?result.kind:'schedule',raw=('kind' in result?result.payload:result) as {provenance?:{queryTime?:string;sourceRevision?:string;sourceSha256Prefix?:string;coverage?:string}};
    const base=renderDemoAnswer(result,{...extras,textOnly:false}).replace(/；逐节明细见下方课表卡。/g,'。').replace(/明细见下方结果卡。/g,'');
    if(kind==='business_plan')return base;
    const lines=[base];
    if(kind==='schedule')for(const r of (raw as ScheduleQueryResult).lessons)lines.push(`• ${r.startTime}—${r.endTime} ${r.periodLabel}｜${r.courseName}｜${r.labName}｜班级 ${(r.classNames?.length?r.classNames:[r.className]).join('、')||'未知'}｜教师 ${r.teacher||'未录入'}｜编号 ${r.timetableId}`);
    lines.push(`查询时间：${raw.provenance?.queryTime||'未提供'}；范围：${extras.scopeLabel||'当前账号授权范围'}；数据版本：${raw.provenance?.sourceRevision||raw.provenance?.sourceSha256Prefix||'未提供'}；覆盖：${raw.provenance?.coverage||'见上述查询说明'}。`);
    return lines.join('\n');
  }
  if ('kind' in result) {
    if (result.kind === 'knowledge') { const r=result.payload as KnowledgeResult; return r.summary+'\n'+r.scope+'\n'+r.hits.map(h=>h.title+'（v'+h.version+'）\n'+h.paragraphs.map(p=>p.locator+' '+p.text).join('\n')).join('\n\n'); }
    if (result.kind === 'business_plan') return renderBusinessFacts(result.payload as BusinessPlanResult);
    if (result.kind === 'lab_status') return renderLabStatusAnswer(result.payload as LabStatusResult);
    if (result.kind === 'free_rooms') return renderFreeRoomsAnswer(result.payload as FreeRoomsResult);
    if (result.kind === 'operation_proposal') return renderProposalAnswer(result.payload as Proposal);
    if (result.kind === 'operations_report') return renderReportAnswer(result.payload as OperationsReportResult);
    return renderScheduleAnswer(result.payload as ScheduleQueryResult, extras);
  }
  return renderScheduleAnswer(result, extras);
}

function renderProposalAnswer(p: Proposal): string {
  const lines: string[] = [];
  lines.push(`已生成办理单《${p.title}》，等待你确认：`);
  lines.push(`· ${p.summary}`);
  if (p.effects.length) {
    lines.push(`· 提交后将执行 ${p.effects.length} 项变更：${p.effects.map((e) => e.label).join('；')}`);
  }
  for (const dep of p.missingDependencies) lines.push(`· 未接入：${dep}`);
  if (p.canExecute) {
    lines.push('请在下方提案卡核对后点击「确认执行」。确认后返回业务单号与回执；也可以直接拒绝或放弃。');
  } else {
    lines.push(`⚠️ 当前演示身份无权执行：${p.cannotExecuteReason ?? '权限不足'}。可在左侧切换演示视角后重新发起。`);
  }
  lines.push('（执行环境：沙盒演示，不产生真实业务影响；单号与回执以提案卡为准，聊天文字不是凭据。）');
  return lines.join('\n');
}

function renderReportAnswer(r: OperationsReportResult): string {
  const lines: string[] = [];
  lines.push(
    `运营日报草稿（${r.range.startDate}${r.range.startDate !== r.range.endDate ? ` ~ ${r.range.endDate}` : ''}）：`
  );
  for (const m of r.metrics) {
    lines.push(
      m.status === 'known'
        ? `· ${m.label}：${m.value} ${m.unit}`
        : `· ${m.label}：未知 —— ${m.note}`
    );
  }
  lines.push('报告为草稿产物，仅当前用户可见，未自动发布；明细见下方报告卡。');
  return lines.join('\n');
}

function renderScheduleAnswer(
  result: ScheduleQueryResult,
  extras: { dateWasDefaulted: boolean; periodFiltered: boolean }
): string {
  const weekText =
    result.weekNo === null ? '教学周无法确定' : `第 ${result.weekNo} 教学周（${result.weekNo % 2 === 1 ? '单周' : '双周'}）`;
  const head = `${result.labName ?? '该房间'}（${result.labLocation ?? '位置未录入'}）${result.date} ${result.weekdayLabel}，${weekText}`;

  if (result.reason === 'lab_not_found') {
    return `系统里没有收录这个房间号，所以查不到课表。可选的房间号：${result.suggestions.join('、') || '（当前未收录任何房间）'}。`;
  }
  if (result.lessons.length === 0) {
    // F09：timetable_empty 是数据问题，不能先给"没有课"的确定结论
    if (result.reason === 'timetable_empty') {
      return `${head}无法判断是否有课：系统内课表数据为空。本结果不构成"该房间没课"的结论。`;
    }
    const why =
      result.reason === 'no_class_in_that_period'
        ? '该节次没有课'
        : result.reason === 'lab_not_active'
          ? '该房间当前状态不是「开放」，且当天没有排课'
          : '当天没有排课';
    return `${head}没有课。原因：${why}。明细见下方结果卡。`;
  }

  const lines: string[] = [];
  lines.push(
    `${head}共有 ${result.lessons.length} 条排课，从 ${result.lessons[0].startTime} 的《${result.lessons[0].courseName}》到 ${
      result.lessons[result.lessons.length - 1].endTime
    } 的《${result.lessons[result.lessons.length - 1].courseName}》。`
  );
  const byPeriod = result.byPeriod.filter((b) => b.count > 0);
  if (byPeriod.length) {
    lines.push(`占用节次：${byPeriod.map((b) => `${b.periodLabel}×${b.count}`).join('、')}；逐节明细见下方课表卡。`);
  }
  if (extras.periodFiltered) lines.push('（已按你指定的节次过滤。）');
  if (extras.dateWasDefaulted) lines.push(`（你没有说明日期，以上按服务端当天 ${result.date} 计算。）`);

  // 条件说明必须原样带出去，不能只在界面角落里显示
  for (const n of result.notes) lines.push(`— ${n}`);
  lines.push(`数据来源：${result.provenance.sourceLabel}。${result.provenance.coverage}`);
  return lines.join('\n');
}

function renderLabStatusAnswer(r: LabStatusResult): string {
  if (r.labName === null) {
    return `系统里没有收录这个房间号。可选的房间号：${r.suggestions.join('、') || '（当前未收录任何房间）'}。`;
  }
  const lines: string[] = [];
  // F19：档案状态措辞，避免被理解为"此刻开着门"
  lines.push(
    `${r.labName}（${r.labLocation ?? '位置未录入'}）档案状态「${r.statusLabel}」，容量 ${r.capacity ?? '未知'} 人。${r.date}（${r.weekdayLabel}）有 ${r.schedule.lessonCount} 条排课。`
  );
  if (r.schedule.nextLesson) {
    lines.push(`下一节是 ${r.schedule.nextLesson.startTime} 的《${r.schedule.nextLesson.courseName}》（${r.schedule.nextLesson.periodLabel}）。`);
  } else if (r.schedule.nextLessonReason === 'not_applicable') {
    lines.push('（「下一节课」仅对当天提供；你查的是其他日期，请看当天排课明细。）');
  } else if (r.schedule.nextLessonReason === 'no_more_today') {
    lines.push('当天剩余时间没有更多排课。');
  }
  lines.push('在室人数：未知 —— 系统没有签到/门禁数据来源，无法提供，请勿据此判断房间内是否有人。');
  return lines.join('\n');
}

function renderFreeRoomsAnswer(r: FreeRoomsResult): string {
  const lines: string[] = [];
  // F09：数据覆盖不足时禁止输出确定空闲名单
  if (r.coverage === 'missing') {
    lines.push(`无法判断 ${r.date}（${r.weekdayLabel}）哪些房间空闲：系统内课表数据为空，"没有记录"不能当成"没有课"。`);
    lines.push('请先导入课表数据后再使用找空闲房间功能。');
    return lines.join('\n');
  }
  const scope = r.periodFilter
    ? `${r.freeByPeriod[0].periodLabel}（${r.freeByPeriod[0].startTime}-${r.freeByPeriod[0].endTime}）`
    : r.periodKeys.length && r.periodKeys.length < 6
      ? r.freeByPeriod.map((p) => p.periodLabel).join('、')
      : '全天各节次';
  lines.push(`${r.date}（${r.weekdayLabel}）${scope}——只统计档案状态为「开放」的房间：`);
  for (const p of r.freeByPeriod) {
    lines.push(
      `· ${p.periodLabel}：${p.rooms.length ? p.rooms.map((x) => x.labName).join('、') : '无空闲房间'}`
    );
  }
  if (r.excluded.length) {
    lines.push(`已排除（档案非开放，不宜推荐借用，课表未必不空）：${r.excluded.map((x) => `${x.labName}（${x.reason}）`).join('、')}`);
  }
  lines.push('说明：「空闲」指课表上无排课，不代表室内无人，也不代表可以预约借用。');
  return lines.join('\n');
}
