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

export type TermKind = 'room' | 'class' | 'course' | 'term';

export interface LexiconEntry {
  /** 标准写法，用于替换 */
  canonical: string;
  /** 归一化后的比较键 */
  norm: string;
  kind: TermKind;
  /**
   * Tier B 专用：逐字无声调音节的连写（如「移液枪」→ yiyeqiang）。
   * 有它才允许 2–3 字短词参与纠错，且只接受**完全同音**；没有它的条目维持原来的
   * ≥4 字 + 等长编辑距离 ≤1 规则，一字不改。
   */
  sy?: string;
  /** Tier B 专用：已登记的同音/近音误写，做表层精确替换 */
  aliases?: string[];
  /** Tier B 专用：后邻这些字时不改（同音串只是另一个词的开头，如「门进入」） */
  blockAfter?: string[];
}

export interface Correction {
  /** 原文里被替换的片段 */
  from: string;
  /** 替换成什么 */
  to: string;
  kind: TermKind;
  /** 在原文中的起始下标 */
  at: number;
  /**
   * 靠什么判定的。回传给界面与评测，是为了让"这条改动有多硬"可审计：
   * exact/alias 是确定命中，distance 是等长一字之差，syllable 是完全同音。
   */
  via: 'exact' | 'distance' | 'syllable' | 'alias';
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
/**
 * 第三遍（同音）的最短长度。之所以敢比 MIN_CN_TERM_LENGTH 低两档：
 * 它要求**逐字完全同音**，而不是字符距离接近 —— 约束强得多。
 * 但单字仍然排除在外：一个音节对应的候选字实在太多，没有区分度。
 */
const MIN_SYLLABLE_TERM_LENGTH = 2;

interface Planned {
  at: number;
  length: number;
  correction: Correction;
}

/** Tier B 同音纠错需要的三份外部数据，都由 asr-glossary 派生，本模块保持纯函数、不自己读文件 */
export interface CorrectOptions {
  /** 汉字 → 无声调音节。表里没有的字 → 该窗口直接不改（未知即不改） */
  syllables?: ReadonlyMap<string, string>;
  /** 与术语同音的常用词（保修/登机/教室…），命中即整窗不改 */
  protect?: ReadonlySet<string>;
  /** 一个音节串对应多个标准词的歧义键，整键跳过 —— 同音歧义下任何选择都是猜 */
  ambiguous?: ReadonlySet<string>;
}

/**
 * 把一段窗口按字查音节。任一字不在表里就返回 null（不改）。
 * ASCII 字母按字面小写返回，对应「晚上AB节」「文渊E区」里那几个拉丁段的音节；
 * 代理对（罕见，emoji 等）直接判 null，避免下标错位。
 */
function windowSyllables(text: string, at: number, size: number, table: ReadonlyMap<string, string>): string | null {
  let out = '';
  for (let i = at; i < at + size; i += 1) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) return null; // 非 BMP，跳过
    if (/[a-z]/i.test(ch)) {
      out += ch.toLowerCase();
      continue;
    }
    const syllable = table.get(ch);
    if (!syllable) return null; // 未知字 → 整个窗口不参与
    out += syllable;
  }
  return out;
}

/** 同音串是否只是另一个词的开头（「门进」+「入」） */
function blockedAt(text: string, at: number, length: number, entry: LexiconEntry): boolean {
  const next = text[at + length];
  if (next === undefined) return false;
  return (entry.blockAfter ?? []).includes(next);
}

/** 找出 word 在 text 里的所有起点（简单 indexOf 循环，语音短句长度上限 1000 内足够） */
function findAll(text: string, word: string): number[] {
  const hits: number[] = [];
  if (!word) return hits;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) hits.push(at);
  return hits;
}

/**
 * 对转写文本做专有名词纠错。
 * @param text ASR 原始文本
 * @param lexicon buildLexicon / lexiconFromDataset / 术语表转换的产物
 * @param opts Tier B 同音纠错所需三份数据；不传则**只做原来的 Tier A 规则**，行为与升级前一致
 */
export function correctTranscript(text: string, lexicon: readonly LexiconEntry[], opts: CorrectOptions = {}): CorrectResult {
  if (!text || !lexicon.length) return { text, corrections: [], aborted: false };

  const planned: Planned[] = [];
  /** 已经被占用的区间不再改，避免两遍规则叠在同一处反复替换 */
  const covered = (start: number, end: number): boolean =>
    planned.some((item) => start < item.at + item.length && end > item.at);
  const push = (at: number, length: number, to: string, kind: TermKind, via: Correction['via']): void => {
    if (covered(at, at + length)) return;
    planned.push({ at, length, correction: { from: text.slice(at, at + length), to, kind, at, via } });
  };

  const rooms = lexicon.filter((entry) => entry.kind === 'room' && !entry.sy);
  // 带 sy 的条目走第三遍，不参与"≥4 字 + 等长距离"那条老路
  const words = lexicon.filter(
    (entry) => entry.kind !== 'room' && !entry.sy && entry.canonical.length >= MIN_CN_TERM_LENGTH
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
      push(at, raw.length, best.canonical, 'room', best.norm === key ? 'exact' : 'distance');
    }
  }

  // ---------- 第二遍：中文班级名/课程名（滑动窗口 + 编辑距离）----------
  // 文本过长时跳过：这类文本本身不像一句口头指令，纠错收益低而代价高
  if (words.length && text.length <= MAX_CN_SCAN_CHARS) {
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
            else {
              push(start, size, entry.canonical, entry.kind, exact ? 'exact' : 'distance');
              done = true;
            }
            break;
          }
        }
      }
    }
  }

  // ---------- 第三遍：Tier B 同音纠错（器材/操作/节次/单据，2 字起）----------
  // 这是唯一被允许降到 2 字门槛的路径，因为它要求**完全同音**，而不是字符距离接近。
  // 四道闸门，任一不过就不改：歧义音节键 → 保护词 → 未知字 → 邻接阻断。
  const termEntries = lexicon.filter((entry) => entry.sy && entry.kind !== 'room');
  if (termEntries.length && opts.syllables?.size && text.length <= MAX_CN_SCAN_CHARS) {
    const table = opts.syllables;
    const ambiguous = opts.ambiguous ?? new Set<string>();
    const protect = opts.protect ?? new Set<string>();

    for (const entry of termEntries) {
      const sy = entry.sy!;
      // ① 同音歧义键整键跳过：一个读音对应多个标准词时，选谁都等于在猜
      if (ambiguous.has(sy)) continue;

      // ② 别名：表层精确替换。命中即改——别名是我们逐条人工保证过的真实误写形态
      for (const alias of entry.aliases ?? []) {
        if (!alias || alias === entry.canonical || protect.has(alias)) continue;
        for (const at of findAll(text, alias)) {
          if (blockedAt(text, at, alias.length, entry)) continue;
          push(at, alias.length, entry.canonical, entry.kind, 'alias');
        }
      }

      // ③ 音节滑窗：定长、逐字可查、连读完全等于 sy 才改
      const size = Array.from(entry.canonical).length;
      if (size < MIN_SYLLABLE_TERM_LENGTH) continue; // 单字绝不参与（同音字海了去了）
      for (let at = 0; at + size <= text.length; at += 1) {
        const window = text.slice(at, at + size);
        if (window === entry.canonical) continue; // 本来就是对的
        if (protect.has(window)) continue; // ④ 同音常用词，永不替换
        if (blockedAt(text, at, size, entry)) continue;
        const key = windowSyllables(text, at, size, table);
        if (key !== sy) continue; // 含表外字 → key=null → 不改
        push(at, size, entry.canonical, entry.kind, 'syllable');
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
