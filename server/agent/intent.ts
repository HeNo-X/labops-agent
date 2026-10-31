/**
 * 中文时间/房间指代解析 —— 服务端预解析（难点 3 的对策 1）
 * ============================================================================
 *  「本周三下午第二大节」这种话**绝不能让模型自己算**：模型跨周跨月算日期极易错。
 *  所以进模型之前先在这里解算成精确的 YYYY-MM-DD + periodKey，连同人话标注一起
 *  塞进上下文；模型只负责选工具、组织语言。
 *
 *  ⚠️ "本周"的定义必须钉死，否则全是歧义：
 *      教学周 = 从 termStart 起算的 7 天一块；termStart（2026-09-07）是周一。
 *      因此 **本周 = 含今天的那一教学周的周一 00:00 ~ 周日 23:59**。
 *      裸写的「周三」= 本周窗口内的周三（不是"最近的周三"）。
 *      要下周请说「下周三」。
 */

import type { PeriodKey } from '../../shared/periods.ts';
import { PERIODS, WEEKDAY_WORDS, periodByKey, WEEKDAY_LABELS } from '../../shared/periods.ts';
import type { ServerNow } from '../time/term.ts';
import { addDays, isValidDateString, weekdayOf } from '../time/term.ts';

export interface DateResolution {
  date: string;
  /** 命中的原文片段 */
  raw: string;
  /** 解算依据（人话，会注入模型上下文，便于排查） */
  source: string;
}

/** 显式非法的日期输入（如 2026-02-30 / 2026-13-01）——绝不允许静默回落到今天（F10） */
export interface DateInvalid {
  invalid: true;
  raw: string;
  reason: string;
}

export interface Intent {
  date: DateResolution | null;
  /** 用户写了日期但日期不合法 —— 优先级高于一切缺省/沿用逻辑 */
  dateInvalid: DateInvalid | null;
  /** 单一节次（与 periodKeys 二选一） */
  periodKey: PeriodKey | null;
  /** 节次范围（"上午"= am1+am2；"下午"= pm1+pm2；"晚上"= eve_ab+eve_cd）—— F12 */
  periodKeys: PeriodKey[] | null;
  labName: string | null;
  /** 上一问任务类型（由 run.ts 从会话上下文注入，N08 追问继承） */
  lastTask?: string | null;
  /** 解析过程中发现的歧义/降级说明 */
  notes: string[];
}

// ===========================================================================
//  日期
// ===========================================================================

/** 本周（周一~周日，与教学周对齐）的周一 */
export function mondayOfWeek(dateStr: string): string {
  const wd = weekdayOf(dateStr); // 0=周日
  const offset = wd === 0 ? -6 : 1 - wd; // 周日归到上一个周一那一周
  return addDays(dateStr, offset);
}

/** 把文本里所有"像日期"的片段先挖掉，避免后续房间号误匹配 */
function stripDateLike(text: string): string {
  return text
    .replace(/\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, ' ')
    .replace(/\d{1,2}\s*[-/]\s*\d{1,2}(?!\d)/g, ' ');
}

// N08："现在/此刻/当前"是显式时间条件，必须覆盖上下文里的历史日期
const NOW_WORDS = /现在|此刻|当前|目前|刚刚|这会儿|眼下/;

const REL_DAYS: Array<[RegExp, number, string]> = [
  [/前天/, -2, '前天 = 服务端当天 - 2 天'],
  [/昨天|昨日/, -1, '昨天 = 服务端当天 - 1 天'],
  [/今天|今日|本日|当天/, 0, '今天 = 服务端当天（Asia/Shanghai）'],
  [/明天|明日/, 1, '明天 = 服务端当天 + 1 天'],
  [/后天/, 2, '后天 = 服务端当天 + 2 天']
];

/**
 * 解析用户问题里的日期指代。解析不出来返回 null —— 由调用方决定是否回退到"今天"，
 * 绝不悄悄假定一个日期然后当成事实说出来。
 * 写了日期但日期非法（2026-02-30 / 2026-13-01）→ 返回 DateInvalid，调用方必须显式报错（F10）。
 */
export function resolveDate(text: string, now: ServerNow): DateResolution | DateInvalid | null {
  const t = String(text ?? '');

  // ① 绝对日期优先：2026-09-30 / 2026年9月30日 / 9月30日
  const abs = t.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
  if (abs) {
    const iso = `${abs[1]}-${abs[2].padStart(2, '0')}-${abs[3].padStart(2, '0')}`;
    if (isValidDateString(iso)) {
      return { date: iso, raw: abs[0], source: `识别为完整日期：${iso}` };
    }
    return {
      invalid: true,
      raw: abs[0],
      reason: `「${abs[0]}」不是真实存在的日期（${iso} 无效），请检查月份和日期后重试`
    };
  }
  const md = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (md) {
    const year = now.date.slice(0, 4);
    const iso = `${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
    if (isValidDateString(iso)) {
      return { date: iso, raw: md[0], source: `识别为「月日」形式，按当前年份 ${year} 补全：${iso}` };
    }
    return {
      invalid: true,
      raw: md[0],
      reason: `「${md[0]}」不是真实存在的日期（${iso} 无效），请检查后重试`
    };
  }

  const weekBase = mondayOfWeek(now.date);
  const weekWord = WEEKDAY_LABELS.map((l) => l.slice(1)).join('|'); // 日|一|二|三|四|五|六

  // ② 下周X / 上周X / 本周X / 周X / 星期X / 礼拜X
  const relWeek = t.match(new RegExp(`(下{1,2}|上{1,2}|本)?\\s*(?:周|星期|礼拜)\\s*([${weekWord}天])`));
  if (relWeek) {
    const which = relWeek[1] ?? '';
    const word = relWeek[2];
    const wd = WEEKDAY_WORDS[word];
    if (wd !== undefined) {
      const idxInWeek = wd === 0 ? 6 : wd - 1; // 周一是本周第 0 天
      let base = weekBase;
      let label = '本周（与教学周对齐，周一~周日）';
      if (which.startsWith('下')) {
        base = addDays(weekBase, 7 * (which.length >= 2 ? 2 : 1));
        label = which.length >= 2 ? '下下周' : '下周';
      } else if (which.startsWith('上')) {
        base = addDays(weekBase, -7 * (which.length >= 2 ? 2 : 1));
        label = which.length >= 2 ? '上上周' : '上周';
      } else if (!which) {
        label = '本周（裸写星期默认取本周，不是"最近的周三"）';
      }
      const date = addDays(base, idxInWeek);
      return { date, raw: relWeek[0], source: `${label}的${WEEKDAY_LABELS[wd]} → ${date}` };
    }
  }

  // ③ 相对日
  for (const [re, delta, src] of REL_DAYS) {
    if (re.test(t)) return { date: addDays(now.date, delta), raw: t.match(re)![0], source: src };
  }

  // ④ "现在"类指代：显式取服务端当天（N08），不允许沿用上一问的日期
  if (NOW_WORDS.test(t)) {
    return { date: now.date, raw: t.match(NOW_WORDS)![0], source: `「${t.match(NOW_WORDS)![0]}」= 服务端当前日期 ${now.date}（Asia/Shanghai）` };
  }

  return null;
}

// ===========================================================================
//  节次
// ===========================================================================

const PERIOD_PHRASES: Array<[RegExp, PeriodKey]> = [
  [/上午\s*第?\s*[一1]\s*大?节/, 'am1'],
  [/上午\s*第?\s*[二两2]\s*大?节/, 'am2'],
  [/下午\s*第?\s*[一1]\s*大?节/, 'pm1'],
  [/下午\s*第?\s*[二两2]\s*大?节/, 'pm2'],
  [/晚上\s*(?:AB|ab|A、?B)\s*节?/, 'eve_ab'],
  [/晚上\s*(?:CD|cd|C、?D)\s*节?/, 'eve_cd'],
  [/早\s*上\s*(?:第)?\s*[一1]\s*大?节/, 'am1'],
  [/第?\s*[一1]\s*大\s*节/, 'am1'],
  [/第?\s*[二两2]\s*大\s*节/, 'am2']
];

/** 直接写 key 也认 */
export function resolvePeriodKey(text: string): PeriodKey | null {
  const t = String(text ?? '');
  for (const [re, key] of PERIOD_PHRASES) if (re.test(t)) return key;
  for (const p of PERIODS) if (new RegExp(`\\b${p.key}\\b`).test(t)) return periodByKey(p.key)?.key ?? null;
  return null;
}

/**
 * 半天范围指代（F12）：上午=am1+am2，下午=pm1+pm2，晚上=eve_ab+eve_cd。
 * "上午第二大节"这类精确指代由 resolvePeriodKey 先命中，不走范围。
 */
const PERIOD_RANGE_PHRASES: Array<[RegExp, PeriodKey[]]> = [
  [/上午|早上|清晨|am/i, ['am1', 'am2']],
  [/下午|午后|pm/i, ['pm1', 'pm2']],
  [/晚上|晚间|夜里|晚上好/, ['eve_ab', 'eve_cd']]
];

export function resolvePeriodRange(text: string): PeriodKey[] | null {
  const t = String(text ?? '');
  // 精确节次优先：已经能定位单节次就不做范围放宽
  if (resolvePeriodKey(t)) return null;
  for (const [re, keys] of PERIOD_RANGE_PHRASES) if (re.test(t)) return [...keys];
  return null;
}

// ===========================================================================
//  房间号
// ===========================================================================

/** E310 / D517 / UB201 这类：1~3 个字母 + 3~4 位数字 */
const LAB_CODE_RE = /(?<![A-Za-z0-9])([A-Za-z]{1,3})\s?-?\s?(\d{3,4})(?![0-9])/g;

/**
 * A7：无字母前缀的裸房间号（用户口语"310有人吗"，真实房间是 E310）。
 * 只取 3 位连续数字——4 位几乎都是年份/时间；前后不得再贴字母数字
 * （字母前缀形态归 LAB_CODE_RE 管，更长数字串是编号/年份不是房间）。
 * 返回的是"候选"而非定论：工具层按系统收录的房间做后缀解析，
 * 唯一命中自动收敛并如实标注，多个命中如实报歧义，零个报查无此房间。
 */
const BARE_ROOM_RE = /(?<![A-Za-z0-9])(\d{3})(?![0-9])/g;

export function resolveLabName(text: string): string | null {
  const cleaned = stripDateLike(String(text ?? ''));
  const hits = [...cleaned.matchAll(LAB_CODE_RE)]
    .map((m) => `${m[1].toUpperCase()}${m[2]}`)
    // 纯 4 位数字（无字母前缀）已由正则排除；过滤掉显然是时间的 4 位数
    .filter((s) => !/^\d{4}$/.test(s));
  if (hits.length) return hits[0];
  const bare = cleaned.match(BARE_ROOM_RE);
  return bare ? bare[0] : null;
}

export function resolveAllLabNames(text: string): string[] {
  const cleaned = stripDateLike(String(text ?? ''));
  const out = new Set<string>();
  for (const m of cleaned.matchAll(LAB_CODE_RE)) out.add(`${m[1].toUpperCase()}${m[2]}`);
  return [...out];
}

// ===========================================================================
//  汇总
// ===========================================================================

export function parseIntent(text: string, now: ServerNow): Intent {
  text=text.replace(/(?:fact-|plan-|business-plan-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,' ');
  const notes: string[] = [];
  const rawDate = resolveDate(text, now);
  const dateInvalid = rawDate && 'invalid' in rawDate ? rawDate : null;
  const date = rawDate && !('invalid' in rawDate) ? rawDate : null;
  const periodKey = resolvePeriodKey(text);
  const periodKeys = periodKey ? null : resolvePeriodRange(text);
  const labName = resolveLabName(text);

  if (dateInvalid) notes.push(`日期输入非法：${dateInvalid.reason}`);
  if (!date && !dateInvalid) notes.push('未识别到日期指代 → 缺省按服务端当天处理，并在上下文里标明这是缺省值');
  if (labName && !date && !dateInvalid) notes.push(`识别到房间号 ${labName}，但未识别到日期`);
  // A7：裸数字候选不是定论——工具层按系统收录的房间做后缀解析，唯一命中会如实标注
  if (labName && /^\d/.test(labName)) notes.push(`房间号 ${labName} 未带字母前缀，将按系统收录的房间推断（如 310 → E310）`);
  if (periodKeys) notes.push(`识别到时间范围（${periodKeys.join('/')}）——"整个范围都空闲"与"其中一节空闲"含义不同，需按口径处理`);

  return { date, dateInvalid, periodKey, periodKeys, labName, notes };
}

/** 给模型看的"当前时间与指代解算"上下文块（人话，省 token 且模型理解更准） */
export function buildTimeContext(now: ServerNow, intent: Intent, weekNote: string): string {
  const lines = [
    `【服务端当前时间】${now.iso}（时区 Asia/Shanghai）。今天是 ${now.date}，${now.weekdayLabel}。`,
    `【教学周】${weekNote}`,
    `【"本周"的定义】含今天的那一教学周的周一~周日；裸写"周三"指本周三。`
  ];
  if (intent.date) {
    lines.push(
      `【已解算的日期指代】用户说的「${intent.date.raw}」= ${intent.date.date}（${WEEKDAY_LABELS[weekdayOf(intent.date.date)]}）。依据：${intent.date.source}`
    );
  } else if (intent.dateInvalid) {
    lines.push(`【非法日期】用户写的 ${intent.dateInvalid.raw} 不是合法日期。请提示用户修正，不要按今天处理，也不要调用工具。`);
  } else {
    lines.push(`【日期指代】用户没有明确说日期。若需要日期，请用 ${now.date}（今天）。`);
  }
  if (intent.labName) lines.push(`【已识别的房间号】${intent.labName}`);
  if (intent.periodKey) lines.push(`【已识别的节次】${intent.periodKey}`);
  if (intent.periodKeys) lines.push(`【已识别的节次范围】${intent.periodKeys.join('、')}`);
  return lines.join('\n');
}
