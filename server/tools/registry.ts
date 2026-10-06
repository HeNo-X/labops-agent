import { isBusinessConnected, effectiveRole } from '../business/bridge.ts';
import { runKnowledge } from './knowledge.ts';
import { prepareSchedule, queryDuty, queryBusiness, prepareWorkflow, queryIncident, prepareIncident,queryScheduled,prepareScheduled } from './business.ts';
import type { KnowledgeResult, BusinessPlanResult } from '../../shared/types.ts';
/**
 * 工具注册表 —— JSON Schema + 白名单 + 参数类型校验 + 人话摘要
 * ============================================================================
 *  阶段 2A 注册 3 个只读工具：query_schedule / query_lab_status / query_free_rooms。
 *  注册表 = 真实能力清单：没有数据支撑的能力（值班 / 签到 / 钥匙 / 在室人数）与
 *  写操作**一律不注册** —— 注册了却不实现，只会让模型选到一个必然失败的工具。
 *
 *  难点 1 对策 2/3 落在这里：
 *    · 工具名不在注册表 → 回一条"工具 X 不存在，可用工具有：…"，让模型重试
 *    · 参数值非法       → 回"没有 E999，可选：E310/E312/…"，让模型改正
 *  两条都是**可恢复错误**（ok=false + 结构化提示），而不是抛异常中断任务。
 *
 *  摘要原则（工作台改造引入）：summarize() 只给**一行可读结论**，
 *  完整明细在结构化 result 里（界面渲染结构化卡片，模型读 result 全量）。
 */

import type {
  FreeRoomsResult,
  LabStatusResult,
  OperationsReportResult,
  QueryScheduleArgs,
  ScheduleQueryResult,
  ToolSpec
} from '../../shared/types.ts';
import { DATA_SOURCE_LABELS } from '../../shared/types.ts';
import type { Proposal, SandboxActor } from '../../shared/operations-contract.ts';
import type { Dataset } from '../data/store.ts';
import type { ServerNow } from '../time/term.ts';
import {
  ToolArgumentError,
  availableRoomNames,
  runQuerySchedule
} from './query-schedule.ts';
import { coerceLabStatusArgs, runQueryLabStatus } from './query-lab-status.ts';
import { coerceFreeRoomsArgs, runQueryFreeRooms } from './query-free-rooms.ts';
import { PERIOD_KEYS, isPeriodKey } from '../../shared/periods.ts';
import {
  runCreateOperationsReport,
  runPrepareDutySession,
  runPrepareIssueTicket,
  runPrepareNotification,
  runPrepareRoomClosure
} from './prepare-tools.ts';

/** 注册表 —— 每个条目必须同时有 spec（给模型）与 execute（给服务端） */
export interface RegisteredTool {
  spec: ToolSpec;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => ToolExecution | Promise<ToolExecution>;
  /**
   * 展示用效果标注（不发给模型）：read=只读查询；draft=生成办理单草稿（不执行业务）。
   * 真正的权限边界在服务端 policy/executor，不由这个标记决定（任务书 §11.2）。
   */
  effect: 'read' | 'draft';
}

/**
 * 工具上下文。actor / conversationId 由服务端注入（ops.v1 起生效）：
 * 身份绝不出现在模型可写的参数里；只读工具不使用这两个字段。
 */
export interface ToolContext {
  mode?: 'chat' | 'task';
  signal?: AbortSignal;
  dataset: Dataset;
  now: ServerNow;
  /** 服务端解析的沙盒演示身份（ops.v1 写操作必需） */
  actor?: SandboxActor;
  /** 发起本轮的会话 id（任务与提案挂靠用；直连 /api/agent/chat 时为空） */
  conversationId?: string | null;
}

/** 可判别联合：resultKind 与 result 的类型一一对应，调用方按 kind 收窄 */
export type ToolExecution =
  | { ok: true; resultKind: 'schedule'; result: ScheduleQueryResult; summary: string }
  | { ok: true; resultKind: 'lab_status'; result: LabStatusResult; summary: string }
  | { ok: true; resultKind: 'free_rooms'; result: FreeRoomsResult; summary: string }
  | { ok: true; resultKind: 'operation_proposal'; result: Proposal; summary: string }
  | { ok: true; resultKind: 'operations_report'; result: OperationsReportResult; summary: string }
  | { ok: true; resultKind:'knowledge'; result:KnowledgeResult; summary:string }
  | { ok: true; resultKind:'business_plan'; result:BusinessPlanResult; summary:string }
  | { ok: false; code: string; message: string; suggestions: string[]; summary: string };

// ===========================================================================
//  query_schedule 的 JSON Schema
// ===========================================================================

const QUERY_SCHEDULE_SPEC: ToolSpec = {
  name: 'query_schedule',
  description:
    '查询【指定日期 + 指定房间】在实验室课表里的排课安排，返回该房间当天的课程、班级、教师（已脱敏）、节次与起止时间。' +
    '用于回答这一类问题：「E310 今天有哪些课」「周三 D517 有课吗」「某实验室某天第几节被谁占用」。' +
    '调用前请先用服务端给出的当前日期/星期/教学周信息把用户的时间指代（今天、周三、9月30日）换算成 YYYY-MM-DD，本工具不接受"今天"这类自然语言。' +
    '本工具只读、不改动任何数据。不要用它回答签到人数、钥匙位置、人员名单、房间档案类问题——那些不在本工具范围内。',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: '查询日期，格式必须是 YYYY-MM-DD（例如 2026-09-30）。',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$'
      },
      labName: {
        type: 'string',
        description: '实验室房间号，例如 E310、D517、D526。必须来自系统已收录的房间号列表。'
      },
      periodKey: {
        type: 'string',
        enum: [...PERIOD_KEYS],
        description:
          '可选。只查某一个节次。am1=上午第一大节(08:20-09:50)，am2=上午第二大节(10:10-11:40)，' +
          'pm1=下午第一大节(14:00-15:30)，pm2=下午第二大节(15:50-17:20)，' +
          'eve_ab=晚上AB节(17:30-19:00)，eve_cd=晚上CD节(19:10-20:40)。不传表示查全天。'
      }
    },
    required: ['date', 'labName'],
    additionalProperties: false
  },
  danger: false
};

const QUERY_LAB_STATUS_SPEC: ToolSpec = {
  name: 'query_lab_status',
  description:
    '查询【某个实验室房间】的档案与状态：位置、容量、开放状态（开放/关闭/停用）、描述，以及指定日期的排课统计' +
    '（当天几节课、哪些节次被占用、下一节课是什么）。用于回答：「E310 现在开放吗」「D515 容量多大」「那间房今天还有什么课」「310 现在有多少人」。' +
    '在室人数（occupancy）：**仅当主系统已授权实时通道时**返回真实值，口径=当日有效签到−有效签退（与主系统页面同源）；' +
    '取不到时为 null，此时必须如实回答"查不到"，**不得估算或编造人数**。',
  parameters: {
    type: 'object',
    properties: {
      labName: {
        type: 'string',
        description: '实验室房间号，例如 E310。必须来自系统已收录的房间号列表。'
      },
      date: {
        type: 'string',
        description: '可选。排课统计的日期，YYYY-MM-DD。缺省为服务端当天。',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$'
      }
    },
    required: ['labName'],
    additionalProperties: false
  },
  danger: false
};

const QUERY_FREE_ROOMS_SPEC: ToolSpec = {
  name: 'query_free_rooms',
  description:
    '查询【指定日期（+可选节次）】没有排课的实验室房间清单，用于"找空实验室/哪些房间没人用"类问题：' +
    '「明天下午第二大节哪些实验室空着」「9月30日有什么房间可用」。' +
    '返回按节次分组的空闲房间（含开放状态与容量）。「空闲」仅指课表无排课，不代表室内无人。' +
    '调用前先把自然语言时间指代换算成 YYYY-MM-DD；date 缺省为服务端当天。',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: '可选。查询日期，YYYY-MM-DD。缺省为服务端当天。',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$'
      },
      periodKey: {
        type: 'string',
        enum: [...PERIOD_KEYS],
        description:
          '可选。只看某一个节次；不传可用 periodKeys 传范围。'
      },
      periodKeys: {
        type: 'array',
        items: { type: 'string', enum: [...PERIOD_KEYS] },
        description:
          '可选。节次范围，如"下午"= ["pm1","pm2"]。与 periodKey 二选一；都不传则返回全部六个节次。'
      }
    },
    required: [],
    additionalProperties: false
  },
  danger: false
};

// ===========================================================================
//  参数校验（服务端白名单 + 类型校验，模型给的一律不可信）
// ===========================================================================

/**
 * 把模型给的任意对象收敛成严格类型（F17）：
 *   · 缺省字段保持缺省（由工具用安全默认值）；
 *   · **显式提供但非法的字段必须报错**，绝不静默丢弃后扩大查询范围
 *     （例如 periodKey='bad' 被丢弃会变成"查全天"，把受限查询悄悄放大）。
 */
export function coerceQueryScheduleArgs(raw: Record<string, unknown>): QueryScheduleArgs {
  const out: QueryScheduleArgs = {};
  const date = raw['date'];
  if (typeof date === 'string' && date.trim()) out.date = date.trim();
  else if (date !== undefined && date !== null && date !== '') {
    throw new ToolArgumentError('bad_date', `date 参数必须是字符串（YYYY-MM-DD），收到：${typeof date}`);
  }
  const labName = raw['labName'];
  if (typeof labName === 'string' && labName.trim()) out.labName = labName.trim();
  else if (labName !== undefined && labName !== null && labName !== '') {
    throw new ToolArgumentError('bad_lab', `labName 参数必须是字符串，收到：${typeof labName}`);
  }
  const periodKey = raw['periodKey'];
  if (typeof periodKey === 'string') {
    const trimmed = periodKey.trim();
    if (!trimmed) {
      /* 空串视为未提供 */
    } else if (isPeriodKey(trimmed)) {
      out.periodKey = trimmed;
    } else {
      throw new ToolArgumentError(
        'bad_period',
        `periodKey 非法：${trimmed}（合法值：${PERIOD_KEYS.join(' / ')}）`
      );
    }
  } else if (periodKey !== undefined && periodKey !== null && periodKey !== '') {
    // R10：显式给了错误类型（如数字 999）也是参数错误，不能静默丢弃后放宽为全天
    throw new ToolArgumentError('bad_period', `periodKey 必须是字符串节次键，收到：${typeof periodKey}(${String(periodKey)})`);
  }
  return out;
}

// ===========================================================================
//  ops.v1 准备类工具的 JSON Schema（effect=draft：只生成办理单，不执行业务）
// ===========================================================================

const PREPARE_ISSUE_SPEC: ToolSpec = {
  name: 'prepare_issue_ticket',
  description:
    '【准备报修/问题工单】当用户报告实验室的设备故障、环境卫生、网络、门窗照明等问题并希望"报修/建单/登记问题"时使用。' +
    '只生成可编辑的报修办理单（提案），用户在提案卡中确认后才会在沙盒中创建工单；本工具不执行任何写操作。' +
    'roomId 必须是系统已收录的房间号；description 请保留用户的原始事实描述，不要编造设备编号或资产 ID；' +
    'attachmentIds 仅在用户明确给出附件引用时传入（上传服务未接入，只登记 ID）。',
  parameters: {
    type: 'object',
    properties: {
      roomId: { type: 'string', description: '房间号，例如 E310。必须来自系统已收录的房间号列表。' },
      category: {
        type: 'string',
        enum: ['equipment', 'environment', 'network', 'door_window_lighting', 'other'],
        description: '问题分类：equipment=设备故障，environment=环境卫生，network=网络问题，door_window_lighting=门窗照明，other=其他。'
      },
      description: { type: 'string', description: '问题事实描述（来自用户原话整理，1–2000 字），不编造细节。' },
      attachmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: '可选。附件引用 ID（最多 8 个）。上传服务未接入，仅登记引用。'
      }
    },
    required: ['roomId', 'category', 'description'],
    additionalProperties: false
  },
  danger: false
};

const PREPARE_CLOSURE_SPEC: ToolSpec = {
  name: 'prepare_room_closure',
  description:
    '【准备临时停用】当管理员要求"某房间某时段停用/检修/封闭，登记并处理受影响课程"时使用。' +
    '只生成停用办理单（含受影响排课统计，可联动维修工单与通知草稿），用户确认后才在沙盒执行；本工具不执行任何写操作。' +
    'periodKeys 必须给出具体节次；范围一次最长 14 天。生成前不要向用户索要全部细节——缺什么由提案卡的 missingDependencies 展示。',
  parameters: {
    type: 'object',
    properties: {
      roomId: { type: 'string', description: '房间号，例如 E310。必须来自系统已收录的房间号列表。' },
      startDate: { type: 'string', description: '停用开始日期 YYYY-MM-DD（先把"9月30日"换算好再传）。' },
      endDate: { type: 'string', description: '停用结束日期 YYYY-MM-DD（单日与 startDate 相同）。' },
      periodKeys: {
        type: 'array',
        items: { type: 'string', enum: [...PERIOD_KEYS] },
        description: '停用的节次列表，如下午两大节 = ["pm1","pm2"]。'
      },
      reason: { type: 'string', description: '停用原因（如"投影检修"），将写入停用记录与通知。' },
      createIssue: { type: 'boolean', description: '是否同时创建维修工单，缺省 true。' },
      prepareNotice: { type: 'boolean', description: '是否同时生成受影响通知草稿（站内），缺省 false。' }
    },
    required: ['roomId', 'startDate', 'endDate', 'periodKeys', 'reason'],
    additionalProperties: false
  },
  danger: false
};

const PREPARE_NOTICE_SPEC: ToolSpec = {
  name: 'prepare_notification',
  description:
    '【准备站内通知】当用户要"发布通知/公告，告知某些班级或人群某件事"时使用。' +
    '只生成通知办理单（标题/正文/受众预览），用户确认后才在沙盒发布；本工具不执行任何写操作。' +
    'title 与 content 必须来自用户的明确表述或其确认的草稿，不得自行虚构内容；' +
    '受众用 audience.kind 指定：class_ids=按班级（班级名必须来自课表数据）、role_scope=全部学生或志愿者、all=全体。' +
    '沙盒没有人员名册：接收人数未知，绝不编造"已通知 N 人"。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '通知标题（1–120 字），来自用户或其确认的草稿。' },
      content: { type: 'string', description: '通知正文（1–2000 字），来自用户或其确认的草稿。' },
      audience: {
        type: 'object',
        description: '接收范围。三选一：{"kind":"class_ids","classIds":[...]}；{"kind":"role_scope","role":"student"|"volunteer"}；{"kind":"all"}。',
        properties: {
          kind: { type: 'string', enum: ['class_ids', 'role_scope', 'all'], description: '受众类型。' },
          classIds: { type: 'array', items: { type: 'string' }, description: 'kind=class_ids 时必填：班级名称列表（须来自课表数据）。' },
          role: { type: 'string', enum: ['student', 'volunteer'], description: 'kind=role_scope 时必填。' }
        },
        required: ['kind'],
        additionalProperties: false
      },
      level: { type: 'string', enum: ['info', 'warning', 'urgent'], description: '通知级别。' }
    },
    required: ['title', 'content', 'audience', 'level'],
    additionalProperties: false
  },
  danger: false
};

const PREPARE_DUTY_SPEC: ToolSpec = {
  name: 'prepare_duty_session',
  description:
    '【准备值班开始/收尾交接】mode=start：志愿者开始某房间值班时使用；mode=handover：结束值班、整理检查清单并生成交接记录时使用。' +
    '只生成办理单，用户确认后才在沙盒执行；本工具不执行任何写操作，也不产生考勤记录。' +
    'mode=handover 时必须携带 checklist（用户逐项确认的检查清单，state=done/abnormal/unchecked）——' +
    '清单状态只能来自用户的明确陈述（如"灯已关""钥匙还没交"），用户没有提到的项一律 unchecked，绝不代用户勾选。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['start', 'handover'], description: 'start=开始值班；handover=结束值班并交接。' },
      roomId: { type: 'string', description: 'mode=start 时必填：值班房间号。' },
      sessionId: { type: 'string', description: 'mode=handover 时可选：值班会话 ID；缺省取最近一个进行中的会话。' },
      checklist: {
        type: 'array',
        description: 'mode=handover 时必填。每项 {key,label,state}；key 建议用系统模板键（power/lights/doors/keys/todo）。',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '清单项键，如 power（电源设备）、lights（关灯）、doors（门窗）、keys（钥匙）、todo（未完事项）。' },
            label: { type: 'string', description: '清单项名称。' },
            state: { type: 'string', enum: ['done', 'abnormal', 'unchecked'], description: '用户确认的状态：done=已完成，abnormal=有异常，unchecked=未确认/未检查。' }
          },
          required: ['key', 'label', 'state'],
          additionalProperties: false
        }
      },
      note: { type: 'string', description: 'mode=handover 时可选：交接备注（未完事项、异常说明）。' }
    },
    required: ['mode'],
    additionalProperties: false
  },
  danger: false
};

const REPORT_SPEC: ToolSpec = {
  name: 'create_operations_report',
  description:
    '【生成运营日报草稿】当用户要"整理某天的值班/报修/通知/停用情况，生成日报/报告"时使用。' +
    '直接生成一份当前用户可见的报告草稿（不发布给他人、不需要确认）。' +
    '统计只覆盖沙盒业务数据与课表快照；签到类数据未接入时对应指标如实标"未知"，绝不显示为 0。',
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: '可选。起始日期 YYYY-MM-DD，缺省为服务端当天。' },
      endDate: { type: 'string', description: '可选。结束日期 YYYY-MM-DD，缺省同 startDate；范围最长 31 天。' },
      sections: {
        type: 'array',
        items: { type: 'string', enum: ['schedule', 'issues', 'notifications', 'closures', 'duty'] },
        description: '可选。要统计的段落，缺省全部：schedule=排课，issues=报修，notifications=通知，closures=停用，duty=值班。'
      }
    },
    required: [],
    additionalProperties: false
  },
  danger: false
};

// ===========================================================================
//  执行
// ===========================================================================

function fail(err: ToolArgumentError, prefix?: string): ToolExecution {
  return {
    ok: false,
    code: err.code,
    message: err.message,
    suggestions: err.suggestions,
    summary: err.suggestions.length
      ? `${prefix ? prefix + '：' : ''}${err.message}。可选房间号：${err.suggestions.join('、')}`
      : (prefix ? `${prefix}：` : '') + err.message
  };
}

function internalError(toolName: string, err: unknown): ToolExecution {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    code: 'tool_internal_error',
    message: `${toolName} 执行时发生未预期错误：${message}`,
    suggestions: [],
    summary: '工具执行失败，请稍后重试或联系管理员'
  };
}

function executeQuerySchedule(args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  // N11：参数收敛也在工具受控边界内 —— 非法参数返回 ok=false 的结构化错误，不抛出包装层
  try {
    const normalized = coerceQueryScheduleArgs(args);
    const result = runQuerySchedule(normalized, ctx.dataset, ctx.now);
    return { ok: true, resultKind: 'schedule', result, summary: summarizeSchedule(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) return fail(err);
    return internalError('query_schedule', err);
  }
}

async function executeQueryLabStatus(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  try {
    const normalized = coerceLabStatusArgs(args);
    const result = await runQueryLabStatus(normalized, ctx.dataset, ctx.now);
    return { ok: true, resultKind: 'lab_status', result, summary: summarizeLabStatus(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) return fail(err);
    return internalError('query_lab_status', err);
  }
}

function executeQueryFreeRooms(args: Record<string, unknown>, ctx: ToolContext): ToolExecution {
  try {
    const normalized = coerceFreeRoomsArgs(args);
    const result = runQueryFreeRooms(normalized, ctx.dataset, ctx.now);
    return { ok: true, resultKind: 'free_rooms', result, summary: summarizeFreeRooms(result) };
  } catch (err) {
    if (err instanceof ToolArgumentError) return fail(err);
    return internalError('query_free_rooms', err);
  }
}

export const REGISTRY: RegisteredTool[] = [
  {spec:{name:'query_incident',description:'从原系统查询故障事件、影响范围和关联调课/停用/工单/通知。未登记事件先查询事件列表。',parameters:{type:'object',properties:{incidentId:{type:'string'}},additionalProperties:false},danger:false},execute:queryIncident,effect:'read'},
  {spec:{name:'prepare_incident_plan',description:'管理员保存用户明确声明的故障事件草稿，分析最多6项教学活动的联合候选，或准备处置/恢复方案。只能准备，实际提交必须由本人点击确认。缺失事实不得猜测。',parameters:{type:'object',properties:{action:{type:'string',enum:['draft','analyze','preview','restore','takeover']},incidentId:{type:'string'},expectedRevision:{type:'integer'},roomId:{type:'string'},date:{type:'string'},description:{type:'string'},device:{type:'string'},periodKeys:{type:'array',items:{type:'string',enum:[...PERIOD_KEYS]}},preference:{type:'string',enum:['keep_period','few_rooms','early']},candidateSetId:{type:'string'},optionId:{type:'string'},note:{type:'string'},undoMoves:{type:'boolean'}},required:['action'],additionalProperties:false},danger:false},execute:prepareIncident,effect:'draft'},
  {spec:{name:'query_business_context',description:'查询原系统当前账号可见的工单状态、通知已读、检查记录、临时停用或真实日报。不得拿沙盒统计冒充真实业务。',parameters:{type:'object',properties:{view:{type:'string',enum:['issues','notifications','closures','duty','report','tasks','incidents','health']},date:{type:'string'}},required:['view'],additionalProperties:false},danger:false},execute:queryBusiness,effect:'read'},
  {spec:{name:'prepare_business_workflow',description:'准备原系统工单创建或流转、检查补全/最终交接/接收、通知或停用方案。先查 query_business_context 获取真实对象与版本。未明确说明的检查保持 unchecked。只准备，实际提交需本人点击消息卡。',parameters:{type:'object',properties:{kind:{type:'string',enum:['resource.patch','issue.create','issue.action','duty.handover','duty.accept','duty.reassign','duty.item','notification.publish','closure.create','closure.revoke']},resourceKind:{type:'string',enum:['room','class','course']},resourceId:{type:'string'},field:{type:'string',enum:['capacity','size','equipment','requiredEquipment']},after:{},expectedResourceVersion:{type:'string'},evidence:{type:'string'},roomId:{type:'string'},description:{type:'string'},issueId:{type:'string'},expectedRevision:{type:'integer'},action:{type:'string',enum:['assign','start','submit','close','return','complete','carry']},assigneeId:{type:'string',description:'仅action=assign可填写；其他工单动作不得携带此字段'},itemId:{type:'string'},targetShiftId:{type:'string'},adoptItemIds:{type:'array',items:{type:'string'}},leftovers:{type:'array',items:{type:'object'}},taskId:{type:'string'},note:{type:'string'},shiftId:{type:'string'},checklist:{type:'array',items:{type:'object',properties:{key:{type:'string'},state:{type:'string',enum:['done','abnormal','unchecked']}},required:['key','state']}},finalize:{type:'boolean'},createIssue:{type:'boolean'},receiverId:{type:'string'},recordId:{type:'string'},title:{type:'string'},content:{type:'string'},audience:{type:'object'},startDate:{type:'string'},endDate:{type:'string'},periodKeys:{type:'array',items:{type:'string',enum:[...PERIOD_KEYS]}},reason:{type:'string'},closureId:{type:'string'}},required:['kind'],additionalProperties:false},danger:false},execute:prepareWorkflow,effect:'draft'},
  {spec:{name:'query_scheduled_jobs',description:'读取当前账号的定时规则、已保存执行结果或明日准备包。',parameters:{type:'object',properties:{view:{type:'string',enum:['rules','results','preparation']}},additionalProperties:false},danger:false},execute:queryScheduled,effect:'read'},
  {spec:{name:'prepare_scheduled_job',description:'仅预览固定模板定时规则，未来3次时间、样例、对象和效果必须让本人确认。不能调用确认接口；不能设置脚本、任意URL、自动调课或自动验收。普通用户仅能提醒自己。',parameters:{type:'object',properties:{action:{type:'string',enum:['create','change','pause','resume','archive','run_now']},jobId:{type:'string'},expectedVersion:{type:'integer'},reason:{type:'string'},spec:{type:'object',properties:{name:{type:'string'},kind:{type:'string',enum:['daily_report','tomorrow_courses','duty_reminder','due_followup','weekly_report','resource_risk','closure_expiry','notice_reminder']},timezone:{type:'string',enum:['Asia/Shanghai']},trigger:{type:'object',properties:{type:{type:'string',enum:['daily','weekly','once','duty','cron']},time:{type:'string'},weekdays:{type:'array',items:{type:'integer'}},at:{type:'string'},minutesBefore:{type:'integer'},expression:{type:'string'}},required:['type'],additionalProperties:false},calendarPolicy:{type:'string',enum:['all_days','teaching_days']},params:{type:'object'},recipients:{type:'array',items:{type:'object'}},approvedEffects:{type:'array',items:{type:'string',enum:['report','inbox']}}},required:['kind','trigger'],additionalProperties:false}},additionalProperties:false},danger:false},execute:prepareScheduled,effect:'draft'},
  {spec:{name:'query_knowledge',description:'检索当前软件操作说明，返回版本、生效日期与段落引用；未导入学校制度或厂家手册时明确缺依据。',parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},danger:false},execute:runKnowledge,effect:'read'},
  {spec:{name:'query_duty_context',description:'查询经原系统登录验证的本人正式排班，未连接或未配置时明确无法确定；不从历史签到猜测。',parameters:{type:'object',properties:{},additionalProperties:false},danger:false},execute:queryDuty,effect:'read'},
  {spec:{name:'prepare_schedule_adjustment',description:'为原系统管理员比较指定日期调课候选或保存待确认方案。先用 query_schedule 获取 timetableId。未给目标时返回候选；仅符合已核实约束才可保存。确认必须由用户在LabOps消息卡点击，本工具不执行调课。',parameters:{type:'object',properties:{date:{type:'string'},timetableId:{type:'string'},taskId:{type:'string'},candidateSetId:{type:'string'},supersedePlanId:{type:'string'},toLabId:{type:'string'},toPeriodKey:{type:'string',enum:[...PERIOD_KEYS]},reason:{type:'string'}},required:['date','timetableId'],additionalProperties:false},danger:false},execute:prepareSchedule,effect:'draft'},
  { spec: QUERY_SCHEDULE_SPEC, execute: executeQuerySchedule, effect: 'read' },
  { spec: QUERY_LAB_STATUS_SPEC, execute: executeQueryLabStatus, effect: 'read' },
  { spec: QUERY_FREE_ROOMS_SPEC, execute: executeQueryFreeRooms, effect: 'read' },
  { spec: PREPARE_ISSUE_SPEC, execute: runPrepareIssueTicket, effect: 'draft' },
  { spec: PREPARE_CLOSURE_SPEC, execute: runPrepareRoomClosure, effect: 'draft' },
  { spec: PREPARE_NOTICE_SPEC, execute: runPrepareNotification, effect: 'draft' },
  { spec: PREPARE_DUTY_SPEC, execute: runPrepareDutySession, effect: 'draft' },
  { spec: REPORT_SPEC, execute: runCreateOperationsReport, effect: 'draft' }
];

const BY_NAME = new Map(REGISTRY.map((t) => [t.spec.name, t]));

export function toolSpecs(): ToolSpec[] {
  return REGISTRY.map((t) => t.spec);
}

export function toolNames(): string[] {
  return REGISTRY.map((t) => t.spec.name);
}

/** Agnes 的 tools 参数格式（OpenAI 兼容）。danger 是本项目内部标记，不发给模型。 */
export function toolSpecsForAgnes(): Array<{ type: 'function'; function: Omit<ToolSpec, 'danger'> }> {
  return REGISTRY.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.spec.name,
      description: t.spec.description,
      parameters: t.spec.parameters
    }
  }));
}

export function isRegisteredTool(name: unknown): boolean {
  return typeof name === 'string' && BY_NAME.has(name);
}

/**
 * 统一的工具入口。工具名不在白名单时**不抛异常**，而是返回可恢复错误，
 * 附带可用工具清单 —— 让模型有一次自我纠正的机会（难点 1 对策 2）。
 * ops.v1 起支持异步工具（准备类工具要落库），统一 await。
 */
export async function executeTool(name: unknown, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecution> {
  const tool = typeof name === 'string' ? BY_NAME.get(name) : undefined;
  if (!tool) {
    return {
      ok: false,
      code: 'unknown_tool',
      message: `工具 ${String(name)} 不存在`,
      suggestions: toolNames(),
      summary: `工具 ${String(name)} 不存在，可用工具：${toolNames().join('、')}`
    };
  }
  if (ctx.mode === 'chat' && tool.effect !== 'read') return {ok:false,code:'mode_forbidden',message:'聊天模式只能查询，请切换任务模式',suggestions:[],summary:'当前模式禁止准备办理单'};
  if (!args || Array.isArray(args) || typeof args !== 'object') return {ok:false,code:'bad_arguments',message:'参数必须为对象',suggestions:[],summary:'参数必须为对象'};
  if(isBusinessConnected()&&!toolsForMode(ctx.mode||'task').some(t=>t.name===name))return {ok:false,code:'scope_forbidden',message:'当前原系统身份不支持此工具；沙盒工具不可混入原系统任务',suggestions:[],summary:'当前业务范围不允许此工具'};
  return await tool.execute(args, ctx);
}

// ===========================================================================
//  人话摘要 —— 一行结论，不塞明细（明细在结构化 result 里）
// ===========================================================================

export function summarizeSchedule(r: ScheduleQueryResult): string {
  const src = `【${DATA_SOURCE_LABELS[r.provenance.sourceType]}】`;
  if (r.reason === 'lab_not_found') {
    return `${src}系统里查不到房间号「${r.labName ?? ''}」；可选：${r.suggestions.slice(0, 6).join('、')}${r.suggestions.length > 6 ? ' 等' : ''}`;
  }
  const head = `${src}${r.labName} ${r.date}（${r.weekdayLabel}）课表：`;
  if (r.lessons.length === 0) {
    return `${head}无排课（${reasonText(r)}${r.periodFilter ? '，节次 ' + r.periodFilter : ''}）`;
  }
  return `${head}共 ${r.lessons.length} 条排课（合班已展开）`;
}

export function summarizeLabStatus(r: LabStatusResult): string {
  const src = `【${DATA_SOURCE_LABELS[r.provenance.sourceType]}】`;
  if (r.labName === null) {
    return `${src}系统里查不到房间号；可选：${r.suggestions.slice(0, 6).join('、')}${r.suggestions.length > 6 ? ' 等' : ''}`;
  }
  const next = r.schedule.nextLesson ? `，下一节 ${r.schedule.nextLesson.startTime} ${r.schedule.nextLesson.courseName}` : '';
  // 在室人数：有授权实时值就报值，取不到才说"无数据来源"（2026-10-06 修正：此前恒报未知）
  const occupancy = r.occupancy ? `；在室人数 ${r.occupancy.present} 人（${r.occupancy.date}，当日有效签到−有效签退）` : '；在室人数未知（当前无签到数据来源）';
  return `${src}${r.labName}：${r.statusLabel}，容量 ${r.capacity ?? '未知'}，${r.date}（${r.weekdayLabel}）${r.schedule.lessonCount} 条排课${next}${occupancy}`;
}

export function summarizeFreeRooms(r: FreeRoomsResult): string {
  const src = `【${DATA_SOURCE_LABELS[r.provenance.sourceType]}】`;
  if (r.coverage !== 'complete') {
    const why = r.coverage === 'missing' ? '课表数据为空' : r.coverage === 'out_of_range' ? '日期超出可信学期范围' : '教学周不可确定';
    return `${src}${why}，无法判断 ${r.date}（${r.weekdayLabel}）哪些房间空闲`;
  }
  const scope = r.periodFilter
    ? r.freeByPeriod[0].periodLabel
    : r.periodKeys.length && r.periodKeys.length < 6
      ? r.freeByPeriod.map((p) => p.periodLabel).join('/')
      : '全天各节次';
  const first = r.freeByPeriod[0];
  const total = r.freeByPeriod.reduce((n, p) => n + p.rooms.length, 0);
  return `${src}${r.date}（${r.weekdayLabel}）${scope}：仅列档案开放的房间，${first ? `首节次 ${first.rooms.length} 间空闲，合计 ${total} 房·次` : '无统计'}，另有 ${r.excluded.length} 间因档案关闭/停用排除`;
}

// ---- 兼容旧导出名（tests / 其他模块可能引用）----
export const summarize = summarizeSchedule;

function reasonText(r: ScheduleQueryResult): string {
  switch (r.reason) {
    case 'no_class_that_day':
      return `${r.weekdayLabel}当天无课${r.weekDeterminable ? '' : '（注意：教学周不可确定，结果未做周次过滤）'}`;
    case 'no_class_in_that_period':
      return `该节次（${r.periodFilter}）无课`;
    case 'lab_not_active':
      return `该房间当前状态非「开放」，且当天无排课`;
    case 'timetable_empty':
      return '系统内课表为空';
    default:
      return '无数据';
  }
}

/** 供调试/管理端使用：把可用房号压成一行可读文本 */
export function roomListHint(ds: Dataset): string {
  return `已收录房间号：${availableRoomNames(ds).join('、')}`;
}

/** Prompt, model tools and executor share this exact mode policy. */
export function toolsForMode(mode: 'chat' | 'task'): ToolSpec[] {
  const connected=isBusinessConnected();const role=effectiveRole('student');
  const sandbox=new Set(['prepare_issue_ticket','prepare_room_closure','prepare_notification','prepare_duty_session','create_operations_report']);
  return REGISTRY.filter(t => (mode === 'task' || t.effect === 'read')&&(!connected||!sandbox.has(t.spec.name))&&(!connected||role==='admin'||t.spec.name!=='prepare_schedule_adjustment'&&t.spec.name!=='prepare_incident_plan')).map(t => t.spec);
}
