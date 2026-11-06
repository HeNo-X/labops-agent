/**
 * 实验室术语表（Tier B）装载、校验与上下文构造
 * ============================================================================
 *  与 asr-lexicon.ts 的分工：
 *    · Tier A（asr-lexicon.lexiconFromDataset）—— 从数据集自动来的**封闭集合**
 *      （房间号 / 班级名 / 课程名），只认字符编辑距离，长度门槛维持 ≥4。
 *    · Tier B（本文件）—— 人工维护的实验室通用词（器材 / 操作 / 节次 / 单据），
 *      每条自带**逐字无声调音节**，因此敢参与 2–3 字短词纠错（B3 落地）。
 *
 *  为什么拼音是「数据」而不是「算法」：
 *    本项目零运行时依赖，不能引 pinyin 库。把音节随词条写死，既免依赖，
 *    又能人工复核 —— 而且能强制「音节数 == 字数」这条硬不变量（见 validateGlossary）。
 *    ⚠ 音节写错会**静默让该词永不被纠正**，所以校验器必须跑在 CI 里。
 *
 *  为什么 aliases 允许近音、syll 不允许：
 *    aliases 只做**精确串匹配**，命中即改、不命中不改，零推断风险，所以前后鼻音、
 *    平翘舌这类真实混淆写法可以列进来。syll 参与音节对齐，必须是严格同音，
 *    混进近音就会把对的词改错 —— 那是不可接受的（宁可不改，也不改错）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.ts';
import { normalizeForKey, type LexiconEntry } from './asr-lexicon.ts';

export type AsrDomain = 'equipment' | 'check' | 'place' | 'operation' | 'period' | 'document';

export interface GlossaryTerm {
  /** 标准写法，纠错时作为替换目标 */
  canonical: string;
  /** 逐字无声调音节，与 canonical 的码点 1:1 对齐；非汉字段原样小写保留（如「晚上AB节」的 a/b） */
  syll: string[];
  /** syll 的连写，装载时派生，匹配用 */
  sy: string;
  /** 已知的同音/近音误写；只做精确串匹配 */
  aliases: string[];
  /** 1–5，语义对齐上游热词权重（5 最强）；为后续 vocabulary 通道预留 */
  weight: number;
  domain: AsrDomain;
  /**
   * 后邻这些字时**整窗不改**。中文没有词边界，同音串常常只是另一个词的开头：
   * 「门进入」里的"门进"不是门禁，「检查标准」里的"检查标"不是检查表。
   */
  blockAfter: string[];
}

export interface GlossaryData {
  terms: GlossaryTerm[];
  /**
   * 与术语同音的**高频常用词**，永不允许被替换。
   * ⚠ 删别名并不解决这件事：音节匹配本来就是"任何同音串都可能命中"，
   *   所以 保修/报修、登机/登记、教室/教师 这类冲突必须显式挡住，而不是指望别名表干净。
   */
  protect: string[];
}

export interface GlossaryFile {
  version: number;
  domains: string[];
  protect?: string[];
  terms: GlossaryTerm[];
}

const GLOSSARY_PATH = path.join(PROJECT_ROOT, 'shared', 'asr-glossary.json');
const VALID_DOMAINS: readonly string[] = ['equipment', 'check', 'place', 'operation', 'period', 'document'];

/** 装载术语表 + 保护词表。形状不符即抛 —— 静默返回空表会让"术语表没生效"变成隐形故障。 */
export function loadGlossaryData(file = GLOSSARY_PATH): GlossaryData {
  if (!fs.existsSync(file)) {
    throw new Error(`缺少术语表文件：${path.relative(PROJECT_ROOT, file)}（B1 产物，不可缺失）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`术语表 JSON 解析失败：${(err as Error).message}`);
  }
  const root = raw as { version?: unknown; protect?: unknown; terms?: unknown };
  if (!Array.isArray(root.terms)) throw new Error('术语表缺少 terms 数组');
  const terms: GlossaryTerm[] = [];
  for (const item of root.terms as unknown[]) {
    const t = item as Record<string, unknown>;
    const canonical = typeof t['canonical'] === 'string' ? t['canonical'].trim() : '';
    const syll = Array.isArray(t['syll']) ? (t['syll'] as unknown[]).map((s) => (typeof s === 'string' ? s : '')) : [];
    const aliases = Array.isArray(t['aliases']) ? (t['aliases'] as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim() !== '') : [];
    const blockAfter = Array.isArray(t['blockAfter'])
      ? (t['blockAfter'] as unknown[]).filter((c): c is string => typeof c === 'string' && Array.from(c).length === 1)
      : [];
    const weight = typeof t['weight'] === 'number' ? t['weight'] : 0;
    const domain = typeof t['domain'] === 'string' ? t['domain'] : '';
    if (!canonical) throw new Error('术语表条目缺 canonical');
    if (!VALID_DOMAINS.includes(domain)) throw new Error(`术语表条目 ${canonical} 的 domain 非法：${domain || '(空)'}`);
    terms.push({ canonical, syll, sy: syll.join(''), aliases, weight, domain: domain as AsrDomain, blockAfter });
  }
  const protect = Array.isArray(root.protect)
    ? [...new Set((root.protect as unknown[]).filter((p): p is string => typeof p === 'string' && Array.from(p).length >= 2))]
    : [];
  // 装载即自检：坏表不许上线（B1 的验收硬条件之一）
  const problems = validateGlossary(terms);
  if (problems.length) throw new Error(`术语表校验未通过（${problems.length} 项）：\n  ${problems.slice(0, 20).join('\n  ')}`);
  // protect 里若有串正好等于某标准词，会把该词自己的纠错也挡掉 —— 属于自废武功
  const clash = protect.filter((p) => terms.some((t) => t.canonical === p));
  if (clash.length) throw new Error(`protect 含与标准词同名的串，会挡住它自己的纠错：${clash.join('、')}`);
  return { terms, protect };
}

/** 只要词条（需要 protect 时改用 loadGlossaryData） */
export function loadGlossary(file = GLOSSARY_PATH): GlossaryTerm[] {
  return loadGlossaryData(file).terms;
}

/**
 * 校验清单。返回问题描述数组，空数组 = 干净。
 * 只报"会静默失效"或"会造成误改"的问题，不做风格审查。
 */
export function validateGlossary(terms: readonly GlossaryTerm[]): string[] {
  const problems: string[] = [];
  const seenCanonical = new Map<string, number>();
  const bySyllable = new Map<string, string[]>();

  for (const t of terms) {
    const chars = Array.from(t.canonical);
    if (chars.length !== t.syll.length) {
      problems.push(`${t.canonical}: 字数 ${chars.length} 与音节数 ${t.syll.length} 不等（该词将无法被音节匹配）`);
    }
    if (t.syll.some((s) => !/^[a-z]+$/.test(s))) {
      problems.push(`${t.canonical}: 含非小写字母音节（${t.syll.filter((s) => !/^[a-z]+$/.test(s)).join(',')}）`);
    }
    if (t.weight < 1 || t.weight > 5) problems.push(`${t.canonical}: weight=${t.weight} 不在 1–5`);
    if (!VALID_DOMAINS.includes(t.domain)) problems.push(`${t.canonical}: domain=${t.domain} 非法`);

    seenCanonical.set(t.canonical, (seenCanonical.get(t.canonical) ?? 0) + 1);
    const key = t.syll.join('');
    bySyllable.set(key, (bySyllable.get(key) ?? []).concat(t.canonical));

    for (const a of t.aliases) {
      if (a === t.canonical) problems.push(`${t.canonical}: 别名与标准词相同（无意义且会自环）`);
    }
  }

  for (const [c, n] of seenCanonical) if (n > 1) problems.push(`${c}: 重复出现 ${n} 次`);

  // 别名撞上别的标准词：改到一半可能把 A 的词面换成 B 的标准词，属于矛盾表，必须人工裁决
  const canonSet = new Set(terms.map((t) => t.canonical));
  for (const t of terms) {
    for (const a of t.aliases) if (canonSet.has(a) && a !== t.canonical) {
      problems.push(`${t.canonical}: 别名「${a}」本身是另一个标准词（矛盾，需人工裁决）`);
    }
  }

  return problems;
}

/** sy → 词条（同音不同词的歧义键会在这里显形） */
export function syllableIndex(terms: readonly GlossaryTerm[]): Map<string, GlossaryTerm[]> {
  const index = new Map<string, GlossaryTerm[]>();
  for (const t of terms) {
    const key = t.sy;
    const list = index.get(key);
    if (list) list.push(t);
    else index.set(key, [t]);
  }
  return index;
}

/**
 * 歧义音节键：一个音节串对应 ≥2 个标准词。
 * B3 的短词纠错**必须跳过这些键** —— 同音歧义下任何选择都是在猜，猜错就是把对的改错。
 * 返回空集是好事，但"空"不等于"以后也空"，所以匹配器必须每次都问一遍，不能省。
 */
export function ambiguousSyllables(terms: readonly GlossaryTerm[]): Set<string> {
  const ambiguous = new Set<string>();
  for (const [key, list] of syllableIndex(terms)) if (list.length > 1) ambiguous.add(key);
  return ambiguous;
}

/**
 * 汉字 → 音节 的最小音表，**只从 canonical 逐字对齐 syll**。
 * 覆盖范围 = 表里出现过的字，不是全汉字表，所以能内置、零依赖。
 * 同字多音的冲突字整字丢弃：未知字 → 该窗口不参与短词纠错（宁可漏改，不可错改）。
 *
 * ⚠ 为什么不从 aliases 派生（听起来能扩覆盖，实际是坑）：
 *   别名允许**近音**误写（前后鼻音、平翘舌），一旦逐字对齐就会污染字表 ——
 *     「投印仪」会把 印 标成 ying（真实读音 yin）；
 *     「地烙铁」会把 地 标成 dian（真实读音 di）。
 *   字表被污染后，B3 会把本来正确的字判成同音而**误改**，那是最坏的一类失效。
 *   所以别名只承担"整串精确替换"；音节匹配完全依赖 canonical，覆盖面窄一点但零风险。
 */
export function charSyllableTable(terms: readonly GlossaryTerm[]): Map<string, string> {
  const seen = new Map<string, string>();
  const dropped = new Set<string>();
  for (const t of terms) {
    const chars = Array.from(t.canonical);
    if (chars.length !== t.syll.length) continue; // 由 validateGlossary 拦下，这里只防一手
    chars.forEach((ch, i) => {
      const syllable = t.syll[i] ?? '';
      if (!/^[a-z]{2,6}$/.test(syllable)) return; // 拉丁段（A/B/C/D/E）不进字表，匹配时按字面比
      const prev = seen.get(ch);
      if (prev === undefined) seen.set(ch, syllable);
      else if (prev !== syllable) dropped.add(ch);
    });
  }
  for (const ch of dropped) seen.delete(ch);
  return seen;
}

/**
 * 把术语表转成 asr-lexicon 的词典条目。
 * 依赖方向是单向的：本模块知道 LexiconEntry 的形状，asr-lexicon 不认识术语表。
 */
export function glossaryToLexicon(terms: readonly GlossaryTerm[]): LexiconEntry[] {
  return terms.map((t) => ({
    canonical: t.canonical,
    norm: normalizeForKey(t.canonical),
    kind: 'term' as const,
    sy: t.sy,
    aliases: t.aliases,
    blockAfter: t.blockAfter
  }));
}

/** 表指纹：进缓存键与评测报告，改了词表（含 protect / blockAfter）一定看得见，不会"改了但没生效" */
export function glossaryFingerprint(terms: readonly GlossaryTerm[], protect: readonly string[] = []): string {
  const body = terms
    .map((t) => `${t.canonical}\u0000${t.sy}\u0000${t.aliases.join('\u0001')}\u0000${t.weight}\u0000${t.blockAfter.join('')}`)
    .join('\u0002') + `\u0003protect=${protect.join('|')}`;
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
}

export interface ContextTextOptions {
  /** 上下文字符上限（含分块标题）；超出按 weight 降序截断 */
  maxChars: number;
  /** 本轮相关的域，排在前（拿不到就按权重全局排） */
  preferredDomains?: readonly AsrDomain[];
  /** Tier A 自动词表的展示串（房间号/班级/课程），一并进上下文；调用方负责限长 */
  extraTerms?: readonly string[];
}

export interface ContextText {
  text: string;
  termCount: number;
  chars: number;
  /** 被 maxChars 挤掉的词条数 —— 不为 0 就要在日志里看得见，否则"词表被截了"是隐形的 */
  omitted: number;
}

/**
 * 构造发给上游的上下文文本。
 * ⚠ 官方文档明确：这条通道「不支持设置模型角色等传统系统提示词」，
 *   所以这里**只放词，不放指令**——写成「请正确识别以下词」属于误用，可能反噬。
 *   输出必须可复现：先域优先级、再 weight 降序、最后 canonical 稳定序。
 */
export function buildContextText(terms: readonly GlossaryTerm[], opts: ContextTextOptions): ContextText {
  const maxChars = Math.max(0, Math.floor(opts.maxChars));
  const preferred = opts.preferredDomains ?? [];
  const rank = (domain: AsrDomain): number => (preferred.includes(domain) ? 0 : 1);
  const labelOf: Record<AsrDomain, string> = { period: '节次', check: '交接检查项', place: '楼栋', equipment: '器材', operation: '操作', document: '单据' };
  // 固定短语（节次/检查项/楼栋）整块先保：它们最长、最容易被预算挤掉，而口语里几乎必现
  const fixedPhrase = (domain: AsrDomain): number => (domain === 'period' || domain === 'check' || domain === 'place' ? 0 : 1);

  const candidates = [...terms]
    .sort(
      (a, b) =>
        fixedPhrase(a.domain) - fixedPhrase(b.domain) ||
        rank(a.domain) - rank(b.domain) ||
        b.weight - a.weight ||
        (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0)
    )
    .map((t) => ({ label: labelOf[t.domain], word: t.canonical }));

  for (const extra of [...new Set((opts.extraTerms ?? []).map((s) => s.trim()).filter(Boolean))]) {
    candidates.push({ label: '对象', word: extra });
  }

  const header = '实验室管理领域参考词（中文）：';
  let lines: string[] = [header];
  let termCount = 0;
  let omitted = 0;

  const fits = (candidate: string[]): boolean => candidate.join('\n').length <= maxChars;

  for (const item of candidates) {
    const wantedLabel = `${item.label} `;
    const current = lines[lines.length - 1] ?? '';
    const next = current.startsWith(wantedLabel) ? [...lines.slice(0, -1), `${current} ${item.word}`] : [...lines, `${wantedLabel}${item.word}`];
    // 以最终文本总长为唯一预算口径，不拿"词字数"冒充，避免出现"号称 1200 实际 1600"
    if (!fits(next)) {
      omitted += 1;
      continue;
    }
    lines = next;
    termCount += 1;
  }

  const text = lines.join('\n');
  return { text, termCount, chars: text.length, omitted };
}
