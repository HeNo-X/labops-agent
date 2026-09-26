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

import type { QueryScheduleArgs, ScheduleQueryResult } from '../../shared/types.ts';
import type { Dataset } from '../data/store.ts';
import type { ServerNow } from '../time/term.ts';
import type { Intent } from './intent.ts';
import { executeTool } from '../tools/registry.ts';
import type { ToolResultKind } from '../../shared/types.ts';

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
  [/通知|发公告|发布/, '第一阶段只做只读查询，发布通知属于写操作，尚未接入。'],
  [
    /几个人|多少人|在室|签到|签退|谁在/,
    '在室人数、签到记录属于记录类数据，本阶段未接入（没有数据来源），我无法提供，也不能估计。'
  ],
  [/钥匙|门禁/, '钥匙与门禁状态属于资产类数据，本阶段未接入。'],
  [/值班|排班|志愿者名单/, '值班名册与排班属于人员类数据，本阶段未接入。'],
  [/故障|怎么用|怎么办|规定|制度|手册|坏了/, '知识库问答（RAG）不在本阶段范围内，尚未接入，所以我无法给出制度或手册类回答。'],
  [/去年|历史|平均使用率|趋势|统计/, '本系统只覆盖当前学期的课表数据，不含历史统计，我无法给出这类数字。']
];

/** 「哪些房间空着/找空教室」类问题：不需要房间号 */
const FREE_ROOMS_RE = /哪些.{0,6}(空|闲)|空(着|的|教室|实验室|房间)|空闲|没(有)?被占用|可以(用|借)/;
/** 房间档案/状态类问题：需要房间号，且在问开放/容量/位置等 */
const LAB_STATUS_RE = /开放吗|开(着|放)吗|还开|状态|容量|多大|能坐|位置|在哪|什么情况|简介|介绍|下一?节/;

export function planDemo(question: string, intent: Intent, ds: Dataset): DemoPlan {
  const q = String(question ?? '');

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

  // ---- 找空房间：不要求房间号 ----
  if (FREE_ROOMS_RE.test(q)) {
    const disclosures = intent.date ? [] : ['你没有说明日期，我按服务端当天处理'];
    for (const n of intent.notes) if (n.includes('沿用')) disclosures.push(n);
    return {
      tool: 'query_free_rooms',
      callTool: true,
      args: {
        ...(intent.date ? { date: intent.date.date } : {}),
        ...(intent.periodKey ? { periodKey: intent.periodKey } : {})
      },
      directReply: null,
      needsDisclosure: disclosures
    };
  }

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
  return {
    tool: 'query_schedule',
    callTool: true,
    args: {
      // 没识别到日期时不猜：交给工具用服务端当天，并在回答里显式声明这是缺省值
      ...(intent.date ? { date: intent.date.date } : {}),
      labName: intent.labName,
      ...(intent.periodKey ? { periodKey: intent.periodKey } : {})
    } satisfies QueryScheduleArgs,
    directReply: null,
    needsDisclosure: disclosures
  };
}

/** 规则引擎执行工具（与 Agnes 引擎共用同一份注册表实现） */
export function runDemoTool(
  tool: string,
  args: Record<string, unknown>,
  ds: Dataset,
  now: ServerNow
): ReturnType<typeof executeTool> {
  return executeTool(tool, args, { dataset: ds, now });
}

/** 把结构化结果渲染成可读回答（不调用模型）。**结论式短文案**：明细指向结构化结果卡，不逐条重复 */
export function renderDemoAnswer(
  result: ScheduleQueryResult | { kind: ToolResultKind; payload: unknown },
  extras: { dateWasDefaulted: boolean; periodFiltered: boolean }
): string {
  if ('kind' in result) {
    if (result.kind === 'lab_status') return renderLabStatusAnswer(result.payload as never);
    if (result.kind === 'free_rooms') return renderFreeRoomsAnswer(result.payload as never);
  }
  return renderScheduleAnswer(result, extras);
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
    const why =
      result.reason === 'no_class_in_that_period'
        ? '该节次没有课'
        : result.reason === 'lab_not_active'
          ? '该房间当前状态不是「开放」，且当天没有排课'
          : result.reason === 'timetable_empty'
            ? '系统内课表为空'
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

function renderLabStatusAnswer(r: import('../../shared/types.ts').LabStatusResult): string {
  if (r.labName === null) {
    return `系统里没有收录这个房间号。可选的房间号：${r.suggestions.join('、') || '（当前未收录任何房间）'}。`;
  }
  const lines: string[] = [];
  lines.push(
    `${r.labName}（${r.labLocation ?? '位置未录入'}）当前状态「${r.statusLabel}」，容量 ${r.capacity ?? '未知'} 人。${r.date}（${r.weekdayLabel}）有 ${r.schedule.lessonCount} 条排课。`
  );
  if (r.schedule.nextLesson) {
    lines.push(`下一节是 ${r.schedule.nextLesson.startTime} 的《${r.schedule.nextLesson.courseName}》（${r.schedule.nextLesson.periodLabel}）。`);
  } else if (r.schedule.lessonCount > 0) {
    lines.push('当天剩余时间没有更多排课。');
  }
  lines.push('在室人数：未知 —— 系统没有签到/门禁数据来源，无法提供，请勿据此判断房间内是否有人。');
  return lines.join('\n');
}

function renderFreeRoomsAnswer(r: import('../../shared/types.ts').FreeRoomsResult): string {
  const lines: string[] = [];
  const scope = r.periodFilter
    ? `${r.freeByPeriod[0].periodLabel}（${r.freeByPeriod[0].startTime}-${r.freeByPeriod[0].endTime}）`
    : '全天各节次';
  lines.push(`${r.date}（${r.weekdayLabel}）${scope}的空闲房间：`);
  for (const p of r.freeByPeriod) {
    lines.push(
      `· ${p.periodLabel}：${p.rooms.length ? p.rooms.map((x) => `${x.labName}${x.status === 'active' ? '' : `（${x.status === 'inactive' ? '停用' : '关闭'}）`}`).join('、') : '无空闲房间'}`
    );
  }
  lines.push('说明：「空闲」指课表上无排课，不代表室内无人。');
  return lines.join('\n');
}
