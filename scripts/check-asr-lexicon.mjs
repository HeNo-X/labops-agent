/**
 * npm run check:asr-lexicon -- <候选文件.json>
 * ============================================================================
 *  面板「导出待并入条目」产出的是一份**候选**表，不是成品：并进 shared/asr-glossary.json
 *  合并前必须过一遍真校验，因为内置表是装载即自检的（loadGlossaryData 抛错 = 整个纠错层不生效），
 *  一条坏数据会让 148 条好数据一起下线。这个脚本就是那道门，也是"为什么被拒"的说明书。
 *
 *  它检查什么（每条都对应一种真实失效形状）：
 *    - 音节数与字数不等、音节含大写/数字 → 这个词永远匹配不上（装载即抛错）
 *    - 缺拼音 → 给出用内置表已确认读音推导的建议值；推不出来就明说必须人工补
 *    - canonical 已在内置表 → 应给已有词条补 aliases，而不是新开一条
 *    - aliases 撞别的 canonical → 矛盾表，validateGlossary 会整表拒绝
 *    - aliases / canonical 命中 protect 常用词 → 要么永不生效，要么误伤日常用语
 *    - 音节串与内置某条完全相同 → 同音歧义，合并后**两条都会被跳过**（合了等于没合）
 *
 *  最后一步是真跑：合并后的表丢给 loadGlossaryData()（写入系统 tmp 目录，不落库），
 *  过不了就是不能合，不做"看起来差不多"的判断。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) {
  console.error('用法：npm run check:asr-lexicon -- <候选文件.json>（候选文件是 { terms: [...] } 或裸数组）');
  process.exit(2);
}
const file = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
if (!fs.existsSync(file)) {
  console.error(`找不到候选文件：${file}`);
  process.exit(2);
}

const { loadGlossaryData, validateGlossary, deriveSyllables, glossaryFingerprint } = await import('../server/llm/asr-glossary.ts');

const builtIn = loadGlossaryData();
const builtInTerms = builtIn.terms;
const protect = new Set(builtIn.protect);
const canonicals = new Set(builtInTerms.map((t) => t.canonical));
const syllOf = new Map(builtInTerms.map((t) => [t.sy, t.canonical]));
const DOMAIN_OK = new Set(['equipment', 'check', 'place', 'operation', 'period', 'document', 'user']);

let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`候选文件不是合法 JSON：${err.message}`);
  process.exit(2);
}
const list = Array.isArray(raw) ? raw : Array.isArray(raw?.terms) ? raw.terms : null;
if (!list) {
  console.error('候选文件既不是数组，也没有 terms 数组');
  process.exit(2);
}

const rejects = [];
const warns = [];
const accepted = [];

for (const item of list) {
  const canonical = typeof item?.canonical === 'string' ? item.canonical.trim() : '';
  if (!canonical) {
    rejects.push({ canonical: '(空)', why: '缺 canonical' });
    continue;
  }
  const chars = Array.from(canonical);
  const declared = Array.isArray(item.syll) ? item.syll.map((s) => String(s ?? '')) : [];
  const problems = [];

  if (chars.length < 2) problems.push('只有 1 个字：同音面太大，内置表不允许这种条目参与短词纠错');
  if (canonicals.has(canonical)) problems.push(`内置表已有「${canonical}」：请改为给老词条补 aliases，别新开一条`);
  if (protect.has(canonical)) problems.push(`「${canonical}」在 protect 常用词名单里：作为标准词会自废武功`);

  let syll = declared;
  const alreadyBuiltin = canonicals.has(canonical);
  if (declared.length === 0 && !alreadyBuiltin) {
    const derived = deriveSyllables(canonical, builtInTerms);
    if (derived) {
      syll = derived;
      warns.push({ canonical, why: `syll 缺失，已按内置表已确认的读音推导为 ${JSON.stringify(derived)}（人工核对无误后再合）` });
    } else {
      problems.push('syll 缺失且**推不出来**（含多音字或表外字）：必须人工逐字补无声调小写拼音，不能猜');
    }
  } else if (!alreadyBuiltin && syll.length !== chars.length) {
    problems.push(`syll 数量 ${syll.length} 与字数 ${chars.length} 不等（装载即抛错）`);
  }
  for (const s of syll) {
    if (!/^[a-z]{2,6}$/.test(s)) {
      problems.push(`音节「${s || '(空)'}」不是 2–6 位小写字母（大写/数字/带声调都会被拒）`);
      break;
    }
  }
  const weight = typeof item.weight === 'number' ? item.weight : 4;
  if (weight < 1 || weight > 5) problems.push(`weight=${weight} 不在 1–5`);
  const domain = typeof item.domain === 'string' ? item.domain : '';
  if (!DOMAIN_OK.has(domain)) problems.push(`domain=${domain || '(空)'} 非法（可选：${[...DOMAIN_OK].join('/')}）`);

  const aliases = Array.isArray(item.aliases) ? item.aliases.map((a) => String(a ?? '').trim()).filter(Boolean) : [];
  for (const a of aliases) {
    if (a === canonical) problems.push(`别名「${a}」与标准词相同（无意义且会自环）`);
    else if (canonicals.has(a)) problems.push(`别名「${a}」本身是内置标准词（矛盾表，validateGlossary 会整表拒绝）`);
    else if (protect.has(a)) warns.push({ canonical, why: `别名「${a}」在 protect 名单里：这条别名永远不生效` });
  }
  if (syll.length === chars.length && chars.length >= 2) {
    const sy = syll.join('');
    const clash = syllOf.get(sy);
    if (clash && clash !== canonical) {
      problems.push(`与内置「${clash}」完全同音（${sy}）：合并后两条都会被歧义闸门跳过，等于没合`);
    }
  }

  if (problems.length) rejects.push({ canonical, why: problems.join('；') });
  else accepted.push({ canonical, syll, aliases, weight, domain, blockAfter: Array.isArray(item.blockAfter) ? item.blockAfter : [] });
}

// 真跑一遍：合并后的表必须能过装载自检，这比任何人工判断都硬
// 装载器不看 version（它只认 terms/protect），所以这里不填版本号
const merged = {
  protect: builtIn.protect,
  terms: [
    ...builtInTerms.map((t) => ({ canonical: t.canonical, syll: t.syll, aliases: t.aliases, weight: t.weight, domain: t.domain, blockAfter: t.blockAfter })),
    ...accepted
  ]
};
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'labops-glossary-')), 'candidate.json');
let loadError = '';
try {
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  const reloaded = loadGlossaryData(tmp);
  loadError = validateGlossary(reloaded.terms).join(' | ');
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
} finally {
  fs.rmSync(tmp, { force: true });
}

console.log(`候选 ${list.length} 条 ｜ 内置 ${builtInTerms.length} 条（指纹 ${glossaryFingerprint(builtInTerms, builtIn.protect)}）`);
console.log(`  可合并 ${accepted.length} 条 ｜ 警告 ${warns.length} 条 ｜ 拒绝 ${rejects.length} 条`);
for (const w of warns) console.log(`  ! ${w.canonical}：${w.why}`);
for (const r of rejects) console.log(`  ✗ ${r.canonical}：${r.why}`);
if (loadError) console.log(`  ✗ 合并后装载自检未通过：${loadError}`);
else console.log(`  ✓ 合并后 ${merged.terms.length} 条能过 loadGlossaryData 自检（这才是"可以合"的判据）`);

if (rejects.length || loadError) {
  console.log('\n结论：现在不能合并。把上面每条说的问题改完再跑一次。');
  process.exit(1);
}
if (!accepted.length) {
  console.log('\n结论：没有需要合并的新条目（可能都已经在了）。');
  process.exit(0);
}
console.log('\n结论：可以合并。把上面「可合并」的条目并进 shared/asr-glossary.json 的 terms 里，');
console.log('      然后 npm run eval:asr 看误改率是否仍为 0.0%（这一步不能省）。');
