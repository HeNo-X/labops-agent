/**
 * ASR 专有名词纠错（领域词典后处理）
 * ============================================================================
 *  为什么是"后处理"而不是"热词参数"：
 *  当前 ASR 走 `chat_audio`（input_audio 进 chat/completions），该协议**没有热词参数**；
 *  百炼侧的热词能力挂在别的通道上（即时热词仅 qwen-audio-3.0-asr-flash-filetrans；
 *  Paraformer 走 vocabId/AsrPhraseManager；应用配置页写明「除千问3-ASR-Flash-Realtime
 *  外均支持热词」）。要"传热词"就得换模型 + 换协议 + 改异步/上传链路，代价远大于收益。
 *
 *  而实验室场景的专有名词是**封闭集合**（房间号、班级名、课程名），
 *  用本地词典做确定性纠错，比热词更可控：热词只提高概率，不保证输出；纠错能给出确定结果，
 *  还能把"改了哪几处"如实回传，便于追溯。
 *
 *  设计原则（宁可不改，也不改错）：
 *  1) 房间号必须带字母前缀（E310 / D517）；裸数字一律不猜——那是日期、学号、容量的高发区
 *  2) 中文词条最短 4 字才参与纠错，避免把常用词改成罕见词
 *  3) 单次最多改 10 处；超出则整段放弃（宁可原样返回，也不做不可控改写）
 *  4) 每条改动都记录 from/to/kind/at，随响应回传
 */

export type TermKind = 'room' | 'class' | 'course';

export interface LexiconEntry {
  /** 标准写法，用于替换 */
  canonical: string;
  /** 归一化后的比较键 */
  norm: string;
  kind: TermKind;
}

export interface Correction {
  /** 原文里被替换的片段 */
  from: string;
  /** 替换成什么 */
  to: string;
  kind: TermKind;
  /** 在原文中的起始下标 */
  at: number;
}

export interface CorrectResult {
  text: string;
  corrections: Correction[];
  /** 因为超出改动上限而整段放弃 */
  aborted: boolean;
}

/** 中文数字 → 阿拉伯数字（房间号/班级名里数字段常见误识） */
const CN_DIGIT: Record<string, string> = {
  零: '0',
  〇: '0',
  // 「幺」是口语里最常见的「1」（报房间号几乎都会说幺），少了它整条纠错就失效
  幺: '1',
  一: '1',
  二: '2',
  两: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9'
};

/**
 * 归一化：全角转半角、小写、去掉空格与常见连接符、中文数字转阿拉伯数字。
 * 只用于"比较"，绝不用于输出 —— 输出永远用 canonical 或原文。
 */
export function normalizeForKey(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFKC').toLowerCase()) {
    const digit = CN_DIGIT[ch];
    out += digit ?? ch;
  }
  return out.replace(/[\s·・\-_—–/\\]/g, '');
}

/** 编辑距离（Levenshtein），带早期剪枝：长度差超过 max 直接返回 max+1 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** 从数据源构建词典（房间号 / 班级名 / 课程名），去重并保留原写法 */
export function buildLexicon(sources: {
  rooms?: readonly string[];
  classes?: readonly string[];
  courses?: readonly string[];
}): LexiconEntry[] {
  const seen = new Set<string>();
  const entries: LexiconEntry[] = [];
  const push = (raw: string | undefined, kind: TermKind): void => {
    const canonical = (raw ?? '').trim();
    if (!canonical) return;
    const norm = normalizeForKey(canonical);
    if (norm.length < 3) return;
    const key = `${kind}:${norm}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ canonical, norm, kind });
  };
  for (const room of sources.rooms ?? []) push(room, 'room');
  for (const name of sources.classes ?? []) push(name, 'class');
  for (const name of sources.courses ?? []) push(name, 'course');
  return entries;
}

/** 从数据集抽取词表。字段缺失一律跳过，不猜结构。 */
export function lexiconFromDataset(dataset: unknown): LexiconEntry[] {
  const ds = dataset as
    | {
        labs?: Array<{ name?: unknown }>;
        openLabs?: Array<{ name?: unknown }>;
        timetable?: Array<{ className?: unknown; classNames?: unknown; courseName?: unknown }>;
      }
    | null
    | undefined;
  if (!ds) return [];

  const rooms: string[] = [];
  for (const lab of [...(ds.labs ?? []), ...(ds.openLabs ?? [])]) {
    if (typeof lab?.name === 'string') rooms.push(lab.name);
  }

  const classes: string[] = [];
  const courses: string[] = [];
  for (const row of ds.timetable ?? []) {
    if (typeof row?.courseName === 'string') courses.push(row.courseName);
    if (typeof row?.className === 'string') classes.push(row.className);
    if (Array.isArray(row?.classNames)) {
      for (const name of row.classNames) if (typeof name === 'string') classes.push(name);
    }
  }

  return buildLexicon({ rooms, classes, courses });
}

/** 房间号候选：必须带 1~4 位字母前缀，后接 2~5 位数字或中文数字（含口语「幺」） */
const ROOM_CANDIDATE = /[A-Za-z]{1,4}[\s\-]?(?:\d{2,5}|[零〇幺一二三四五六七八九]{2,5})/g;

const MAX_CORRECTIONS = 10;
const MAX_CN_SCAN_CHARS = 1000;
const MIN_CN_TERM_LENGTH = 4;

interface Planned {
  at: number;
  length: number;
  correction: Correction;
}

/**
 * 对转写文本做专有名词纠错。
 * @param text ASR 原始文本
 * @param lexicon buildLexicon / lexiconFromDataset 的产物
 */
export function correctTranscript(text: string, lexicon: readonly LexiconEntry[]): CorrectResult {
  if (!text || !lexicon.length) return { text, corrections: [], aborted: false };

  const planned: Planned[] = [];
  const rooms = lexicon.filter((entry) => entry.kind === 'room');
  const words = lexicon.filter(
    (entry) => entry.kind !== 'room' && entry.canonical.length >= MIN_CN_TERM_LENGTH
  );

  // ---------- 第一遍：房间号（正则定位，永远不猜裸数字） ----------
  if (rooms.length) {
    for (const match of text.matchAll(ROOM_CANDIDATE)) {
      const raw = match[0];
      const at = match.index ?? 0;
      const key = normalizeForKey(raw);
      if (key.length < 3) continue;

      let best: LexiconEntry | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const entry of rooms) {
        if (entry.norm === key) {
          best = entry;
          bestDistance = 0;
          break;
        }
        // 长度 ≥4 才允许 1 位误差，且**必须等长**：
        // 允许插删会把「D51T」这种被正则截断的候选扩成「D517T」——凭空多一个字符，
        // 属于把对的改错，比不改更糟。等长替换（e31o→e310）才是真实误识形态。
        if (entry.norm.length >= 4 && key.length === entry.norm.length) {
          const distance = editDistance(key, entry.norm, 1);
          if (distance <= 1 && distance < bestDistance) {
            best = entry;
            bestDistance = distance;
          }
        }
      }
      if (!best) continue;
      if (raw === best.canonical) continue;
      planned.push({ at, length: raw.length, correction: { from: raw, to: best.canonical, kind: 'room', at } });
    }
  }

  // ---------- 第二遍：中文班级名/课程名（滑动窗口 + 编辑距离） ----------
  // 文本过长时跳过：这类文本本身不像一句口头指令，纠错收益低而代价高
  if (words.length && text.length <= MAX_CN_SCAN_CHARS) {
    const covered = (start: number, end: number): boolean =>
      planned.some((item) => start < item.at + item.length && end > item.at);

    for (const entry of words) {
      const sizes = [entry.canonical.length, entry.canonical.length - 1, entry.canonical.length + 1];
      // 词越短越容易撞车：4 字要求完全一致，5 字以上才容忍 1 字误差
      const tolerance = entry.norm.length >= 5 ? 1 : 0;
      let done = false;

      for (const size of sizes) {
        if (done || size < MIN_CN_TERM_LENGTH) continue;
        for (let start = 0; start + size <= text.length; start += 1) {
          const window = text.slice(start, start + size);
          const key = normalizeForKey(window);
          const exact = key === entry.norm;
          // 允许 1 字误差，但**只在归一后长度相等时**：
          // 否则「讲java程序设」这种多带一个邻字的窗口会被判成命中，把「讲」吞掉。
          const fuzzy =
            !exact && tolerance > 0 && key.length === entry.norm.length && editDistance(key, entry.norm, tolerance) <= tolerance;
          if (exact || fuzzy) {
            // 已经就是标准写法，不用改
            if (window === entry.canonical) done = true;
            else if (!covered(start, start + size)) {
              planned.push({
                at: start,
                length: size,
                correction: { from: window, to: entry.canonical, kind: entry.kind, at: start }
              });
              done = true;
            }
            break;
          }
        }
      }
    }
  }

  if (!planned.length) return { text, corrections: [], aborted: false };

  // 超出上限就整段放弃：不做"改一半"的不可控改写
  if (planned.length > MAX_CORRECTIONS) return { text, corrections: [], aborted: true };

  // 按位置去重（同一处只保留第一个），再从左到右应用
  planned.sort((a, b) => a.at - b.at || b.length - a.length);
  const applied: Planned[] = [];
  let cursor = -1;
  for (const item of planned) {
    if (item.at < cursor) continue;
    applied.push(item);
    cursor = item.at + item.length;
  }
  if (applied.length > MAX_CORRECTIONS) return { text, corrections: [], aborted: true };

  let output = '';
  let last = 0;
  for (const item of applied) {
    output += text.slice(last, item.at) + item.correction.to;
    last = item.at + item.length;
  }
  output += text.slice(last);

  return { text: output, corrections: applied.map((item) => item.correction), aborted: false };
}
