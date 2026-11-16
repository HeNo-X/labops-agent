/**
 * 中文时间/房间指代解析 —— 服务端预解析
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

/** 显式非法的日期输入（如 2026-02-30 / 2026-13-01）——绝不允许静默回落到今天 */
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
  /** 节次范围（"上午"= am1+am2；"下午"= pm1+pm2；"晚上"= eve_ab+eve_cd） */
  periodKeys: PeriodKey[] | null;
  labName: string | null;
  /** 按班级查（"智能本2501班"）—— 与 labName 二选一 */
  className: string | null;
  /** 上下文线索。carried 线索**只进这里、不写槽位**——沿用与否由模型结合上文判断。 */
  hints?: IntentHint[];
  /** 上一问任务类型（由 run.ts 从会话上下文注入，供追问继承） */
  lastTask?: string | null;
  /** 一句多问（"周一上二…周三早八和下一"）：每段各自的日期与节次，供只读组合逐段查询 */
  timeSegments?: TimeSegment[];
  /** 解析过程中发现的歧义/降级说明 */
  notes: string[];
}

/** 一句多问里的一个"日期+节次"片段（多段问句按段保存，不合并成一个大范围） */
export interface TimeSegment {
  /** 原文片段，便于把依据说清 */
  raw: string;
  /** YYYY-MM-DD */
  date: string;
  periodKeys: PeriodKey[];
}

/** 规则只做提议者：每条线索都带来源与一句话依据 */
export interface IntentHint {
  slot: 'date' | 'labName' | 'periodKey' | 'className';
  value: string;
  /** explicit=本轮明说；carried=来自上一问；inferred=按规则推断；resolved=唯一匹配补全 */
  origin: 'explicit' | 'carried' | 'inferred' | 'resolved';
  /** 给人看的一句话说明——模型必须能读到"这是猜的还是用户说的" */
  basis: string;
}

/**
 * 签到红线：Agent **不得**帮学生补录/代签。
 * 确定性拦截而非靠模型自觉——保证这类请求得到一致的婉拒，而不是答非所问。
 * 误报防线：纯查询（查/看/情况/记录/汇总/统计）不命中动作子句。
 */
export function refuseSignRequest(question: string): string | null {
  const q = String(question ?? '');
  const refusal = '这个我做不了：学生签到必须由本人扫码完成，我不能代签或代为补录。如确需补录，请由管理员在主系统的签到管理中按代录流程办理。';
  // 第一类：动作词无歧义（签上到/签个到/代签/补录）——即使句子里带"查"也婉拒
  if (/(签上到|签个到|代签|补录签到|补录.*签到)/.test(q)) return refusal;
  // 第二类："给/替/帮/把/请 + 短宾语 + 签到/签个到"的祈使句式——必须排除查询语（查/情况/记录/汇总…）
  const actionSign = /((给|替|帮|把|请)[^，。？！]{1,12}(同学|学生)[^，.？！]{0,10}(签到|签个到))|((给|替|帮|把)[^，.？！]{1,12}(签到|签个到))/;
  const queryish = /(查|看一下|情况|记录|汇总|统计|多少|名单|谁|哪些)/;
  if (actionSign.test(q) && !queryish.test(q)) return refusal;
  return null;
}

const HINT_SLOT_LABEL: Record<IntentHint['slot'], string> = { date: '日期', labName: '房间', periodKey: '节次', className: '班级' };
const HINT_ORIGIN_LABEL: Record<IntentHint['origin'], string> = {
  explicit: 'explicit，用户本轮明确说的',
  carried: 'carried，来自上一问',
  inferred: 'inferred，按规则推断',
  resolved: 'resolved，按唯一匹配补全'
};

/**
 * 会话承接：上一问的房间/日期在 hints 模式下**只写线索不写槽位**，
 * 沿用与否由模型判断；legacy 模式（CONTEXT_HINTS=0）直接把承接值写入槽位。
 * 纪律：找空闲房间/寒暄不承接；非法日期绝不承接；班级明确时与房间互斥。
 */
export function applySessionCarry(
  intent: Intent,
  sess: { labName: string | null; date: string | null; question?: string } | null,
  opts: { roomlessIntent: boolean; hintsMode: boolean }
): void {
  if (!sess) return;
  const classIntent = Boolean(intent.className);
  if (opts.roomlessIntent || classIntent || intent.dateInvalid) return;
  const from = sess.question ? `（来自「${sess.question.slice(0, 40)}」）` : '';
  if (!intent.labName && sess.labName) {
    if (opts.hintsMode) {
      (intent.hints ??= []).push({
        slot: 'labName',
        value: sess.labName,
        origin: 'carried',
        basis: `用户本轮没写房间。上一问用的是 ${sess.labName}${from}。若沿用，必须在回答里说明"按上一问的房间 ${sess.labName} 计算"；若判断与本问无关就不要采用。`
      });
    } else {
      intent.labName = sess.labName;
      intent.notes.push(`未识别到房间号，沿用上一问的 ${sess.labName}`);
    }
  }
  if (!intent.date && sess.date) {
    if (opts.hintsMode) {
      (intent.hints ??= []).push({
        slot: 'date',
        value: sess.date,
        origin: 'carried',
        basis: `用户本轮没写日期。上一问用的是 ${sess.date}${from}。若沿用，必须在回答里说明"按上一问的日期 ${sess.date} 计算"；若判断与本问无关就不要采用。`
      });
    } else {
      intent.date = { date: sess.date, raw: '（沿用上一问）', source: `本轮未识别到日期指代，沿用上一问的 ${sess.date}` };
      intent.notes.push(`未识别到日期指代，沿用上一问的 ${sess.date}`);
    }
  }
  // 节次（periodKey/periodKeys）不沿用 —— 过滤过强容易把"换个房间再问"变成"查不到"，宁缺勿错
}

/**
 * 确定性规则引擎（无模型）没有"结合上文判断"的能力——把 carried 线索
 * 落回槽位，行为与 legacy 直接写槽位一致。
 */
export function applyHintsToSlots(intent: Intent): void {
  for (const h of intent.hints ?? []) {
    if (h.origin !== 'carried') continue;
    if (h.slot === 'labName' && !intent.labName) {
      intent.labName = h.value;
      intent.notes.push(`未识别到房间号，沿用上一问的 ${h.value}`);
    }
    if (h.slot === 'date' && !intent.date) {
      intent.date = { date: h.value, raw: '（沿用上一问）', source: `本轮未识别到日期指代，沿用上一问的 ${h.value}` };
      intent.notes.push(`未识别到日期指代，沿用上一问的 ${h.value}`);
    }
  }
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

// "现在/此刻/当前"是显式时间条件，必须覆盖上下文里的历史日期
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
 * 写了日期但日期非法（2026-02-30 / 2026-13-01）→ 返回 DateInvalid，调用方必须显式报错。
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

  // ④ "现在"类指代：显式取服务端当天，不允许沿用上一问的日期
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


/**
 * 节次编号口径（务必照此实现）：
 *   上午第一大节=第1-2节　上午第二大节=第3-4节
 *   下午第一大节=第5-6节　下午第二大节=第7-8节
 *   晚上AB节=第AB节　　　　晚上CD节=第CD节
 * 单说「第5节」「第7节」分别归属 56 节、78 节。
 * 缩写：上一=上午第一大节、下二=下午第二大节、早八=第1-2节。
 * 注意「上一/下一」是口语缩写，不是"上一个"，做否定前瞻避免误伤。
 */
const NUM_TO_PERIOD: Record<number, PeriodKey> = {
  1: 'am1', 2: 'am1', 3: 'am2', 4: 'am2',
  5: 'pm1', 6: 'pm1', 7: 'pm2', 8: 'pm2'
};

const PERIOD_COMBO: Array<[RegExp, PeriodKey]> = [
  [/第?\s*12\s*节/, 'am1'],
  [/第?\s*34\s*节/, 'am2'],
  [/第?\s*56\s*节/, 'pm1'],
  [/第?\s*78\s*节/, 'pm2']
];

const PERIOD_ABBR: Array<[RegExp, PeriodKey]> = [
  [/早\s*八/, 'am1'],
  [/上\s*一(?!\s*[个次步页])/, 'am1'],
  [/上\s*二/, 'am2'],
  [/下\s*一(?!\s*[个次步页])/, 'pm1'],
  [/下\s*二/, 'pm2'],
  [/(?:^|[^A-Za-z])AB\s*节?/i, 'eve_ab'],
  [/(?:^|[^A-Za-z])CD\s*节?/i, 'eve_cd']
];

/** 把文字里的节次指代解析成有序、去重的 PeriodKey 列表（解析不出返回 []） */
export function resolveNumericPeriods(text: string): PeriodKey[] {
  const t = String(text ?? '');
  const keys: PeriodKey[] = [];
  const push = (k: PeriodKey): void => {
    if (!keys.includes(k)) keys.push(k);
  };

  for (const [re, key] of PERIOD_ABBR) if (re.test(t)) push(key);
  for (const [re, key] of PERIOD_COMBO) if (re.test(t)) push(key);

  // 范围：5-6节、5~6节、5到6节 → 展开区间内的每一节
  for (const m of t.matchAll(/第?\s*([1-8])\s*(?:[-~—–]|至|到)\s*([1-8])\s*节/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let n = lo; n <= hi; n += 1) push(NUM_TO_PERIOD[n]!);
  }
  // 并列：5、7节 / 5，7节 / 5和7节 → **只取这两个端点**，不做区间展开
  // （"第1、7节"是"第1节和第7节"，不是 1~7 全部，展开会把结果放宽 4 倍）
  for (const m of t.matchAll(/第?\s*([1-8])\s*(?:、|,|，|和|与)\s*([1-8])\s*节/g)) {
    push(NUM_TO_PERIOD[Number(m[1])]!);
    push(NUM_TO_PERIOD[Number(m[2])]!);
  }
  // 单节：第5节 / 5节 / 第7节
  for (const m of t.matchAll(/第?\s*([1-8])\s*节/g)) push(NUM_TO_PERIOD[Number(m[1])]!);
  return keys;
}

/** 直接写 key 也认 */
export function resolvePeriodKey(text: string): PeriodKey | null {
  const t = String(text ?? '');
  for (const [re, key] of PERIOD_PHRASES) if (re.test(t)) return key;
  for (const p of PERIODS) if (new RegExp(`\\b${p.key}\\b`).test(t)) return periodByKey(p.key)?.key ?? null;
  // 数字/组合/缩写（第5节、56节、上一、早八…）：恰好命中一个节次才算单节
  const numeric = resolveNumericPeriods(t);
  if (numeric.length === 1) return numeric[0]!;
  return null;
}

/**
 * 半天范围指代：上午=am1+am2，下午=pm1+pm2，晚上=eve_ab+eve_cd。
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
  // 跨大节（5、7节）或多节并列：按 PERIODS 顺序返回
  const numeric = resolveNumericPeriods(t);
  if (numeric.length > 1) return PERIODS.map((p) => p.key).filter((k) => numeric.includes(k));
  return null;
}

/**
 * 一句多问拆段
 * ============================================================================
 *  「周一上二应该是哪两个志愿者值班？周三早八和下一呢」里有两个日期、三个节次缩写。
 *  若把整句交给 resolvePeriodKey/resolvePeriodRange：三个节次会被合并成一个
 *  "时间范围 am1/am2/pm1"，日期只剩第一个「周一」——于是模型无法按段查询，
 *  最终只回一句"请说明房间、日期或要办理的事项"。
 *
 *  这里按问号/句号/分号拆句，每句独立解算日期与节次；后句省略日期时承接前句。
 *  拆不出来（没有日期、没有节次）就不产出片段，交回原有单日期逻辑，不猜。
 */
export function resolveTimeSegments(text: string, now: ServerNow): TimeSegment[] {
  const clauses = String(text ?? '')
    .split(/[。？！?！;；\n]+/)
    // 没有标点也用「和/以及/还有」连接两段时（"周一上二和周三早八"）：
    // 在下一个日期词出现前切开，避免把周三的节次算到周一头上
    .flatMap((part) => part.split(/(?=(?:下{1,2}|上{1,2}|本)?(?:周|星期|礼拜)[一二三四五六日天])/))
    .map((s) => s.trim())
    .filter(Boolean);
  const out: TimeSegment[] = [];
  let carriedDate: string | null = null;
  for (const clause of clauses) {
    const resolved = resolveDate(clause, now);
    const date: string | null = resolved && !('invalid' in resolved) ? resolved.date : carriedDate;
    if (date) carriedDate = date;
    if (!date) continue;
    const numeric = resolveNumericPeriods(clause);
    const keys = numeric.length ? numeric : (resolvePeriodRange(clause) ?? []);
    if (!keys.length) continue;
    out.push({ raw: clause, date, periodKeys: [...new Set(keys)] });
  }
  return out;
}


// ===========================================================================
//  输入归一化：容忍全角、大小写、OCR 混淆与高频错别字
// ===========================================================================
/**
 * 用户是"说话/打字"的，不是"填表单"的。这里只做**高置信、可逆**的修正：
 *   · 全角转半角、字母统一大写（Ｅ３１２ → E312）
 *   · 房间号数字段里的字形混淆（O→0、I/l→1、S→5、B→8）：E31O → E310
 *   · 高频错别字（实验事/实验市/实验窒 → 实验室）
 * 低置信或会改变语义的一律不动（例如把"教室"当错字），宁可不修也不猜。
 * 每次修正都记进 notes，回答里可以如实说"我把 X 理解成了 Y"。
 */
const TYPO_MAP: Array<[RegExp, string, string]> = [
  [/实验事/g, '实验室', '实验事→实验室'],
  [/实验市/g, '实验室', '实验市→实验室'],
  [/实验窒/g, '实验室', '实验窒→实验室'],
  [/实验实/g, '实验室', '实验实→实验室']
];

export function normalizeQuery(raw: string): { text: string; fixes: string[] } {
  const fixes: string[] = [];
  let t = String(raw ?? '');

  // ① 全角 → 半角（含全角数字/字母/标点）
  const half = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
  if (half !== t) { fixes.push('全角转半角'); t = half; }

  // ② 房间号：字母前缀后数字段的字形混淆
  t = t.replace(/([A-Za-z]{1,3})\s?-?\s?([0-9OoIlSsBb]{3,4})(?![0-9])/g, (_all, prefix: string, digits: string) => {
    const fixed = digits
      .replace(/[Oo]/g, '0')
      .replace(/[Il]/g, '1')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8');
    if (fixed !== digits) { fixes.push(`房间号字形修正：${prefix}${digits}→${prefix}${fixed}`); }
    return `${prefix.toUpperCase()}${fixed}`;
  });

  // ③ 高频错别字
  for (const [re, to, label] of TYPO_MAP) {
    if (re.test(t)) { t = t.replace(re, to); fixes.push(label); }
    re.lastIndex = 0;
  }
  return { text: t, fixes };
}

// ===========================================================================
//  房间号
// ===========================================================================

/** E310 / D517 / UB201 这类：1~3 个字母 + 3~4 位数字 */
const LAB_CODE_RE = /(?<![A-Za-z0-9])([A-Za-z]{1,3})\s?-?\s?(\d{3,4})(?![0-9])/g;

/**
 * 无字母前缀的裸房间号（用户口语"310有人吗"，真实房间是 E310）。
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
  const normalized = normalizeQuery(text);
  text = normalized.text;
  text=text.replace(/(?:fact-|plan-|business-plan-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,' ');
  const notes: string[] = [...normalized.fixes.map((f) => `已自动修正：${f}`)];
  const rawDate = resolveDate(text, now);
  const dateInvalid = rawDate && 'invalid' in rawDate ? rawDate : null;
  const date = rawDate && !('invalid' in rawDate) ? rawDate : null;
  const periodKey = resolvePeriodKey(text);
  const periodKeys = periodKey ? null : resolvePeriodRange(text);
  const labName = resolveLabName(text);
  // 多段问句（"周一上二…周三早八和下一"）：≥2 段才附上，单段仍走原有单日期路径
  const segments = resolveTimeSegments(text, now);
  const timeSegments = segments.length >= 2 ? segments : undefined;

  // 兜底：问题里出现「XX班」就认定他在按班级问，不依赖模型自觉填 className
  // 只取"数字前最多 6 个字"作专业前缀，再剥掉动词/指代（查一下、那、的…），
  // 否则「查找一下智能本2501班」会被连成「查找一下智能本2501」。
  const stripLead = (v: string): string =>
    v.replace(/^(?:麻烦|请|帮我|我|想|要|查一下|看一下|一下|查|看|问|找|那|这|个|的|是|和|与|在|给|把|们|班|有|课|上)+/, '');
  const withSuffix = text.match(/([A-Za-z\u4e00-\u9fa5]{0,6}?)(\d{2,4})\s*班/);
  // 没有"班"字也认（「计本2501下二有课吗」）：要求 4 位数字 + 前面 2~4 个中文，
  // 且后面不跟 年月日级（避免把 2026 年这类日期当班级）。
  const bareClass = withSuffix ? null : text.match(/([\u4e00-\u9fa5]{2,4})(\d{4})(?![\d年月日级号])/);
  const matched = withSuffix ?? bareClass;
  const className = matched ? `${stripLead(matched[1]!)}${matched[2]}`.trim() || null : null;

  if (dateInvalid) notes.push(`日期输入非法：${dateInvalid.reason}`);
  if (!date && !dateInvalid) notes.push('未识别到日期指代 → 缺省按服务端当天处理，并在上下文里标明这是缺省值');
  if (labName && !date && !dateInvalid) notes.push(`识别到房间号 ${labName}，但未识别到日期`);
  // 裸数字候选不是定论——工具层按系统收录的房间做后缀解析，唯一命中会如实标注
  if (labName && /^\d/.test(labName)) notes.push(`房间号 ${labName} 未带字母前缀，将按系统收录的房间推断（如 310 → E310）`);
  if (periodKeys) notes.push(`识别到时间范围（${periodKeys.join('/')}）——"整个范围都空闲"与"其中一节空闲"含义不同，需按口径处理`);

  if (className) notes.push(`识别到班级「${className}」——按班级查课表，不需要房间号`);
  return { date, dateInvalid, periodKey, periodKeys, labName, className, notes, ...(timeSegments ? { timeSegments } : {}) };
}

/** 给模型看的"当前时间与指代解算"上下文块（人话，省 token 且模型理解更准） */
export function buildTimeContext(now: ServerNow, intent: Intent, weekNote: string): string {
  const lines = [
    `【服务端当前时间】${now.iso}（时区 Asia/Shanghai）。今天是 ${now.date}，${now.weekdayLabel}。`,
    `【教学周】${weekNote}`,
    `【"本周"的定义】含今天的那一教学周的周一~周日；裸写"周三"指本周三。`
  ];
  if (intent.className) {
    lines.push(`【按班级查询】用户提到了班级「${intent.className}」：调用 query_schedule 时请传 className="${intent.className}"（不要传 labName）。`);
  }
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
  if (intent.timeSegments?.length) {
    lines.push('【本句包含多个"日期+节次"】这不是一个时间范围，请按段分别查询，每段一次工具调用：');
    intent.timeSegments.forEach((s, i) => {
      const label = s.periodKeys.map((k) => periodByKey(k)?.label ?? k).join('、');
      // 只注入解算结果，不回显用户原文（避免把任意文本带进系统上下文）
      lines.push(`- 第 ${i + 1} 段：${s.date}（${WEEKDAY_LABELS[weekdayOf(s.date)]}）${label}`);
    });
  }

  // 有线索时追加"线索不是结论"块——规则摊开依据，沿用与否由模型判断
  const hints = intent.hints ?? [];
  if (hints.length) {
    lines.push(`【本句可用的线索】（这些是**线索不是结论**，你可以不采纳）`);
    for (const h of hints) {
      lines.push(`- ${HINT_SLOT_LABEL[h.slot]}：${h.basis}（${HINT_ORIGIN_LABEL[h.origin]}）`);
    }
    const hasCarried = hints.some((h) => h.origin === 'carried');
    if (hasCarried) {
      lines.push(`【沿用纪律】若本次日期/房间/节次不是用户本轮明确说的，而是你按上下文沿用的，正文必须出现一句依据说明（例如"按上一问的 2026-11-10 计算"）；没有这句依据就不要沿用。`);
    }
    if (intent.className && hasCarried) {
      lines.push(`【规则】班级与房间互斥：用户明确说了班级，就不要把上一问的房间带进来。`);
    }
  }
  return lines.join('\n');
}
