/**
 * 自动化模块的展示层纯函数
 * ============================================================================
 *  为什么单独抽出来：
 *  原来的 ScheduledJobsPanel.vue 里，"触发方式翻成人话""状态翻成中文""时间格式化"
 *  三件事散落在模板表达式中，无法单测、PC/移动端各写一遍、改一处忘一处。
 *  这里收成无副作用的纯函数 —— 可单测、PC 与移动端共用同一份口径。
 *
 *  刻意不依赖 vue / 不依赖 @shared，方便直接跑 node --test。
 */

import type { ScheduledSpec } from './scheduled-form';

export type JobStatus =
  | 'active'
  | 'completed'
  | 'paused'
  | 'suspended'
  | 'archived'
  | 'needs_authorization'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'unknown';

export interface StatusMeta {
  /** 中文标签 */
  label: string;
  /** 视觉分组，配合 glyph 使用，避免只靠颜色区分 */
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted';
  /** 形状符号：色盲/单色打印也能分辨 */
  glyph: string;
}

const STATUS: Record<JobStatus, StatusMeta> = {
  active: { label: '运行中', tone: 'ok', glyph: '✓' },
  completed: { label: '已完成', tone: 'muted', glyph: '✓' },
  paused: { label: '已暂停', tone: 'muted', glyph: '⏸' },
  suspended: { label: '已暂停（连续失败）', tone: 'danger', glyph: '✕' },
  archived: { label: '已归档', tone: 'muted', glyph: '▤' },
  needs_authorization: { label: '需重新授权', tone: 'warn', glyph: '⚠' },
  pending: { label: '待执行', tone: 'info', glyph: '◷' },
  running: { label: '执行中', tone: 'info', glyph: '◌' },
  success: { label: '成功', tone: 'ok', glyph: '✓' },
  failed: { label: '失败', tone: 'danger', glyph: '✕' },
  skipped: { label: '已跳过', tone: 'muted', glyph: '—' },
  unknown: { label: '对账中', tone: 'warn', glyph: '?' }
};

export function statusMeta(status: string | null | undefined): StatusMeta {
  return STATUS[(status ?? 'unknown') as JobStatus] ?? STATUS.unknown;
}

/** 哪些状态算"开着"，用于开关的选中态 */
export function isOn(status: string | null | undefined): boolean {
  return status === 'active' || status === 'pending' || status === 'running';
}

/** 开关是否可操作：归档/已完成的规则不允许再开 */
export function canToggle(status: string | null | undefined): boolean {
  return status !== 'archived' && status !== 'completed' && status !== 'needs_authorization';
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function hhmm(value: unknown): string {
  const text = String(value ?? '');
  return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : text;
}

function weekdaysText(raw: unknown): string {
  const list = Array.isArray(raw) ? raw.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  if (!list.length) return '';
  const sorted = [...new Set(list)].sort((a, b) => a - b);
  if (sorted.length === 7) return '每天';
  if (sorted.length === 5 && sorted.every((d) => d >= 1 && d <= 5)) return '工作日';
  if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) return '周末';
  return sorted.map((d) => WEEKDAY[d]).join('、');
}

/** 把 trigger 翻成一句人话。这是"用户唯一需要读懂的东西"，必须准确。 */
export function triggerText(spec: Pick<ScheduledSpec, 'trigger'>): string {
  const t = (spec.trigger ?? {}) as Record<string, unknown>;
  switch (String(t['type'] ?? '')) {
    case 'daily':
      return `每天 ${hhmm(t['time'])}`;
    case 'weekly': {
      const days = weekdaysText(t['weekdays']);
      return days ? `${days} ${hhmm(t['time'])}` : `每周 ${hhmm(t['time'])}`;
    }
    case 'once': {
      const at = String(t['at'] ?? '');
      return at ? `仅一次 ${formatDateTime(at)}` : '仅一次（未指定时间）';
    }
    case 'cron':
      return `自定义 Cron：${String(t['expression'] ?? '')}`;
    case 'duty':
      return `正式班次前 ${Number(t['minutesBefore'] ?? 0)} 分钟`;
    default:
      return '未设置触发时间';
  }
}

/** 校历策略 */
export function calendarText(policy: string | null | undefined): string {
  return policy === 'teaching_days' ? '仅教学日' : '按自然日';
}

/** 接收对象人话 */
export function recipientsText(recipients: Array<Record<string, string>> | undefined): string {
  const list = recipients ?? [];
  if (!list.length) return '未设置接收人';
  if (list.length > 3) return `${list.length} 个接收对象`;
  return list
    .map((r) => {
      if (r['kind'] === 'user') return `本人（${r['userId'] ?? ''}）`;
      if (r['kind'] === 'role') return r['role'] === 'volunteer' ? '全体志愿者' : `全体${r['role'] ?? ''}`;
      if (r['kind'] === 'class') return `班级 ${r['className'] ?? ''}`;
      if (r['kind'] === 'all') return '全体成员';
      return String(r['kind'] ?? '未知对象');
    })
    .join('、');
}

/** 效果人话：report=生成报告，inbox=投递站内信 */
export function effectsText(effects: string[] | undefined): string {
  const list = effects ?? [];
  const out: string[] = [];
  if (list.includes('report')) out.push('生成报告');
  if (list.includes('inbox')) out.push('投递站内通知');
  return out.length ? out.join(' + ') : '无输出';
}

/** 以 Asia/Shanghai 输出的可读时间 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '无';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d);
}

/**
 * 「下次运行」的相对描述 —— 主流 Agent APP 的列表卡片都靠这个表达"还活着"。
 * 只在能可靠比较时给相对值，否则退回绝对时间，绝不猜。
 */
export function nextRunText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '无后续运行';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return String(iso);
  const diff = at - now;
  if (diff < -60_000) return `已逾期（${formatDateTime(iso)}）`;
  // 不足一分钟必须说"即将"，不能四舍五入成"1 分钟后"骗人
  if (diff < 60_000) return '即将运行';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.round(hours / 24);
  if (days === 1) return '明天';
  if (days < 7) return `${days} 天后`;
  return formatDateTime(iso);
}

/** 模板的一句话说明 —— 让用户在"选模板"这一步就知道后果，而不是看参数名 */
export const KIND_HINT: Record<string, string> = {
  daily_report: '汇总当日值班、报修、通知，生成当天日报',
  weekly_report: '汇总本周运营情况，生成周报',
  tomorrow_courses: '明天有哪些课、哪些教室要用，提前告知',
  duty_reminder: '正式班次开始前提醒值班人员',
  due_followup: '工单超过时限仍未处理时提醒跟进',
  resource_risk: '房间设备或容量出现风险时提醒',
  closure_expiry: '临时停用即将到期时提醒复核',
  notice_reminder: '有未读通知时提醒本人'
};

export function kindHint(kind: string | null | undefined): string {
  return KIND_HINT[String(kind ?? '')] ?? '按模板规则运行';
}

/** 表单里"更多设置"之外，用户最少需要提供的可见字段 */
export interface SimpleForm {
  kind: string;
  triggerType: 'daily' | 'weekly' | 'once' | 'duty';
  time: string;
  weekdays: number[];
  at: string;
  minutesBefore: number;
}

/** 新建时的默认值：与 newSpec() 保持一致的时间口径 */
export function defaultSimpleForm(kind = 'daily_report'): SimpleForm {
  return { kind, triggerType: 'daily', time: '20:30', weekdays: [1], at: '', minutesBefore: 30 };
}
