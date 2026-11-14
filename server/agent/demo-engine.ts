import {renderBusinessFacts} from '../business/fact-text.ts';
import type { KnowledgeResult, EvidenceObservationResult } from '../../shared/types.ts';
import type { TermScheduleResult } from '../tools/query-term-schedule.ts';
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

import type { CheckinStatusResult, CheckinSummaryResult, FreeRoomsResult, LabStatusResult, OperationsReportResult, QueryScheduleArgs, ScheduleQueryResult, VisionFieldResult } from '../../shared/types.ts';
import type { Proposal } from '../../shared/operations-contract.ts';
import type { Dataset } from '../data/store.ts';
import { weekdayOf } from '../time/term.ts';
import type { Intent } from './intent.ts';
import { executeTool } from '../tools/registry.ts';
import type { ToolContext, ToolExecution } from '../tools/registry.ts';
import { isBusinessConnected } from '../business/bridge.ts';
import { PERSONAL_CHECKIN_RE } from '../tools/query-checkin-status.ts';
import { CHECKIN_SUMMARY_RE } from '../tools/query-checkin-summary.ts';

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
  [/换班|排班|排值班|值班表|排岗/, '值班编排与换班（F05）尚未接入：沙盒只有"开始值班/收尾交接"。'],
  [/课表导入|导入课表|调课|代课|换教室/, '指定日期调课已在原系统业务工作台提供：先连接原系统账号，再比较候选并人工确认。对话演示引擎不会直接修改课表。'],
  [/预约|借用|申请用房|订房间|包场/, '临时用房申请与审批（F09）尚未接入，"课表空闲"不等于"可以预约"。'],
  [/积分|补记分|加分明细/, '积分核对与补记（F11）尚未接入。'],
  [/白名单|导入名单|导入学生|批量导入人员/, '人员导入预审（F12）尚未接入。'],
  [/故障|怎么用|怎么办|规定|制度|手册|坏了[^。]{0,6}(怎么办|如何处理)/, '知识库问答（RAG）不在本阶段范围内，尚未接入，所以我无法给出制度或手册类回答。'],
  [/门禁/, '未接入门禁传感器。可查询人员开放登记与钥匙台账，不能据此判断实时门禁状态。'],
  [/去年|历史|平均使用率|趋势|统计[^。]{0,4}报表/, '本系统只覆盖当前学期的课表数据，不含历史统计，我无法给出这类数字。']
];

// ---- 在室人数 vs 签到明细 vs 本人签到状态：三者数据可得性完全不同，不能混成一条拒绝文案 ----
//  在室人数：主系统 /occupancy 提供"上海当日同房间、同主体逐条配对的未结束有效签到记录"的房间级计数（与主系统页面同源），
//           业务通道连通时**可以给真实数字**；此前被这条兜底规则一律拦成"无法提供"，是错的。
//  本人签到状态：2026-11-06 批次1 起开放（/api/integration/checkin-status，只回本人记录）——连通后可查，未连通时如实说取不到。
//  他人签到明细：逐人签到/签退/补签明细没有对 LabOps 开放的接口，仍然如实说不可得。
const OCCUPANCY_RE = /在室|几个人|多少人|谁在|签到(人数|情况|统计)|签退(人数|情况|统计)/;
const CHECKIN_DETAIL_RE = /签到|签退|补签/;

/** 「在室人数」类问题的兜底回答：只有在取不到房间号或未连通业务通道时才说"无法提供" */
function occupancyFallback(reason: 'no_room' | 'no_channel', ds: Dataset): string {
  if (reason === 'no_room') {
    return '请告诉我是哪个房间，例如「E310 现在有多少人？」。在室人数按原系统上海当日同房间、同主体逐条配对的未结束有效签到记录统计，与主系统页面同源；' +
      `逐人签到明细没有开放接口，仍然查不到。当前收录的房间号有：${[...ds.labs, ...ds.openLabs].map((l) => l.name).join('、')}。`;
  }
  return '现在没有连接原系统账号，取不到签到数据，所以我给不出在室人数，也不会估计。' +
    '连接原系统账号后可以按「上海当日同房间、同主体逐条配对的未结束有效签到记录」给出房间人数（与主系统页面同源）；逐人签到明细没有开放接口。';
}

/** 「哪些房间空着/找空教室」类问题：不需要房间号（导出供 run.ts 做继承判定） */
export const FREE_ROOMS_RE = /哪些.{0,6}(空|闲)|空(着|的|教室|实验室|房间)|空闲|没(有)?被占用|可以(用|借)/;
/** 房间档案/状态类问题：需要房间号，且在问开放/容量/状态/在室人数等。
 *  A7：补"有人/空吗/在吗"等口语问法——"310有人吗"与"E310 在室几个人"同义。 */
export const LAB_STATUS_RE = /开放吗|开(着|放)吗|还开|状态|容量|多大|能坐|位置|在哪|什么情况|简介|介绍|下一?节|在室|几个人|多少人|谁在|钥匙|(?:有(?:没有)?)人|空吗|空着吗|在吗/;
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

  // 在室人数 / 签到明细 / 本人签到状态：先于通用越界规则判断（三者数据可得性不同，见上方常量注释）
  const wantsOccupancy = OCCUPANCY_RE.test(q);
  if (wantsOccupancy || CHECKIN_DETAIL_RE.test(q)) {
    const disclosure = ['本回答由服务端规则引擎给出，未调用大模型'];
    if (!wantsOccupancy) {
      // 「我签到了吗」类本人状态问法：批次1 已开放本人状态接口，未连通时如实说取不到，不再伪装成"无接口"
      if (PERSONAL_CHECKIN_RE.test(q)) {
        return {
          tool: '',
          callTool: false,
          args: {},
          directReply:
            '现在没有连接原系统账号，取不到本人签到状态，也不会估计。' +
            '连接原系统账号后可以查询本人当日课程位置与签到/签退状态（签到须本人在实验室现场完成，Agent 不代签）；' +
            '他人的逐人签到明细仍然没有对 LabOps 开放的接口。',
          needsDisclosure: disclosure
        };
      }
      return {
        tool: '',
        callTool: false,
        args: {},
        directReply:
          '逐人签到/签退/补签明细没有对 LabOps 开放的接口，我查不到（签到办理与异常申诉也尚未接入）。' +
          '本人当日签到状态在连接原系统账号后可以查；房间在室人数也可以查，例如「E310 现在有多少人？」' +
          '——口径是上海当日同房间、同主体逐条配对的未结束有效签到记录，与主系统页面同源。',
        needsDisclosure: disclosure
      };
    }
    if (!isBusinessConnected()) {
      if (CHECKIN_SUMMARY_RE.test(q)) {
        return {
          tool: '',
          callTool: false,
          args: {},
          directReply:
            '现在没有连接原系统账号，取不到签到汇总，也不会估计。' +
            '连接后管理员可按日期、实验室与节次查询应到/实到/缺口与未签到学号名单（仅管理员可查，缺口需现场核实，请勿代替学生签到）；' +
            '房间在室人数同样需要连接后才能给出真实数字。',
          needsDisclosure: [...disclosure, '未查询任何数据（业务通道未连接）']
        };
      }
      return { tool: '', callTool: false, args: {}, directReply: occupancyFallback('no_channel', ds), needsDisclosure: [...disclosure, '未查询任何数据（业务通道未连接）'] };
    }
    if (!intent.labName) {
      return { tool: '', callTool: false, args: {}, directReply: occupancyFallback('no_room', ds), needsDisclosure: [...disclosure, '未查询任何数据（缺少房间号）'] };
    }
    // 有房间号且已连通：照常查房间状态，在室人数取自主系统 /occupancy
    return {
      tool: 'query_lab_status',
      callTool: true,
      args: { labName: intent.labName, ...(intent.date ? { date: intent.date.date } : {}) },
      directReply: null,
      needsDisclosure: intent.date ? [] : ['你没有说明日期，我按服务端当天处理']
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

  // ---- F02b 开门/关门（即时开放状态，区别于长周期停用）----
  if (intent.labName && /(开门|关门|打开|关闭|关着|开着)/.test(q)) {
    const closed = /(关门|关闭|把门关上|关着)/.test(q);
    return {
      tool: 'prepare_room_status',
      callTool: true,
      args: { roomId: intent.labName, status: closed ? 'closed' : 'active' },
      directReply: null,
      needsDisclosure: opsDisclosure()
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

type SuccessfulToolExecution = Extract<ToolExecution, { ok: true }>;
type SuccessfulResultKind = SuccessfulToolExecution['resultKind'];
type ResultPayload<K extends SuccessfulResultKind> = Extract<SuccessfulToolExecution, { resultKind: K }>['result'];
type DemoRenderExtras = { dateWasDefaulted: boolean; periodFiltered: boolean; textOnly?: boolean; scopeLabel?: string; question?: string; today?: string };
type DemoRendererMap = {
  [K in SuccessfulResultKind]: (payload: ResultPayload<K>, extras: DemoRenderExtras) => string;
};

/** 实际分派表：新增成功 kind 或改动其载荷类型时，必须同步提供对应渲染器。 */
export const DEMO_RESULT_RENDERERS: DemoRendererMap = {
  schedule: renderScheduleAnswer,
  lab_status: renderLabStatusAnswer,
  free_rooms: renderFreeRoomsAnswer,
  operation_proposal: renderProposalAnswer,
  operations_report: renderReportAnswer,
  knowledge: renderKnowledgeAnswer,
  business_plan: renderBusinessFacts,
  evidence_observation: renderEvidenceObservationAnswer,
  checkin_status: renderCheckinStatusAnswer,
  checkin_summary: renderCheckinSummaryAnswer,
  vision_field: renderVisionFieldAnswer,
  task_plan: renderTaskPlanAnswer,
  // 注册表此项仍为 Record<string, unknown>，具体契约取自工具定义。
  term_schedule: (payload, extras) => renderTermScheduleAnswer(payload as unknown as TermScheduleResult, extras),
  term_schedule_applied: renderTermScheduleAppliedAnswer,
  records: renderRecordsAnswer
};

/** 把结构化结果渲染成可读回答（不调用模型）；未知类型只显示摘要，不猜测载荷结构。 */
export function renderDemoAnswer(
  result: ScheduleQueryResult | { kind: string; payload: unknown; summary?: string },
  extras: DemoRenderExtras
): string {
  const kind = 'kind' in result ? result.kind : 'schedule';
  const payload = 'kind' in result ? result.payload : result;
  // 不用 in：constructor / toString / __proto__ 等原型属性不是渲染器。
  if (!Object.hasOwn(DEMO_RESULT_RENDERERS, kind)) {
    const summary = 'summary' in result && typeof result.summary === 'string' ? result.summary.trim() : '';
    return ['暂无专用呈现。', summary].filter(Boolean).join('\n');
  }
  // 外部兼容入口允许 unknown；只在已确认 kind 存在的边界做一次类型擦除。
  const renderer = DEMO_RESULT_RENDERERS[kind as SuccessfulResultKind] as (payload: unknown, extras: DemoRenderExtras) => string;
  const base = renderer(payload, extras);
  if (!extras.textOnly) return base;
  const lines = [base.replace(/；?逐节明细见下方课表卡。?/g, '').replace(/明细见下方结果卡。?/g, '')];
  // A8：聊天模式无结果卡 → 正文承担逐节明细；其他 kind 由其专用渲染器呈现。
  if (kind === 'schedule') {
    for (const r of (payload as ScheduleQueryResult).lessons) {
      lines.push(`- ${r.startTime}—${r.endTime} ${r.periodLabel}｜${r.courseName}｜${r.labName}｜班级 ${(r.classNames?.length ? r.classNames : [r.className]).join('、') || '未知'}｜教师 ${r.teacher || '未录入'}｜编号 ${r.timetableId}`);
    }
  }
  return lines.join('\n');
}

function renderKnowledgeAnswer(r: KnowledgeResult): string {
  // 引用脚注 [n] 按最终顺序分配，每个可引用段落一条。
  const lines = [r.summary, r.scope];
  let n = 0;
  for (const h of r.hits) for (const p of h.paragraphs) {
    n += 1;
    lines.push(`- **[${n}] ${h.title}（v${h.version}）· ${p.locator}**：${p.text}`);
  }
  if (!n) lines.push('（本次检索没有可引用的段落——知识库未命中，不作答制度细节。）');
  return lines.join('\n');
}

function renderEvidenceObservationAnswer(r: EvidenceObservationResult): string {
  const o = r.observation;
  const severity: Record<typeof o.severityGuess, string> = { unknown: '无法初判', minor: '轻微', moderate: '中等', severe: '严重' };
  const lines = [
    '**证据照片 · AI 视觉初判（非人工验收）**',
    `- 设备类型：${o.deviceType || '无法确认'}`,
    `- 严重度初判：${severity[o.severityGuess]}；置信度 ${Math.round(o.confidence * 100)}%`,
    `- 铭牌可见文字：${o.nameplateText || '无法确认'}`,
    `- 可见征象：${o.visibleSymptoms.join('；') || '画面中没有可确认的异常征象'}`,
    `- 画面无法确认：${o.whatNotVisible.join('；') || '模型未列出盲区，请人工复核'}`
  ];
  if (r.attachments.length) lines.push(`- 分析附件：${r.attachments.map((a) => a.fileName).join('、')}`);
  if (r.skipped?.length) lines.push(`- 未分析的附件：${r.skipped.join('；')}`);
  if (r.scope) lines.push(r.scope);
  lines.push('（仅为照片观察，不替代现场检查，不能证明设备已修复或通过验收。）');
  return lines.join('\n');
}

function renderTaskPlanAnswer(r: ResultPayload<'task_plan'>): string {
  const status: Record<ResultPayload<'task_plan'>['steps'][number]['status'], string> = { pending: '待办', done: '已完成', dropped: '已放弃' };
  const lines = [`**任务计划：${r.steps.length} 步**（工作记录，不代表业务已执行）。`];
  for (const step of r.steps) lines.push(`- ${step.id}｜${status[step.status]}｜${step.text}`);
  if (!r.steps.length) lines.push('暂无计划步骤。');
  if (r.updatedAt) lines.push(`更新时间：${r.updatedAt}`);
  return lines.join('\n');
}

/**
 * 钥匙台账：只回答用户真正要的三件事——哪把钥匙、借没借出、在谁手里/在哪。
 * 内部编号、labType（student/open）、以及"借用人已掩码"这类口径说明都不进正文。
 */
function renderKeyRecordsAnswer(rows: unknown[], date: string, total: number): string {
  const scalar = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  const labelOf = (key: Record<string, unknown>): string =>
    scalar(key['name']) || `${scalar(key['labName']) || scalar(key['labId']) || '未命名'}钥匙`;
  const lineOf = (row: unknown): string => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return '记录字段不可用，无法呈现。';
    const key = row as Record<string, unknown>;
    const holder = scalar(key['holder']);
    const location = scalar(key['location']);
    const remark = scalar(key['remark']);
    const status = key['borrowed'] === true ? `已借出${holder ? `（借用人 ${holder}）` : ''}` : '未借出';
    return `${labelOf(key)}：${status}${location ? `，位置：${location}` : ''}${remark ? `，备注：${remark}` : ''}。`;
  };
  if (!rows.length) return `**${date ? date + ' ' : ''}没有查到钥匙记录。**`;
  // 一把钥匙直接给结论，不要"台账共 1 条"再列一行字段
  if (rows.length === 1) return `**${lineOf(rows[0])}**`;
  const lines = [`**${date ? date + ' ' : ''}钥匙台账：共 ${total} 条**`];
  for (const row of rows.slice(0, 30)) lines.push(`- ${lineOf(row)}`);
  if (rows.length > 30) lines.push('正文仅显示前 30 条，请缩小查询范围。');
  return lines.join('\n');
}

/** records 来自主系统三类明细接口；仅展示已知字段，身份掩码原样保留，不推断考勤。 */
function renderRecordsAnswer(r: ResultPayload<'records'>): string {
  if (r['directory'] === true) return renderDirectoryAnswer(r);
  const isKey = Array.isArray(r['keys']);
  const rows = isKey ? r['keys'] : r['records'];
  if (!Array.isArray(rows)) return '暂无可呈现的明细数据，不能据此判断没有记录。';
  const scalar = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  const date = scalar(r['date']);
  const total = typeof r['total'] === 'number' && Number.isFinite(r['total']) ? r['total'] : rows.length;
  if (isKey) return renderKeyRecordsAnswer(rows, date, total);
  const fields: Array<[string, string[]]> = [
    ['姓名', ['name']], ['账号', ['user', 'username', 'actorId']], ['时间', ['at', 'time', 'ts']],
    ['实验室', ['labName', 'labId']], ['节次', ['periodKey']], ['替班对象', ['substituteFor']]
  ];
  const lines = [`**${date ? date + ' ' : ''}签到签退明细：共 ${total} 条**${total !== rows.length ? `（本次返回 ${rows.length} 条）` : ''}。`];
  for (const row of rows.slice(0, 30)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      lines.push('- 记录字段不可用，无法呈现。');
      continue;
    }
    const values: string[] = [];
    for (const [label, keys] of fields) {
      const value = keys.map((key) => scalar(row[key])).find(Boolean);
      if (value) values.push(`${label}：${value}`);
    }
    const type = scalar(row.type);
    if (type) values.push(`类型：${type === 'checkin' ? '签到' : type === 'checkout' ? '签退' : type}`);
    const dutySource = scalar(row.dutySource);
    if (dutySource) values.push(`值班来源：${dutySource === 'roster' ? '周值班模板' : dutySource === 'substitute' ? '替班' : dutySource}`);
    if (typeof row.dutyMatched === 'boolean') values.push(`模板匹配：${row.dutyMatched ? '是' : '否'}`);
    if (scalar(row.rosterSlot)) values.push(`模板席位：${scalar(row.rosterSlot)}`);
    lines.push(`- ${values.join('｜') || '暂无可呈现的明细字段'}`);
  }
  if (!rows.length) lines.push('本次查询未返回记录，不据此推断现场状态。');
  if (rows.length > 30) lines.push('正文仅显示前 30 条，请缩小查询范围查看其余记录。');
  // 口径注释只在**本轮真的有记录**时给，且最多两句：0 条时用户只需要"没有记录"这一句，
  // 长篇隐私/口径声明是在应付审计，不是在回答用户（2026-11-14 用户明确否掉这类噪音）。
  const meta = r['meta'];
  if (rows.length && meta && typeof meta === 'object' && 'note' in meta && typeof meta.note === 'string') {
    const brief = String(meta.note).split(/[；;]/).filter(Boolean).slice(0, 2).join('；');
    if (brief) lines.push(`- ${brief}`);
  }
  return lines.join('\n');
}

/** 账号目录与名册汇总（query_user_directory）：掩码账号原样展示，名册只给班级人数 */
function renderDirectoryAnswer(r: ResultPayload<'records'>): string {
  const accounts = Array.isArray(r['accounts']) ? (r['accounts'] as Array<Record<string, unknown>>) : [];
  const roster = Array.isArray(r['roster']) ? (r['roster'] as Array<Record<string, unknown>>) : [];
  const scalar = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  const total = typeof r['total'] === 'number' && Number.isFinite(r['total']) ? r['total'] : accounts.length;
  const IDENTITY: Record<string, string> = { admin: '管理员', volunteer: '志愿者', student: '学生' };
  const STATUS: Record<string, string> = { active: '正常', disabled: '禁用', pending: '待激活', password_change_required: '需修改密码' };
  const lines = [`**账号目录：共 ${total} 个账号**（学号已由服务端掩码；电话与学院信息不在返回范围内）。`];
  for (const a of accounts.slice(0, 30)) {
    const id = IDENTITY[scalar(a['identity'])] || scalar(a['identity']) || '未知';
    const st = STATUS[scalar(a['status'])] || scalar(a['status']) || '未知';
    lines.push(`- 账号：${scalar(a['account']) || '（空）'}｜姓名：${scalar(a['name']) || '（未登记）'}｜身份：${id}｜状态：${st}`);
  }
  if (!accounts.length) lines.push('本次查询未返回账号，不据此推断系统无人。');
  if (accounts.length > 30) lines.push('正文仅显示前 30 个账号，可按身份或状态过滤查看其余。');
  if (roster.length) {
    lines.push('', `**班级名册汇总：${roster.length} 个班级**`);
    for (const c of roster.slice(0, 30)) lines.push(`- ${scalar(c['className'])}：${scalar(c['count'])} 人`);
    if (roster.length > 30) lines.push('仅显示前 30 个班级。');
  } else {
    lines.push('', '班级名册汇总为空（主系统未登记名册），不据此推断没有学生。');
  }
  const meta = r['meta'];
  if (meta && typeof meta === 'object' && 'note' in meta && typeof (meta as { note: unknown }).note === 'string') lines.push((meta as { note: string }).note);
  lines.push('（账号掩码值原样展示，不还原；目录仅陈述事实，不作人员定性。）');
  return lines.join('\n');
}

/**
 * 学期安排/值班模板（只读档案）：只读档案与课表解算无关——空数组不得说成"无课/无人"。
 *
 * 只答问到的那一半（11-11 用户实机反馈）：问「周三下午56节哪个志愿者在值班」，
 * 旧呈现把「学期安排：尚未导入」+ 整张 27 人名单 + 出处说明一起倒出来，
 * 用户要的一行被埋在无关内容里。这里按问句取要回答的面：
 *   · 只问值班 → 该节应值班的人；不附整张名单，也不提学期安排；
 *   · 问名单/多少人 → 才列名单；
 *   · 只问课/学期安排 → 只给学期安排；
 *   · 两类都问到（或都问不到，保守起见）→ 两块都给。
 * 「尚未导入」的提醒也只针对被问到的那一侧，不再顺带催另一侧。
 */

/** 从问句解析用户想要哪一天的值班（今天/明天/后天/周X/星期X）；解析不出返回 null，不猜 */
function resolveTargetWeekday(question: string, today?: string): number | null {
  const q = String(question ?? '');
  const wdOfIso = (iso?: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return ((dt.getUTCDay() + 6) % 7) + 1; // 周一=1 … 周日=7
  };
  const base = wdOfIso(today);
  if (base) {
    const shift = /今天|今日|本日/.test(q) ? 0 : /明天|明日/.test(q) ? 1 : /后天/.test(q) ? 2 : NaN;
    if (!Number.isNaN(shift)) return ((base - 1 + shift) % 7) + 1;
  }
  const m = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(q);
  if (m) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    return map[m[1]!] ?? null;
  }
  return null;
}

function renderTermScheduleAnswer(r: TermScheduleResult, extras: DemoRenderExtras): string {
  const lines: string[] = [];
  const t = r.termSchedule, v = r.volunteerSchedule;
  const q = String(extras.question ?? '');
  // 问句缺失（旧调用方/单元测试）时按完整档案呈现，不猜用户只想要哪一半
  const noQuestion = !q.trim();
  const asksDuty = noQuestion || /值班|值守|志愿者|谁在/.test(q);
  const asksTerm = noQuestion || /课|排课|学期|实验|停课|取消|档案/.test(q);
  const wantsRoster = noQuestion || /名单|哪些志愿者|几个志愿者|多少(名)?志愿者|全员/.test(q);
  const both = (asksDuty && asksTerm) || noQuestion;
  const wdOf = (n: number) => '一二三四五六日'[Math.min(6, Math.max(0, n - 1))];

  if (both || asksTerm) {
    lines.push(`**学期安排**：${t.enabled ? `已导入 · ${t.term || '（学期名未填）'}${t.weeks ? ` · ${t.weeks} 周` : ''} · ${t.sessions.length} 条课时` : '尚未导入'}`);
    if (t.enabled && t.cancelled.length) lines.push(`- 已登记停课/取消 ${t.cancelled.length} 条`);
  }
  if (both || asksDuty) {
    if (v.expected) {
      // 源表里没填名字的席位用节次标签占位（如「78节」），不能当成人名念给用户
      const named = v.expected.names.filter(n => n && !/^\d{1,2}节$/.test(n));
      const unnamed = v.expected.names.length - named.length + v.expected.vacantCount;
      lines.push(`**周${wdOf(v.expected.weekday)} ${v.expected.slotCode} 节值班**：${named.length ? named.join('、') : '（表上这一格未填姓名）'}${unnamed > 0 ? ` · 另有 ${unnamed} 个席位未指名` : ''}`);
    } else {
      // 问"今天/明天/周X 的值班表"但没有指定节次时，用户要的是**那一天**的排班，
      // 不是"模板已导入 + 全员名单"（2026-11-14 实机就是在这里答非所问）。
      const targetWd = resolveTargetWeekday(q, extras.today);
      const day = targetWd ? (v.days as Array<{ weekday?: number; slots?: Array<{ slotCode?: string; seats?: Array<{ name?: string; vacant?: boolean }> }> }>)
        .find((d) => Number(d.weekday) === targetWd) : null;
      if (day && Array.isArray(day.slots) && day.slots.length) {
        lines.push(`**周${wdOf(targetWd!)} 值班安排**：`);
        for (const slot of day.slots) {
          const names = (slot.seats || []).filter((x) => x && !x.vacant && x.name).map((x) => x.name as string);
          const vacant = (slot.seats || []).filter((x) => x && x.vacant).length;
          lines.push(`- ${slot.slotCode} 节：${names.length ? names.join('、') : '（未填姓名）'}${vacant > 0 ? ` · 空缺 ${vacant} 席` : ''}`);
        }
      } else if (targetWd) {
        // 说到了具体某天但模板里没有这天（如周日），要如实说"不在排班范围"，不能回落成模板概况
        const covered = (v.days as Array<{ weekday?: number }>).map((d) => `周${wdOf(Number(d.weekday))}`).join('、');
        lines.push(`**周${wdOf(targetWd)} 值班安排**：这一天不在排班范围内${covered ? `（当前模板覆盖 ${covered}）` : ''}。`);
      } else {
        lines.push(`**志愿者周值班模板**：${v.enabled ? `已导入 · ${v.days.length} 天 · ${v.persons.length} 名志愿者` : '尚未导入'}`);
      }
    }
    if (wantsRoster && v.enabled && v.persons.length) {
      const named = v.persons.filter((p) => p.name && !/^\d{1,2}节$/.test(p.name));
      const placeholderCount = v.persons.length - named.length;
      const who = named.slice(0, 10).map((p) => `${p.name}${p.className || p.group ? `（${[p.className, p.group].filter(Boolean).join(' · ')}）` : ''}`);
      const tail = named.length > 10 ? ` 等共 ${named.length} 人` : '';
      lines.push(`- 名单：${who.length ? who.join('、') + tail : '（表上未填姓名）'}${placeholderCount > 0 ? ` · 另有 ${placeholderCount} 个席位以节次标签占位、未填姓名` : ''}`);
    }
  }
  // hint 是**给模型的处置指引**（原文是"请如实告知用户并提示联系管理员"），
  // 原样印进正文会让用户读到一句对本机指令的复述（2026-11-10 真实数据实机实测到）。
  // 用户侧只给事实与下一步：哪一侧没导入、该找谁；两侧都在时才保留中性出处说明。
  const missing = [(!t.enabled && (both || asksTerm)) && '学期安排', (!v.enabled && (both || asksDuty)) && '志愿者周值班模板'].filter(Boolean) as string[];
  if (missing.length) lines.push(`- ${missing.join('、')}尚未导入，请联系管理员在学期数据接入里补齐后再查询。`);
  else if (both && r.hint) lines.push(`- ${r.hint}`);
  return lines.join('\n');
}

/** 学期安排/值班模板写回结果：如实呈现 revision 与规模，未自动发布的语义必须带上 */
function renderTermScheduleAppliedAnswer(r: ResultPayload<'term_schedule_applied'>): string {
  const label = r.target === 'term' ? '学期安排' : '志愿者周值班模板';
  const lines: string[] = [];
  lines.push(`**${label}已更新**：revision=${r.revision}，当前 ${r.count} 条，操作者 ${r.updatedBy || '当前账号'}。`);
  if (r.droppedKeys.length) lines.push(`- 已忽略非白名单字段：${r.droppedKeys.join('、')}`);
  lines.push('- 该档案为主系统只读数据源，不参与课表实时解算；如与现场排班不一致，以管理员确认后的数据为准。');
  return lines.join('\n');
}

function renderProposalAnswer(p: Proposal): string {
  const lines: string[] = [];
  lines.push(`**已生成办理单《${p.title}》，等待你确认：**`);
  lines.push(`- ${p.summary}`);
  if (p.effects.length) {
    lines.push(`- 提交后将执行 ${p.effects.length} 项变更：${p.effects.map((e) => e.label).join('；')}`);
  }
  for (const dep of p.missingDependencies) lines.push(`- 未接入：${dep}`);
  if (p.canExecute) {
    lines.push('请在下方提案卡核对后点击「确认执行」。确认后返回业务单号与回执；也可以直接拒绝或放弃。');
  } else {
    lines.push(`- ⚠️ 当前演示身份无权执行：${p.cannotExecuteReason ?? '权限不足'}。可在左侧切换演示视角后重新发起。`);
  }
  lines.push('（执行环境：沙盒演示，不产生真实业务影响；单号与回执以提案卡为准，聊天文字不是凭据。）');
  return lines.join('\n');
}

function renderReportAnswer(r: OperationsReportResult): string {
  const lines: string[] = [];
  lines.push(
    `**运营日报草稿（${r.range.startDate}${r.range.startDate !== r.range.endDate ? ` ~ ${r.range.endDate}` : ''}）**：`
  );
  for (const m of r.metrics) {
    lines.push(
      m.status === 'known'
        ? `- **${m.label}：${m.value} ${m.unit}**`
        : `- ${m.label}：未知 —— ${m.note}`
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
  const head = result.labName
    ? `${result.labName}（${result.labLocation ?? '位置未录入'}）${result.date}（${result.weekdayLabel}，${weekText}）`
    : `该班级 ${result.date}（${result.weekdayLabel}，${weekText}）`;

  if (result.reason === 'lab_not_found') {
    return `**查不到课表：系统里没有收录这个房间号。**\n\n可选的房间号：${result.suggestions.join('、') || '（当前未收录任何房间）'}。`;
  }
  // 班级不存在：必须说"没有这个班"，不能说"当天没有排课"（后者会被理解成"班存在但没课"）
  if (result.reason === 'class_not_found') {
    const options = result.suggestions.slice(0, 10).join('、') || '（当前未收录任何班级）';
    return `**查不到课表：系统里没有这个班级。**\n\n可选的班级：${options}。请确认班级名称，或把房间号/日期告诉我，我按房间查。`;
  }
  if (result.lessons.length === 0) {
    // F09：timetable_empty 是数据问题，不能先给"没有课"的确定结论
    if (result.reason === 'timetable_empty') {
      return `**${head}无法判断是否有课**：系统内课表数据为空。本结果不构成"该房间没课"的结论。`;
    }
    // 用户口径（2026-11-11）：查到没课就只回"没有课"，不解释"系统没编造"这类开发细节，
    // 也不再引导"看下方结果卡"——空结果不再渲染结果卡。
    if (result.reason === 'no_class_in_that_period') return `**${head}本节没有课。**`;
    if (result.reason === 'lab_not_active') return `**${head}当前不是开放状态，当天也没有排课。**`;
    return `**${head}没有课。**`;
  }

  // A8：重点先行（加粗结论句），明细列表化；数据来源/常规口径不上正文——
  // 来源徽章与结构化卡已经在界面承担，正文只留改变结论的例外说明。
  const lines: string[] = [];
  const lastLesson = result.lessons[result.lessons.length - 1]!;
  const courseOf = (l: ScheduleQueryResult['lessons'][number]) => l.courseName || '课程名未录入';
  lines.push(
    `**${head}共有 ${result.lessons.length} 条排课**，从 ${result.lessons[0]!.startTime} 的《${courseOf(result.lessons[0]!)}》到 ${lastLesson.endTime} 的《${courseOf(lastLesson)}》。`
  );
  const byPeriod = result.byPeriod.filter((b) => b.count > 0);
  if (byPeriod.length) {
    lines.push(`- 占用节次：${byPeriod.map((b) => `${b.periodLabel}×${b.count}`).join('、')}；逐节明细见下方课表卡`);
  }
  if (extras.periodFiltered) lines.push('- 已按你指定的节次过滤');
  if (extras.dateWasDefaulted) lines.push(`- 你没有说明日期，以上按服务端当天 ${result.date} 计算`);
  // A8：notes 白名单——只保留改变结论或口径的例外说明（警告/歧义消解/停用/
  // 学生视角/周次不可确定）；常规口径（教学周、门态、在室统计说明）留在结构化卡
  for (const n of result.notes) {
    if (/⚠️|未带字母前缀|临时停用|仅为本人的课程|教学周不可确定|未做周次过滤/.test(n)) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

/** 视觉现场事实回答：逐行转达边缘上报的剥离身份事实；红线说明必须随行转达 */
export function renderVisionFieldAnswer(r: VisionFieldResult): string {
  if (!r.configured) return `**${r.note ?? '视觉边缘服务未接入'}**`;
  const lines: string[] = [];
  // 防御：视觉结果可能来自不同源头（工具直出 / 会话恢复 / 历史回放），
  // detailLines 不是必然存在。缺了就地从 labs 重建，不能让整轮回答崩在 .length 上。
  const detail = Array.isArray(r.detailLines) ? r.detailLines : [];
  if (detail.length) lines.push(...detail);
  else if (Array.isArray(r.labs) && r.labs.length) {
    for (const lab of r.labs) {
      const capacity = lab.capacity !== null && lab.capacity !== undefined ? `/${lab.capacity} 容量` : '';
      const faces = typeof lab.recognized === 'number' ? `，已录入人脸命中 ${lab.recognized} 人` : '';
      const state = lab.online ? '在线' : '摄像头离线';
      lines.push(`${lab.labId || '未知房间'}：${state}，AI 计数 ${lab.count ?? '未知'}${capacity} 人${faces}`);
    }
  } else if (Array.isArray(r.knownLabs)) lines.push(`已接入房间：${r.knownLabs.join('、') || '无'}；${'暂无该房间数据'}`);
  else lines.push('暂无上报数据');
  if (r.note) lines.push(`（${r.note}）`);
  return lines.join('\n');
}

/** 签到汇总回答（管理员）：总量先行，缺口逐课列出（含未签到学号），红线口径随附 */
function renderCheckinSummaryAnswer(r: CheckinSummaryResult): string {
  if (!r.sessions.length) return `**${r.date} 所选范围内没有排课，无签到汇总。**`;
  const lines: string[] = [];
  const t = r.totals;
  const expectedText = t.unknownExpected ? `${t.expected}+（${t.unknownExpected} 节应到未知）` : String(t.expected);
  lines.push(`**${r.date} 签到汇总：共 ${t.sessions} 节课，应到 ${expectedText}，已签到 ${t.checkedIn}，缺口 ${t.absent}**（签退 ${t.checkedOut}、补签到 ${t.late}、扫错实验室 ${t.mismatch}、定位失败 ${t.locationFailed}）。`);
  for (const s of r.sessions) {
    const time = s.start && s.end ? `${s.start}–${s.end}` : '';
    const base = `- ${time ? time + ' ' : ''}${s.periodLabel || s.periodKey}｜《${s.courseName || '未录入'}》｜${s.labName || '实验室未录入'}｜${s.classNames.join('、') || '班级未录入'}`;
    if (s.expected === null) {
      lines.push(`${base}｜应到未知（${s.note || '班级人数未知'}），已签到 ${s.checkedIn}`);
    } else if ((s.absentCount ?? 0) > 0) {
      const names = s.absentUsernames && s.absentUsernames.length ? `，未签到学号：${s.absentUsernames.join('、')}` : '';
      lines.push(`${base}｜应到 ${s.expected}，已签到 ${s.checkedIn}，账面缺口 ${s.absentCount}${names}${s.note ? `（${s.note}）` : ''}`);
    } else {
      const names = s.absentUsernames && s.absentUsernames.length ? `，但名册中有未签到学号：${s.absentUsernames.join('、')}` : '';
      lines.push(`${base}｜应到 ${s.expected}，已签到 ${s.checkedIn}，无账面缺口${names}${s.note ? `（${s.note}）` : ''}`);
    }
  }
  if (r.totals.late || r.totals.mismatch || r.totals.locationFailed) {
    lines.push(`异常提示：补签到 ${r.totals.late}、扫错实验室 ${r.totals.mismatch}、定位失败 ${r.totals.locationFailed}——均为留痕标记，处理需管理员在主系统核对原始记录。`);
  }
  lines.push('（缺口=应到−实到的账面差，需现场核实后再定性；请勿代替学生签到。未签到名单为学号（账号），不含姓名。）');
  return lines.join('\n');
}

/** 签到状态回答：如实转述主系统服务端判定的本人状态；引导本人在场签到，不代签 */
function renderCheckinStatusAnswer(r: CheckinStatusResult): string {  if (r.note) return `**${r.note}**`;
  if (!r.lessons.length) return `**${r.date} 没有本人的课程安排，无签到状态可查。**`;
  const lines: string[] = [];
  const openUnsigned = r.lessons.find(l => l.status === 'unsigned' && l.phase === 'open');
  if (openUnsigned) {
    const late = openUnsigned.lateWindow ? '（已超过开课 20 分钟，现在签会记「补签到」）' : '';
    lines.push(`**${openUnsigned.periodLabel || openUnsigned.periodKey}《${openUnsigned.courseName || '课程'}》在 ${openUnsigned.labName || '实验室'}，尚未签到${late}。**`);
  } else {
    const done = r.lessons.filter(l => l.status !== 'unsigned');
    lines.push(`**${r.date}${done.length ? `：${done.length} 节已有签到记录` : '：暂无本人签到记录'}。**`);
  }
  for (const l of r.lessons) {
    const time = l.start && l.end ? `${l.start}–${l.end}` : '时间未录入';
    const course = `《${l.courseName || '未录入'}》`;
    const room = l.labName || '实验室未录入';
    if (l.status === 'signed_out') {
      lines.push(`- ${time} ${l.periodLabel || l.periodKey}｜${course}｜${room}｜已签退${l.autoSignout ? '（系统自动签退）' : ''}${l.lateSignin ? '；签到时记补签到' : ''}`);
    } else if (l.status === 'signed') {
      lines.push(`- ${time} ${l.periodLabel || l.periodKey}｜${course}｜${room}｜已签到${l.lateSignin ? '（补签到）' : ''}${l.mismatch ? '；⚠️ 签到实验室与本课安排不一致' : ''}`);
    } else if (l.phase === 'open') {
      lines.push(`- ${time} ${l.periodLabel || l.periodKey}｜${course}｜${room}｜未签到，现可签到${l.lateWindow ? '（将记补签到）' : ''}`);
    } else if (l.phase === 'ended') {
      lines.push(`- ${time} ${l.periodLabel || l.periodKey}｜${course}｜${room}｜未签到，节次已结束`);
    } else {
      lines.push(`- ${time} ${l.periodLabel || l.periodKey}｜${course}｜${room}｜未签到，未到可签时间（开课前 10 分钟开放）`);
    }
  }
  const entry = openUnsigned?.checkinPath;
  if (entry) {
    lines.push(`签到入口：${entry}（须由本人在场完成；身份、时间与课程归属由主系统服务端核验）。`);
  }
  lines.push('（Agent 不代签：签到须本人在实验室现场完成，扫码主链不变。）');
  return lines.join('\n');
}

function renderLabStatusAnswer(r: LabStatusResult, extras: { question?: string }): string {
  if (r.labName === null) {
    return `**查不到状态：系统里没有收录这个房间号。**\n\n可选的房间号：${r.suggestions.join('、') || '（当前未收录任何房间）'}。`;
  }
  // A8：重点先行——"有人吗"的核心答案（在室人数）或排课概要放第一句加粗；
  // 在室统计长口径、门态说明留在结构化卡，正文只留一行短口径括注。
  // ⚠️ 保留 `在室人数：N 人` 字面（occupancy.test.ts 按它取值）。
  const lines: string[] = [];
  const head = `${r.labName}（${r.labLocation ?? '位置未录入'}）`;
  if (r.occupancy) {
    lines.push(
      `**${head}在室人数：${r.occupancy.present} 人**（${r.occupancy.date} 有效签到口径，不等于"此刻一定有人"）。档案状态「${r.statusLabel}」，容量 ${r.capacity ?? '未知'} 人。`
    );
  } else {
    lines.push(
      `**${head}${r.date}（${r.weekdayLabel}）有 ${r.schedule.lessonCount} 条排课**。档案状态「${r.statusLabel}」，容量 ${r.capacity ?? '未知'} 人。`
    );
    lines.push('- 在室人数：未知 —— 当前没有签到数据来源（业务通道未连接或未取得授权），无法提供，请勿据此判断是否有人');
  }
  if (r.schedule.nextLesson) {
    lines.push(`- 下一节：${r.schedule.nextLesson.startTime} 的《${r.schedule.nextLesson.courseName}》（${r.schedule.nextLesson.periodLabel}）`);
  } else if (r.schedule.nextLessonReason === 'not_applicable') {
    lines.push('- 「下一节课」仅对当天提供；你查的是其他日期，请看当天排课明细');
  } else if (r.schedule.nextLessonReason === 'no_more_today') {
    lines.push('- 当天剩余时间没有更多排课');
  }
  if(r.serviceState==='suspended')lines.push('- ⚠️ 服务状态：停用；请分别核对停用节次与排课');
  if(r.keySummary && (r.keySummary.state!=='unknown'||r.keySummary.location)){
    const k=r.keySummary;const labels:Record<string,string>={in_cabinet:'在钥匙柜',borrowed:'登记借用',handover:'登记位置待交接',unknown:'位置未知'};
    lines.push(`- 钥匙登记：${labels[k.state]||'未知'}${k.location?`，位置 ${k.location}`:''}${k.holder?`，借用人 ${k.holder}`:''}`);
  }
  // A8：notes 白名单（与课表渲染同口径）——只上例外说明，不上常规口径
  for (const n of r.notes) {
    if (/⚠️|已按|临时停用|匹配到多个房间|未带字母前缀/.test(n)) lines.push(`- ${n}`);
  }
  // 能力边界按需出现：只有用户在问"明细/都有谁"时才说明逐人明细未开放，
  // 平时不刷屏（occupancy 长口径已在结构化卡里）
  if (extras.question && /明细|都有谁|签到记录/.test(extras.question)) {
    lines.push('- 逐人签到明细未开放：没有对 LabOps 开放的接口，无法代查');
  }
  return lines.join('\n');
}

function renderFreeRoomsAnswer(r: FreeRoomsResult): string {
  const lines: string[] = [];
  // F09：数据覆盖不足时禁止输出确定空闲名单
  if (r.coverage === 'missing') {
    lines.push(`**无法判断 ${r.date}（${r.weekdayLabel}）哪些房间空闲**：系统内课表数据为空，"没有记录"不能当成"没有课"。`);
    lines.push('请先导入课表数据后再使用找空闲房间功能。');
    return lines.join('\n');
  }
  const scope = r.periodFilter
    ? `${r.freeByPeriod[0].periodLabel}（${r.freeByPeriod[0].startTime}-${r.freeByPeriod[0].endTime}）`
    : r.periodKeys.length && r.periodKeys.length < 6
      ? r.freeByPeriod.map((p) => p.periodLabel).join('、')
      : '全天各节次';
  lines.push(`**${r.date}（${r.weekdayLabel}）${scope}的空闲房间**——只统计档案状态为「开放」的房间：`);
  for (const p of r.freeByPeriod) {
    lines.push(
      `- **${p.periodLabel}（${p.rooms.length} 间）**：${p.rooms.length ? p.rooms.map((x) => x.labName).join('、') : '无空闲房间'}`
    );
  }
  if (r.excluded.length) {
    lines.push(`- 已排除（档案非开放，不宜推荐借用，课表未必不空）：${r.excluded.map((x) => `${x.labName}（${x.reason}）`).join('、')}`);
  }
  lines.push('说明：「空闲」指课表上无排课，不代表室内无人，也不代表可以预约借用。');
  return lines.join('\n');
}
