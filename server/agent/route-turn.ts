/**
 * 单一裁决点 routeTurn（整合方案 §4，2026-11-10）
 * ============================================================================
 *  现状：run.ts 里至少五处判断"这一问怎么答"（范围门控、寒暄、找空闲/房间状态
 *  不继承上下文、签到红线、单程往返白名单），散落的 if 彼此可能冲突、无法整体讲清。
 *  本模块把它们收敛成一个**纯函数**：run.ts 各处只读 routeTurn 的结果，
 *  只有一个地方决定。规则与现状逐点等值（tests/route-turn.test.ts 钉住命中与反例）。
 *
 *  与架构诊断"规则降级为提议者"一致：routeTurn 只做**安全相关的硬拦截**
 *  （签到红线、范围引导快速通道、寒暄白名单），语义理解仍交模型。
 */
import { classifyLabRequest, type DomainDecision } from './domain.ts';
import { FREE_ROOMS_RE, SMALLTALK_RE, LAB_STATUS_RE } from './demo-engine.ts';
import { refuseSignRequest } from './intent.ts';

export interface RouteInput {
  question: string;
  /** 会话/任务记忆里存在可承接的房间或任务 */
  hasContext: boolean;
  /** 该模式引擎形态（demo=确定性规则引擎） */
  engineDemo: boolean;
}

interface RouteCommon {
  /** 一句话解释为什么这么判（日志与评测可读） */
  reason: string;
  /** 寒暄/能力问句：不继承会话房间，兜底文案走问候语 */
  smalltalk: boolean;
  /** 找空闲或寒暄：会话承接不写房间槽位（范围语义不同） */
  roomless: boolean;
  /** N08 追问继承用：本轮问题指向的任务类型（找空闲/房间状态/课表；识别不出为 null） */
  taskHint: string | null;
  /** 单程往返白名单：本轮工具是否允许"一次调用即定稿"（答案=工具渲染，省第二次模型往返） */
  singlePassEligible: (toolName: string, callCount: number) => boolean;
}
/** 可辨识联合：kind 收窄后各分支只暴露该分支保证存在的字段（scopeAnswer/signRefusal 免断言） */
export type RouteResult =
  | { kind: 'scope'; domain: Exclude<DomainDecision, 'query'>; signRefusal: null } & RouteCommon
  | { kind: 'sign_refusal'; domain: 'query'; signRefusal: string } & RouteCommon
  | { kind: 'agent'; domain: 'query'; signRefusal: null } & RouteCommon;

const SINGLE_PASS_TOOLS = new Set([
  'query_schedule', 'query_checkin_status', 'query_checkin_summary',
  'query_vision_status', 'query_free_rooms', 'query_lab_status'
]);
const MULTI_INTENT_RE = /然后|再|顺便|以及|对比|分别|哪个更/;

export function routeTurn(i: RouteInput): RouteResult {
  const question = i.question;
  const domain = classifyLabRequest(question, i.hasContext);
  const smalltalk = SMALLTALK_RE.test(question.trim());
  const roomless = FREE_ROOMS_RE.test(question) || smalltalk;
  const taskHint = FREE_ROOMS_RE.test(question) ? 'free_rooms' : LAB_STATUS_RE.test(question) ? 'lab_status' : /(课|排课|课表)/.test(question) ? 'schedule' : null;
  const signRefusal = refuseSignRequest(question);
  const singlePassEligible = (toolName: string, callCount: number): boolean =>
    process.env['AGENT_SINGLE_PASS'] !== '0' &&
    callCount === 1 &&
    SINGLE_PASS_TOOLS.has(toolName) &&
    !MULTI_INTENT_RE.test(question);
  if (domain !== 'query') return { kind: 'scope', reason: `领域门控快速通道判为 ${domain}`, domain, smalltalk, roomless, taskHint, signRefusal: null, singlePassEligible };
  if (signRefusal) return { kind: 'sign_refusal', reason: '签到红线：代签/补录类请求确定性婉拒，不进模型不调工具', domain, smalltalk, roomless, taskHint, signRefusal, singlePassEligible };
  return { kind: 'agent', reason: i.engineDemo ? '演示引擎：规则引擎直接作答' : '语义判断归模型；规则仅保留安全硬拦截', domain, smalltalk, roomless, taskHint, signRefusal: null, singlePassEligible };
}
