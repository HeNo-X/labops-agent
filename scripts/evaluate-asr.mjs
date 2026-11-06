#!/usr/bin/env node
/**
 * 语音术语评测（B1）—— 实验室专用名词的识别/纠正可复跑指标
 * ============================================================================
 *  为什么先有这把尺子：上游偏置（上下文词表 / asr_options）与纠正层升级（拼音同音）
 *  都容易"感觉变好了"，而感觉不能验收。本脚本把两件事钉成数字：
 *    · 术语有没有以**标准写法**出现（召回）
 *    · 出现的写法对不对（精确率）
 *    · **把本来对的改错了几处（误改率）—— 这一项必须为 0，是发布硬门槛**
 *
 *  三种模式：
 *   · --mode=correction（默认）文本层，离线、零 Key、确定性，随时可复跑。
 *     输入是 evaluation/asr-term-scenarios.json 里人工构造的同音/近音误写文本，
 *     过一遍**线上正在用的** correctTranscript，得到 B3 要击败的基线。
 *   · --mode=live 真实音频走上游。需要 ASR Key + evaluation/asr-recordings/。
 *     **默认 --dry-run 不发请求、不烧每小时配额**；缺任何一样就整项 not_run，不猜。
 *   · --mode=e2e 识别文本喂 Agent 的工具命中率。B1 未接线，恒 not_run 并写明原因。
 *
 *  输出 .evaluation/asr-<mode>-<时间>.json 与同名 .html（人读版）。
 *  报告固定带「未验证项」一节 —— 只报好消息的评测报告不可信。
 *
 *  运行：node scripts/evaluate-asr.mjs [--mode=correction|live|e2e] [--execute] [--quiet]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const mode = arg('mode', 'correction');
const quiet = flag('quiet');

// 确定性：不读 .env、不落真库、不碰实时数据 —— 评委拿到作品包也能跑出同一个数字
process.env.LABOPS_SKIP_ENV_FILE = '1';
process.env.LIVE_DATA = '0';
process.env.LABOPS_AUTH_MODE = 'demo';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-asr-eval-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'eval.sqlite');

const { loadGlossary, validateGlossary, ambiguousSyllables, charSyllableTable, glossaryFingerprint, buildContextText } = await import('../server/llm/asr-glossary.ts');
const { loadDataset } = await import('../server/data/store.ts');
const { lexiconFromDataset, correctTranscript } = await import('../server/llm/asr-lexicon.ts');

const suite = JSON.parse(fs.readFileSync(path.join(root, 'evaluation/asr-term-scenarios.json'), 'utf8'));

// ---------------------------------------------------------------- 指标内核
/** 出现次数按"是否存在"计，够用且不引入分词依赖 */
const countPresent = (text, terms) => {
  let present = 0;
  const hits = [];
  for (const term of terms) {
    if (text.includes(term)) {
      present += 1;
      hits.push(term);
    }
  }
  return { present, hits };
};

/**
 * 对一批场景算指标。分母为 0 一律返回 null —— 报 0% 会把"没测到"伪装成"测得很差"。
 */
function score(rows, apply) {
  let targetTotal = 0;
  let targetFound = 0;
  let forbiddenFound = 0;
  const misses = [];
  const outputs = rows.map((s) => {
    const out = apply(s.asrText);
    const ok = countPresent(out.text, s.targetTerms);
    const bad = countPresent(out.text, s.forbiddenTerms ?? []);
    targetTotal += s.targetTerms.length;
    targetFound += ok.present;
    forbiddenFound += bad.present;
    for (const t of s.targetTerms) if (!ok.hits.includes(t)) misses.push({ id: s.id, missing: t, output: out.text });
    return { id: s.id, ...out, present: ok.hits, missing: s.targetTerms.filter((t) => !ok.hits.includes(t)) };
  });
  const recall = targetTotal > 0 ? targetFound / targetTotal : null;
  const precision = targetFound + forbiddenFound > 0 ? targetFound / (targetFound + forbiddenFound) : null;
  return { rows: outputs, targetTotal, targetFound, forbiddenFound, recall, precision, misses };
}

/** 误改率：control 样本（原文即标准答案）被改掉的字符数 / 总字符数。必须 0。 */
function harmfulness(controls, apply) {
  let totalChars = 0;
  let editedChars = 0;
  let dirtyRows = 0;
  const offenders = [];
  for (const s of controls) {
    const out = apply(s.asrText);
    totalChars += Array.from(s.asrText).length;
    const edited = out.corrections.reduce((sum, c) => sum + Array.from(c.from).length, 0);
    editedChars += edited;
    if (out.corrections.length || out.text !== s.asrText) {
      dirtyRows += 1;
      offenders.push({ id: s.id, input: s.asrText, output: out.text, corrections: out.corrections });
    }
  }
  return {
    controlCount: controls.length,
    totalChars,
    editedChars,
    dirtyRows,
    // totalChars 只会 >0，除非评测集被清空 —— 那时报 null 而不是 0%
    harmfulEditRate: totalChars > 0 ? editedChars / totalChars : null,
    offenders
  };
}

// ---------------------------------------------------------------- Tier A（线上正在用的那套）
let tierA = [];
let datasetBasis = null;
let datasetError = null;
try {
  const ds = loadDataset();
  tierA = lexiconFromDataset(ds);
  datasetBasis = { loadedAt: ds.loadedAt, labs: ds.labs.length, openLabs: ds.openLabs.length, timetable: ds.timetable.length, sourceType: ds.sourceType };
} catch (err) {
  datasetError = err instanceof Error ? err.message : String(err);
}

const glossary = loadGlossary();
const glossaryProblems = validateGlossary(glossary);
const ambiguous = ambiguousSyllables(glossary);
const syllTable = charSyllableTable(glossary);

const applyCurrent = (text) => {
  const r = correctTranscript(text, tierA);
  return { text: r.text, corrections: r.corrections, aborted: r.aborted };
};
const applyRaw = (text) => ({ text, corrections: [] });

const termRows = suite.scenarios.filter((s) => s.kind === 'term');
const controlRows = suite.scenarios.filter((s) => s.kind === 'control');

// ---------------------------------------------------------------- 域名切分（按 id 前缀，不额外加字段）
const domainOf = (id) => (id.split('-')[0] ?? 'other');
const perDomain = {};
for (const d of new Set(termRows.map((s) => domainOf(s.id)))) {
  const rows = termRows.filter((s) => domainOf(s.id) === d);
  perDomain[d] = {
    scenarios: rows.length,
    rawRecall: score(rows, applyRaw).recall,
    currentRecall: score(rows, applyCurrent).recall,
    currentPrecision: score(rows, applyCurrent).precision
  };
}

// ---------------------------------------------------------------- 缺口量化（B3 要补多少）
const shortTargets = new Set(termRows.flatMap((s) => s.targetTerms).filter((t) => Array.from(t).length <= 3));
const shortInGlossary = [...shortTargets].filter((t) => glossary.some((g) => g.canonical === t));
const shortMissingGlossary = [...shortTargets].filter((t) => !glossary.some((g) => g.canonical === t));

const result = {
  mode,
  ranAt: new Date().toISOString(),
  basis: {
    suiteVersion: suite.version,
    scenarios: suite.scenarios.length,
    termScenarios: termRows.length,
    controlScenarios: controlRows.length,
    datasetBasis,
    datasetError,
    tierAEntries: tierA.length,
    glossaryFingerprint: glossaryFingerprint(glossary),
    glossaryTerms: glossary.length,
    glossaryValidationProblems: glossaryProblems,
    ambiguousSyllableKeys: [...ambiguous],
    charSyllableTableSize: syllTable.size
  },
  metrics: {
    raw: score(termRows, applyRaw),
    current: score(termRows, applyCurrent),
    perDomain,
    harmful: harmfulness(controlRows, applyCurrent),
    e2eToolHit: { status: 'not_run', reason: 'B1 未把识别文本接进 Agent 工具选择；B2/B3 落地后补' }
  },
  gap: {
    shortTermTargets: shortTargets.size,
    shortCoveredByGlossary: shortInGlossary.length,
    shortNotInGlossary: shortMissingGlossary,
    note: '2–3 字目标词目前完全不受现有纠正层保护（MIN_CN_TERM_LENGTH=4 且只认字符距离）；glossary 已备好音节键，等 B3 接线。'
  },
  notVerified: [
    '上游偏置（实体词表上下文 / asr_options.language / enable_itn）的效果**本模式测不到**——文本层不经过模型。需 --mode=live + 真实录音。',
    '误改率只在文本层成立；真实上游可能产出评测集里没有的新混淆写法。',
    '端到端工具命中率 not_run（见 metrics.e2eToolHit.reason）。',
    '评测集里的错写是人工构造的同音/近音，不代表真实声学模型的错误分布与比例。'
  ]
};

// ---------------------------------------------------------------- live 模式（脚手架 + 诚实降级）
if (mode === 'live') {
  const manifestPath = path.join(root, 'evaluation/asr-recordings.manifest.json');
  const audioDir = path.join(root, 'evaluation/asr-recordings');
  const missing = [];
  if (!fs.existsSync(manifestPath)) missing.push('缺 evaluation/asr-recordings.manifest.json（录音清单）');
  if (!fs.existsSync(audioDir)) missing.push('缺 evaluation/asr-recordings/ 目录');
  const { getAsrConfig, isAsrConfigured } = await import('../server/llm/asr.ts');
  const cfg = getAsrConfig();
  if (!isAsrConfigured()) missing.push('未配置 ASR Key（ASR_API_KEY 或 DASHSCOPE_API_KEY）');
  if (!fs.existsSync(audioDir) || !fs.existsSync(manifestPath) || !isAsrConfigured()) {
    result.live = { status: 'not_run', reason: missing.join('；'), model: cfg.model, protocol: cfg.protocol };
    result.metrics = { raw: null, current: null, perDomain: null, harmful: null, e2eToolHit: result.metrics.e2eToolHit };
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const absent = manifest.recordings.filter((r) => !fs.existsSync(path.join(audioDir, r.file)));
    if (!flag('execute')) {
      result.live = { status: 'dry_run', reason: '未加 --execute，默认不发请求、不烧每小时配额', recordings: manifest.recordings.length, missingFiles: absent.map((r) => r.file) };
      result.metrics = { raw: null, current: null, perDomain: null, harmful: null, e2eToolHit: result.metrics.e2eToolHit };
    } else if (absent.length) {
      result.live = { status: 'not_run', reason: `清单里 ${absent.length} 个音频文件不存在：${absent.slice(0, 5).map((r) => r.file).join(', ')}` };
      result.metrics = { raw: null, current: null, perDomain: null, harmful: null, e2eToolHit: result.metrics.e2eToolHit };
    } else {
      // 真跑：逐条转写 → 过纠正层 → 与 referenceText 比。这是 B2 开/关对比的同一套管线。
      const { transcribeAudio } = await import('../server/llm/asr.ts');
      const mimeOf = (f) => (f.endsWith('.wav') ? 'audio/wav' : f.endsWith('.mp3') ? 'audio/mpeg' : f.endsWith('.m4a') ? 'audio/mp4' : f.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm');
      const rows = [];
      for (const r of manifest.recordings) {
        const buf = fs.readFileSync(path.join(audioDir, r.file));
        const res = await transcribeAudio({ base64: buf.toString('base64'), mime: mimeOf(r.file) });
        if (!res.ok) {
          rows.push({ id: r.id, status: 'failed', code: res.code, message: res.message });
          continue;
        }
        const fixed = correctTranscript(res.text, tierA);
        const ok = countPresent(res.text, r.targetTerms ?? []);
        const okFixed = countPresent(fixed.text, r.targetTerms ?? []);
        rows.push({
          id: r.id,
          status: 'ok',
          upstream: res.text,
          corrected: fixed.text,
          reference: r.referenceText,
          targets: (r.targetTerms ?? []).length,
          rawHits: ok.present,
          correctedHits: okFixed.present,
          corrections: fixed.corrections,
          elapsedMs: res.elapsedMs
        });
      }
      const done = rows.filter((x) => x.status === 'ok');
      const sum = (k) => done.reduce((a, b) => a + b[k], 0);
      const targetTotal = sum('targets');
      result.live = {
        status: 'run',
        model: cfg.model,
        protocol: cfg.protocol,
        recordings: rows.length,
        succeeded: done.length,
        failed: rows.length - done.length,
        upstreamRecall: targetTotal > 0 ? sum('rawHits') / targetTotal : null,
        correctedRecall: targetTotal > 0 ? sum('correctedHits') / targetTotal : null,
        rows
      };
      // live 模式的"误改"口径：参考文本本身正确时，纠正层不得改动任何字
      const cleanRows = done.filter((x) => x.upstream === x.reference);
      const chars = cleanRows.reduce((a, b) => a + Array.from(b.upstream).length, 0);
      const edited = cleanRows.reduce((a, b) => a + b.corrections.reduce((s, c) => s + Array.from(c.from).length, 0), 0);
      result.live.controlLikeRows = cleanRows.length;
      result.live.harmfulEditRate = chars > 0 ? edited / chars : null;
      result.notVerified.push('live 模式的开/关 A/B 要等 B2 落地 ASR_CONTEXT_ENABLED 才能做；本轮只给单值基线。');
    }
  }
}

if (mode === 'e2e') {
  result.e2e = { status: 'not_run', reason: 'B1 未接线；识别文本→工具选择→参数正确性的贯通评测在 B2/B3 之后补' };
}

// ---------------------------------------------------------------- 输出
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(root, '.evaluation');
fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, `asr-${mode}-${stamp}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

const pct = (v) => (v === null || v === undefined ? 'null（分母为空，未测到）' : (v * 100).toFixed(1) + '%');
const domainNames = { room: '房间号', eq: '器材', op: '操作', pd: '节次', dc: '单据', ck: '检查项', pl: '楼栋' };
const html = `<!doctype html><meta charset="utf-8"><title>LabOps 语音术语评测 ${mode}</title>
<style>body{font:14px/1.6 ui-sans-serif,system-ui;color:#1c2430;background:#faf8f4;margin:32px;max-width:900px}
h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;font-weight:600}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #dcd6cc;padding:5px 8px;text-align:left}
th{background:#f2eee7;font-weight:600}.bad{color:#b3261e}.ok{color:#1c6b4a}
code{background:#efeae2;padding:1px 4px;border-radius:2px}ul{margin:6px 0}</style>
<h1>LabOps 语音术语评测 · ${mode}</h1>
<p>${result.ranAt} ｜ 场景 ${result.basis.scenarios}（术语 ${result.basis.termScenarios} + 对照 ${result.basis.controlScenarios}）｜ 词典 Tier A ${result.basis.tierAEntries} ｜ 术语表 ${result.basis.glossaryTerms} 条 <code>${result.basis.glossaryFingerprint}</code></p>
${mode === 'correction' ? `<h2>纠正层指标（文本层，离线确定性）</h2>
<table><tr><th>口径</th><th>术语召回</th><th>术语精确</th></tr>
<tr><td>不纠正（上游原样）</td><td>${pct(result.metrics.raw.recall)}</td><td>${pct(result.metrics.raw.precision)}</td></tr>
<tr><td>线在跑的纠正层（Tier A 字符距离）</td><td>${pct(result.metrics.current.recall)}</td><td>${pct(result.metrics.current.precision)}</td></tr></table>
<h2>分域</h2><table><tr><th>域</th><th>场景</th><th>不纠正</th><th>纠正后</th></tr>
${Object.entries(result.metrics.perDomain).map(([d, v]) => `<tr><td>${domainNames[d] ?? d}</td><td>${v.scenarios}</td><td>${pct(v.rawRecall)}</td><td>${pct(v.currentRecall)}</td></tr>`).join('')}
</table>` : ''}
${result.live ? `<h2>live</h2><table><tr><th>项</th><th>值</th></tr>
${Object.entries(result.live).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `<tr><td>${k}</td><td>${String(v)}</td></tr>`).join('')}</table>` : ''}
<h2>误改率（对照样本 ${result.basis.controlScenarios} 条，必须 0）</h2>
${mode === 'correction' ? `<p class="${result.metrics.harmful.harmfulEditRate === 0 ? 'ok' : 'bad'}">harmfulEditRate = ${pct(result.metrics.harmful.harmfulEditRate)} ｜ 被改动样本 ${result.metrics.harmful.dirtyRows}/${result.metrics.harmful.controlCount}</p>
${result.metrics.harmful.offenders.length ? `<table><tr><th>id</th><th>输入</th><th>输出</th></tr>${result.metrics.harmful.offenders.map((o) => `<tr><td>${o.id}</td><td>${o.input}</td><td>${o.output}</td></tr>`).join('')}</table>` : '<p class="ok">对照样本逐字未被改动。</p>'}` : ''}
<h2>缺口（B3 要补的量）</h2>
<p>2–3 字目标词 <b>${result.gap.shortTermTargets}</b> 个，其中 ${result.gap.shortCoveredByGlossary} 个已在术语表备好音节键；表中仍缺：${result.gap.shortNotInGlossary.join('、') || '（无）'}</p>
<p>歧义音节键（B3 必须跳过）：${result.basis.ambiguousSyllableKeys.length ? result.basis.ambiguousSyllableKeys.join('、') : '当前为 0 —— 空不代表以后也空'}</p>
${result.basis.glossaryValidationProblems.length ? `<h2 class="bad">术语表校验问题</h2><ul>${result.basis.glossaryValidationProblems.map((p) => `<li>${p}</li>`).join('')}</ul>` : '<p class="ok">术语表校验：无问题。</p>'}
<h2>未验证项（只报好消息的报告不可信）</h2><ul>${result.notVerified.map((n) => `<li>${n}</li>`).join('')}</ul>`;
const htmlPath = path.join(outDir, `asr-${mode}-${stamp}.html`);
fs.writeFileSync(htmlPath, html);

if (!quiet) {
  if (mode === 'correction') {
    console.log(`语音术语评测 · correction`);
    console.log(`  场景 ${result.basis.scenarios}（术语 ${result.basis.termScenarios} / 对照 ${result.basis.controlScenarios}）｜ Tier A ${result.basis.tierAEntries} ｜ 术语表 ${result.basis.glossaryTerms} 条 ${result.basis.glossaryFingerprint}`);
    console.log(`  术语召回   不纠正 ${pct(result.metrics.raw.recall)}  →  现纠正层 ${pct(result.metrics.current.recall)}`);
    console.log(`  术语精确   不纠正 ${pct(result.metrics.raw.precision)}  →  现纠正层 ${pct(result.metrics.current.precision)}`);
    console.log(`  误改率     ${pct(result.metrics.harmful.harmfulEditRate)}（对照 ${result.metrics.harmful.dirtyRows}/${result.metrics.harmful.controlCount} 条被改动）`);
    console.log(`  分域       ${Object.entries(result.metrics.perDomain).map(([d, v]) => `${domainNames[d] ?? d} ${pct(v.rawRecall)}→${pct(v.currentRecall)}`).join('  ')}`);
    console.log(`  缺口       2–3 字词 ${result.gap.shortTermTargets} 个，术语表已覆盖 ${result.gap.shortCoveredByGlossary} 个（等 B3 接线）`);
    if (result.basis.glossaryValidationProblems.length) console.log(`  ⚠ 术语表校验 ${result.basis.glossaryValidationProblems.length} 项问题`);
    console.log(`  未验证     ${result.notVerified.length} 项（详见报告）`);
  } else {
    console.log(`语音术语评测 · ${mode}：${JSON.stringify(result.live ?? result.e2e ?? {}, null, 2).slice(0, 900)}`);
  }
  console.log(`  报告       ${path.relative(root, jsonPath)}`);
}

fs.rmSync(temp, { recursive: true, force: true });
if (mode === 'correction' && result.metrics.harmful.harmfulEditRate !== 0) {
  console.error('\n误改率非 0 —— 这是发布硬门槛（宁可不改，也不改错），本批不予验收。');
  process.exitCode = 1;
}
if (result.basis.glossaryValidationProblems.length) process.exitCode = 1;
