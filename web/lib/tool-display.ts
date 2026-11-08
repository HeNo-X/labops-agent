/**
 * 工具展示模型 —— 把一次工具调用归一成"该长什么样"的展示决策
 * ============================================================================
 *  设计依据：运行态用动作名（"正在读取 · x"），终态用类别名（"读取 · x"）；
 *  收起态必须**显式覆盖全部终态**（成功/未成功/执行中/已取消），非成功终态
 *  绝不允许落进成功文案；display 文本有**显式字符预算**，截断要标记 truncated，
 *  展开态必须提示已截断（不能让用户以为看到的是全文）。
 *
 *  ⚠️ 不持久化 display：LabOps 的 ToolCallRecord 已经是服务端结构化事实
 *  （tool/args/ok/ms/summary/resultKind/result），再存一层 display 是冗余。
 *  这里只做**前端派生**，不新增服务端契约。
 *
 *  纯函数、无 Vue 依赖 —— 可直接单测。
 */

export type ToolFamily = 'query' | 'knowledge' | 'draft' | 'vision' | 'field' | 'report' | 'plan' | 'unknown';

/**
 * 展示文本预算（**字符数**，不是字节数 —— 中文按字符计，UTF-8 下 1 字 3 字节）。
 * 为什么 output 是 2000：知识检索/课表摘要的正常完整长度在 1–2K 字符内，
 * 超过它多半是整表或整篇文档被塞进了摘要 —— 那属于"结果卡/引用链接"该承担的
 * 内容，塞进轨迹只会把对话刷屏。2000 字符 ≈ 一屏半，够看清结论又不至于埋掉正文。
 */
export const DISPLAY_TEXT_BUDGET = {
  /** 摘要主体一行：约等于一句中文结论 */
  primary: 80,
  /** 展开态看到的工具输出全文 */
  output: 2000,
  /** 错误信息（含堆栈式说明时容易很长，但必须能看到真正原因） */
  error: 4096
} as const;

export function clampText(s: string, n: number): { text: string; truncated: boolean } {
  if (typeof s !== 'string') return { text: '', truncated: false };
  // 用 Array.from 按码点切分：避免把 emoji / 生僻字劈成半个代理对
  const chars = Array.from(s);
  if (chars.length <= n) return { text: s, truncated: false };
  return { text: chars.slice(0, n).join(''), truncated: true };
}

/** 工具 → 展示族。唯一事实源是 server/tools/registry.ts 的 toolNames()（23 个：12 read + 10 draft + 1 任务计划）。 */
const FAMILY_BY_TOOL: Record<string, ToolFamily> = {
  // 查询类（只读，结构化结果由结果卡承担）
  query_schedule: 'query',
  query_lab_status: 'query',
  query_free_rooms: 'query',
  query_incident: 'query',
  query_business_context: 'query',
  query_scheduled_jobs: 'query',
  query_duty_context: 'query',
  query_checkin_status: 'query',
  query_checkin_summary: 'query',
  // 学期安排 / 周值班模板（读）/ 唯一写工具（写）
  query_term_schedule: 'query',
  apply_term_schedule: 'draft',
  query_checkin_records: 'query',
  query_openlab_records: 'query',
  query_key_records: 'query',
  // 知识检索
  query_knowledge: 'knowledge',
  // 草稿类（effect:'draft'，只生成待确认方案，绝不自行执行）
  prepare_incident_plan: 'draft',
  prepare_business_workflow: 'draft',
  prepare_scheduled_job: 'draft',
  prepare_schedule_adjustment: 'draft',
  prepare_issue_ticket: 'draft',
  prepare_room_closure: 'draft',
  prepare_room_status: 'draft',
  prepare_notification: 'draft',
  prepare_duty_session: 'draft',
  // 视觉观察（完整内容由 EvidenceObservationCard 承担）
  analyze_evidence_image: 'vision',
  // 视觉边缘现场事实（数量/命中，剥离身份；完整内容由监控页承担）
  query_vision_status: 'field',
  // 日报
  create_operations_report: 'report',
  // A5 任务计划（工作记录，不是业务结果；完整内容由 PlanPanel 承担）
  maintain_task_plan: 'plan'
};

export function toolFamily(tool: string): ToolFamily {
  return FAMILY_BY_TOOL[tool] ?? 'unknown';
}

/** 运行态动作名（"正在查询课表"）/ 终态类别名（"课表查询"）—— 每族一对 */
const FAMILY_LABELS: Record<Exclude<ToolFamily, 'unknown'>, { running: string; final: string }> = {
  query: { running: '正在查询', final: '查询' },
  knowledge: { running: '正在检索说明', final: '说明检索' },
  draft: { running: '正在准备办理单', final: '待确认办理单' },
  vision: { running: '正在读取照片', final: '照片观察' },
  field: { running: '正在读取现场事实', final: '现场事实' },
  report: { running: '正在生成日报', final: '运营日报' },
  plan: { running: '正在更新任务计划', final: '任务计划' }
};

export function familyLabel(family: ToolFamily, running: boolean): string {
  if (family === 'unknown') return running ? '正在执行' : '执行';
  return running ? FAMILY_LABELS[family].running : FAMILY_LABELS[family].final;
}

/**
 * 终态文案表 —— 四种状态**逐一列全**，缺一项单测即失败。
 * 非成功终态不得借用成功文案。
 */
export type ToolTerminalState = 'ok' | 'failed' | 'running' | 'cancelled';

export function terminalStateOf(ok: boolean | null, cancelled = false): ToolTerminalState {
  if (cancelled) return 'cancelled';
  if (ok === null) return 'running';
  return ok ? 'ok' : 'failed';
}

export const TERMINAL_LABELS: Record<ToolTerminalState, string> = {
  ok: '成功',
  failed: '未成功',
  running: '执行中',
  cancelled: '已取消'
};

/** 每族收起态的补充说明（不重复正文，只说明"这一族的结果去哪看"） */
const FAMILY_HINTS: Partial<Record<ToolFamily, string>> = {
  draft: '未执行，等你确认',
  vision: '结构化观察，非人工核验',
  report: '完整日报见下方卡片'
};

export interface ToolCallLike {
  tool: string;
  args?: Record<string, unknown>;
  ok: boolean | null;
  ms?: number;
  summary?: string;
  error?: { code: string; message: string };
  resultKind?: string;
}

export interface ToolDisplayModel {
  family: ToolFamily;
  /** 动作名（运行中）与类别名（终态） */
  runningLabel: string;
  finalLabel: string;
  /** 一行摘要主体（已按 primary 预算截断，截断时以省略号收尾） */
  primaryText: string;
  /** 摘要主体是否被截断（UI 以省略号 + 展开提示表达，不静默丢信息） */
  primaryTruncated: boolean;
  /** 该族是否值得展示参数（草稿/查询值得，视觉只关心附件编号） */
  showInput: boolean;
  showOutput: boolean;
  /** 展开态输出（已按 output 预算截断，truncated 必须提示用户） */
  output?: { text: string; truncated: boolean };
  /** 收起态补充说明（如"未执行，等你确认"） */
  hint?: string;
  state: ToolTerminalState;
  stateLabel: string;
}

function argsBrief(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : String(v)}`)
    .join('，');
}

export function buildToolDisplay(t: ToolCallLike, opts: { running: boolean }): ToolDisplayModel {
  const family = toolFamily(t.tool);
  const state = opts.running ? 'running' : terminalStateOf(t.ok);
  const raw = t.ok === false ? `${t.error?.code ?? 'error'}：${t.error?.message ?? ''}` : (t.summary ?? '');
  const primarySource = raw || argsBrief(t.args);
  const primary = clampText(primarySource, DISPLAY_TEXT_BUDGET.primary);
  const output = raw ? clampText(raw, DISPLAY_TEXT_BUDGET.output) : undefined;

  return {
    family,
    runningLabel: familyLabel(family, true),
    finalLabel: familyLabel(family, false),
    primaryText: primary.text || (family === 'unknown' ? `执行 ${t.tool}` : ''),
    primaryTruncated: primary.truncated,
    showInput: family !== 'vision',
    showOutput: Boolean(output),
    output,
    // 失败时不给任何"结果去哪看"的引导 —— 那不是成功的说明
    hint: t.ok === false ? undefined : FAMILY_HINTS[family],
    state,
    stateLabel: TERMINAL_LABELS[state]
  };
}
