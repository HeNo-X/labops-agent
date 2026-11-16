/**
 * 用户自己登记的两类语音词汇
 * ============================================================================
 *  两栏的区别必须一眼能看出来，因为它们生效的机制完全不同：
 *   - **词对（识别成 → 应该是）**：走服务端纠正层的第零遍，**精确替换、默认生效、可证明**；
 *   - **常用词（只填正确写法）**：不改写已经识别出来的字，只作为提示随请求发给模型
 *     （Qwen-ASR 的 system 实体词表；换原生协议时另进即时热词）。这条路**收益未量化**，
 *     产品默认还没开（`ASR_CONTEXT_ENABLED=0`），所以界面上要如实显示"这次到底发没发"。
 *
 *  为什么不放服务端：
 *   - 这是**个人**的说话习惯（同一间实验室里两个人错的词不一样），不是全实验室的事实；
 *   - 服务端存它就要多一个写入口，而本仓库的红线是"业务数据只有一个写入进程"，
 *     配置类的写入也不该开新口子；
 *   - 随请求带上去，服务端只在本次转写里用，不落盘 —— 换浏览器丢的是自己的偏好，
 *     不是系统数据，这个失败方向可以接受。
 *
 *  校验规则与服务端 sanitizeTermPairs 保持一致（**前端只是提前拦住，服务端仍然重查一遍**）：
 *  from ≥2 字、≤24 字、from≠to、同一 from 只留第一条、最多 100 条。
 *  单字为什么禁止：一个字的同音面太宽，手滑写「机」就能把整句的「机」换掉，
 *  那是"一次输入毁掉一句识别"的形状，不该由界面给出去。
 */
import { computed, ref } from 'vue';

export interface UserTermPair {
  from: string;
  to: string;
}

export type AddResult = { ok: true } | { ok: false; reason: 'empty' | 'same' | 'tooShort' | 'tooLong' | 'duplicate' | 'full' };

const STORAGE_KEY = 'labops.asr.term-pairs';
const KEYWORD_KEY = 'labops.asr.keywords';
const MAX_PAIRS = 100;
const MIN_FROM_CHARS = 2;
const MAX_CHARS = 24;
/** 常用词与服务端 sanitizeKeywords 同一套规则：单字不给存，因为它只能进偏置通道，
 *  而一个单字的候选面太大，收益说不清 —— 想要确定生效请走左边的「识别成 → 应该是」。 */
const MAX_KEYWORDS = 100;

/** 归一化 + 去重 + 截断：坏数据（别的版本写的、手改过的、半截的）一律丢掉，不猜它想表达什么 */
function normalize(input: unknown): UserTermPair[] {
  if (!Array.isArray(input)) return [];
  const out: UserTermPair[] = [];
  const seen = new Set<string>();
  for (const item of input as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const from = typeof record['from'] === 'string' ? record['from'].trim() : '';
    const to = typeof record['to'] === 'string' ? record['to'].trim() : '';
    const fromChars = [...from].length;
    if (fromChars < MIN_FROM_CHARS || fromChars > MAX_CHARS) continue;
    if (!to || [...to].length > MAX_CHARS) continue;
    if (from === to || seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to });
    if (out.length >= MAX_PAIRS) break;
  }
  return out;
}

function read(): UserTermPair[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw) as unknown);
  } catch {
    // 读不出来就当没有：宁可这次不带词对，也不能因为一条坏数据把语音输入整个卡住
    return [];
  }
}

/** 模块级单例：PC 命令栏、移动端会话页、移动端起始页共用同一份登记表 */
const pairs = ref<UserTermPair[]>(read());

/** 只填正确写法的那一列：它们不进纠正层，只作为"事前提示"发给模型 */
const keywords = ref<string[]>(readKeywords());

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pairs.value));
  } catch {
    /* 隐私模式或配额不足：内存里照样生效，只是这次会话之后不保留。不弹窗吓用户。 */
  }
}

function persistKeywords(): void {
  try {
    localStorage.setItem(KEYWORD_KEY, JSON.stringify(keywords.value));
  } catch {
    /* 同上 */
  }
}

function normalizeKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input as unknown[]) {
    if (typeof item !== 'string') continue;
    const word = item.trim();
    const chars = [...word].length;
    if (chars < MIN_FROM_CHARS || chars > MAX_CHARS || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

function readKeywords(): string[] {
  try {
    const raw = localStorage.getItem(KEYWORD_KEY);
    if (!raw) return [];
    return normalizeKeywords(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export type AddKeywordResult = { ok: true } | { ok: false; reason: 'empty' | 'tooShort' | 'tooLong' | 'duplicate' | 'full' };

export function useUserTerms() {
  const count = computed(() => pairs.value.length);

  function add(rawFrom: string, rawTo: string): AddResult {
    const from = (rawFrom ?? '').trim();
    const to = (rawTo ?? '').trim();
    if (!from || !to) return { ok: false, reason: 'empty' };
    if (from === to) return { ok: false, reason: 'same' };
    if ([...from].length < MIN_FROM_CHARS) return { ok: false, reason: 'tooShort' };
    if ([...from].length > MAX_CHARS || [...to].length > MAX_CHARS) return { ok: false, reason: 'tooLong' };
    if (pairs.value.some((p) => p.from === from)) return { ok: false, reason: 'duplicate' };
    if (pairs.value.length >= MAX_PAIRS) return { ok: false, reason: 'full' };
    pairs.value = [...pairs.value, { from, to }];
    persist();
    return { ok: true };
  }

  function remove(at: number): void {
    if (at < 0 || at >= pairs.value.length) return;
    pairs.value = pairs.value.filter((_, i) => i !== at);
    persist();
  }

  function clear(): void {
    if (!pairs.value.length) return;
    pairs.value = [];
    persist();
  }

  const keywordCount = computed(() => keywords.value.length);

  /** 常用词只填一个正确写法：它不改写已经识别出来的字，只作为"提示"随请求发给模型 */
  function addKeyword(raw: string): AddKeywordResult {
    const word = (raw ?? '').trim();
    if (!word) return { ok: false, reason: 'empty' };
    const chars = [...word].length;
    if (chars < MIN_FROM_CHARS) return { ok: false, reason: 'tooShort' };
    if (chars > MAX_CHARS) return { ok: false, reason: 'tooLong' };
    if (keywords.value.includes(word)) return { ok: false, reason: 'duplicate' };
    if (keywords.value.length >= MAX_KEYWORDS) return { ok: false, reason: 'full' };
    keywords.value = [...keywords.value, word];
    persistKeywords();
    return { ok: true };
  }

  function removeKeyword(at: number): void {
    if (at < 0 || at >= keywords.value.length) return;
    keywords.value = keywords.value.filter((_, i) => i !== at);
    persistKeywords();
  }

  function clearKeywords(): void {
    if (!keywords.value.length) return;
    keywords.value = [];
    persistKeywords();
  }

  return {
    pairs, count, add, remove, clear,
    keywords, keywordCount, addKeyword, removeKeyword, clearKeywords
  };
}

/** 给 useVoiceInput 用：没有登记时返回空数组，请求体里就不带这个字段 */
export function currentUserTermPairs(): UserTermPair[] {
  return pairs.value;
}

/** 同上：常用词随请求进 extraTerms，服务端只把它接到"事前"那两条有出处的通道上 */
export function currentKeywords(): string[] {
  return keywords.value;
}
