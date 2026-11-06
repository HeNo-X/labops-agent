/**
 * 用户自己登记的「识别成 → 应该是」词对（U1）
 * ============================================================================
 *  为什么放在浏览器而不是服务端：
 *   - 这是**个人**的说话习惯（同一间实验室里两个人错的词不一样），不是全实验室的事实；
 *   - 服务端存它就得新增一个写入口，而本仓库的红线是"业务数据只有一个写入进程"，
 *     配置类的写入也不该顺手开新口子；
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
const MAX_PAIRS = 100;
const MIN_FROM_CHARS = 2;
const MAX_CHARS = 24;

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

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pairs.value));
  } catch {
    /* 隐私模式或配额不足：内存里照样生效，只是这次会话之后不保留。不弹窗吓用户。 */
  }
}

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

  return { pairs, count, add, remove, clear };
}

/** 给 useVoiceInput 用：没有词对时返回空数组，请求体里就不带这个字段（与旧客户端一致） */
export function currentUserTermPairs(): UserTermPair[] {
  return pairs.value;
}
