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
 *  它不换的是数据层：数据仍然走 query_schedule，数据来源仍如实标注
 *  （脱敏快照 / 实时数据 / 模拟演示）。
 */

import type { QueryScheduleArgs, ScheduleQueryResult } from '../../shared/types.ts';
import type { Dataset } from '../data/store.ts';
import type { ServerNow } from '../time/term.ts';
import type { Intent } from './intent.ts';
import { executeTool } from '../tools/registry.ts';

export interface DemoPlan {
  /** 是否要调工具 */
  callTool: boolean;
  args: QueryScheduleArgs;
  /** 不调工具时直接给的话（越界/能力外问题） */
  directReply: string | null;
  needsDisclosure: string[];
}

const OUT_OF_SCOPE_PATTERNS: Array<[RegExp, string]> = [
  [/爬虫|爬取|抓取网页|批量注册|绕过|破解|刷量|外挂/, '这类需求超出本系统的能力与合规边界，我不能协助。'],
  [/通知|发公告|发布/, '第一阶段只做只读查询，发布通知属于写操作，尚未接入（界面上预留了确认位，但当前不会执行）。'],
  [
    /几个人|多少人|在室|人数|签到|签退|谁在/,
    '签到人数、在室人数属于记录类数据，第一阶段未接入（线上记录目前为空）。本阶段只能回答课表类问题。'
  ],
  [/钥匙|门禁/, '钥匙与门禁状态属于资产类数据，第一阶段未接入。'],
  [/值班|排班|志愿者名单/, '值班名册与排班属于人员类数据，第一阶段未接入。'],
  [/故障|怎么用|怎么办|规定|制度|手册|坏了/, '知识库问答（RAG）不在第一阶段范围内，尚未接入，所以我无法给出制度或手册类回答。'],
  [/去年|历史|平均使用率|趋势|统计/, '本系统只覆盖当前学期的课表数据，不含历史统计，我无法给出这类数字。']
];

export function planDemo(question: string, intent: Intent, ds: Dataset): DemoPlan {
  const q = String(question ?? '');

  for (const [re, reply] of OUT_OF_SCOPE_PATTERNS) {
    if (re.test(q)) {
      return {
        callTool: false,
        args: {},
        directReply: reply,
        needsDisclosure: ['本回答由服务端规则引擎给出，未调用大模型，也未查询课表']
      };
    }
  }

  if (!intent.labName) {
    return {
      callTool: false,
      args: {},
      directReply:
        '我没有识别到房间号。请把问题写得具体一点，例如「E310 2026-09-30 有哪些课？」。' +
        `系统当前收录的房间号有：${[...ds.labs, ...ds.openLabs].map((l) => l.name).join('、')}。`,
      needsDisclosure: ['未识别到房间号（本阶段必须给出房间号才能查）']
    };
  }

  return {
    callTool: true,
    args: {
      // 没识别到日期时不猜：交给工具用服务端当天，并在回答里显式声明这是缺省值
      ...(intent.date ? { date: intent.date.date } : {}),
      labName: intent.labName,
      ...(intent.periodKey ? { periodKey: intent.periodKey } : {})
    },
    directReply: null,
    needsDisclosure: intent.date ? [] : ['你没有说明日期，我按服务端当天处理']
  };
}

/** 规则引擎执行工具（与 Agnes 引擎共用同一份工具实现） */
export function runDemoTool(
  args: QueryScheduleArgs,
  ds: Dataset,
  now: ServerNow
): ReturnType<typeof executeTool> {
  return executeTool('query_schedule', args as unknown as Record<string, unknown>, { dataset: ds, now });
}

/** 把结构化结果渲染成可读回答（不调用模型） */
export function renderDemoAnswer(
  result: ScheduleQueryResult,
  extras: { dateWasDefaulted: boolean; periodFiltered: boolean }
): string {
  const lines: string[] = [];
  const weekText =
    result.weekNo === null ? '教学周无法确定' : `第 ${result.weekNo} 教学周（${result.weekNo % 2 === 1 ? '单周' : '双周'}）`;
  const head = `${result.date} ${result.weekdayLabel}，${weekText}`;

  if (result.reason === 'lab_not_found') {
    lines.push(`系统里没有收录这个房间号，所以查不到课表。`);
    lines.push(`可选的房间号：${result.suggestions.join('、') || '（当前未收录任何房间）'}`);
  } else if (result.lessons.length === 0) {
    const why =
      result.reason === 'no_class_in_that_period'
        ? `该节次没有课`
        : result.reason === 'lab_not_active'
          ? `该房间当前状态不是「开放」，且当天没有排课`
          : result.reason === 'timetable_empty'
            ? `系统内课表为空`
            : `当天没有排课`;
    lines.push(`${result.labName}（${result.labLocation ?? '位置未录入'}）在 ${head} 没有课。原因：${why}。`);
  } else {
    lines.push(`${result.labName}（${result.labLocation ?? '位置未录入'}）在 ${head} 共有 ${result.lessons.length} 条排课：`);
    for (const l of result.lessons) {
      const weeks =
        l.weeks.parity === 'odd' ? `第${l.weeks.from}-${l.weeks.to}周单周` : l.weeks.parity === 'even' ? `第${l.weeks.from}-${l.weeks.to}周双周` : `第${l.weeks.from}-${l.weeks.to}周`;
      lines.push(
        `· ${l.periodLabel} ${l.startTime}-${l.endTime}｜《${l.courseName}》｜${l.className}${l.merged ? '（合班）' : ''}｜${l.teacher}｜${weeks}`
      );
    }
  }

  if (extras.dateWasDefaulted) lines.push(`（你没有说明日期，以上按服务端当天 ${result.date} 计算）`);

  // 条件说明必须原样带出去，不能只在界面角落里显示
  for (const n of result.notes) lines.push(`— ${n}`);

  lines.push(`数据来源：${result.provenance.sourceLabel}。${result.provenance.coverage}`);
  if (result.provenance.snapshotAt) {
    lines.push(`快照导出于 ${result.provenance.snapshotAt}（非实时），查询执行于 ${result.provenance.queryTime}。`);
  } else {
    lines.push(`查询执行于 ${result.provenance.queryTime}。`);
  }
  return lines.join('\n');
}
