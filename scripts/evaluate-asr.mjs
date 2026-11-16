#!/usr/bin/env node
/**
 * 语音术语评测 —— 实验室专用名词的识别/纠正可复跑指标
 * ============================================================================
 *  为什么需要这把尺子：上游偏置（上下文词表 / asr_options）与同音匹配纠错层
 *  都容易"感觉变好了"，而感觉不能验收。本脚本把两件事钉成数字：
 *    · 术语有没有以**标准写法**出现（召回）
 *    · 出现的写法对不对（精确率）
 *    · **把本来对的改错了几处（误改率）—— 这一项必须为 0，是发布硬门槛**
 *
 *  三种模式：
 *   · --mode=correction（默认）文本层，离线、零 Key、确定性，随时可复跑。
 *     输入是 evaluation/asr-term-scenarios.json 里人工构造的同音/近音误写文本，
 *     过一遍**生产环境在用的** correctTranscript，作为同音纠正层要超越的基线。
 *   · --mode=live 真实音频走上游。需要 ASR Key + evaluation/asr-recordings/。
 *     **默认 --dry-run 不发请求、不烧每小时配额**；缺任何一样就整项 not_run，不猜。
 *   · --mode=e2e 识别文本喂 Agent 的工具命中率。端到端评测尚未接线，恒 not_run 并写明原因。
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

// 确定性：不读 .env、不落真库、不碰实时数据 —— 任何拿到代码包的人都能跑出同一个数字
process.env.LABOPS_SKIP_ENV_FILE = '1';
process.env.LIVE_DATA = '0';
process.env.LABOPS_AUTH_MODE = 'demo';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-asr-eval-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'eval.sqlite');

const { loadGlossaryData, glossaryToLexicon, validateGlossary, ambiguousSyllables, charSyllableTable, glossaryFingerprint, buildContextText, hotwordVocabulary } = await import('../server/llm/asr-glossary.ts');
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
 * declinedTerms 不计入分母：那些是**设计决定不纠**的词（同音的独立常用词，改了才是错），
 * 把它们算成失败会同时低估纠错层、并把安全决策伪装成缺陷。
 */
function score(rows, apply) {
  let targetTotal = 0;
  let targetFound = 0;
  let forbiddenFound = 0;
  const misses = [];
  const outputs = rows.map((s) => {
    const out = apply(s.asrText);
    const declined = new Set(s.declinedTerms ?? []);
    const counted = s.targetTerms.filter((t) => !declined.has(t));
    const ok = countPresent(out.text, counted);
    const bad = countPresent(out.text, (s.forbiddenTerms ?? []).filter((f) => !declinedSurface(s, f)));
    targetTotal += counted.length;
    targetFound += ok.present;
    forbiddenFound += bad.present;
    for (const t of counted) if (!ok.hits.includes(t)) misses.push({ id: s.id, missing: t, output: out.text });
    return { id: s.id, ...out, present: ok.hits, missing: counted.filter((t) => !ok.hits.includes(t)) };
  });
  const recall = targetTotal > 0 ? targetFound / targetTotal : null;
  const precision = targetFound + forbiddenFound > 0 ? targetFound / (targetFound + forbiddenFound) : null;
  return { rows: outputs, targetTotal, targetFound, forbiddenFound, recall, precision, misses };
}

/** 被豁免的误写串（不许当成"写法错误"计进精确率分母，它是我们故意留着的） */
function declinedSurface(s, surface) {
  return (s.mustRemain ?? []).includes(surface);
}

/**
 * 安全审计：declined 场景里那些误写串必须**仍然原样在输出里**。
 * 一旦某条被替换，说明豁免失效 —— 把常用词当作术语替换属于误改。
 */
function declineAudit(rows, apply) {
  const broken = [];
  let checked = 0;
  for (const s of rows) {
    for (const surface of s.mustRemain ?? []) {
      checked += 1;
      const out = apply(s.asrText);
      if (!out.text.includes(surface)) broken.push({ id: s.id, surface, output: out.text });
    }
  }
  return { checked, broken };
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

// ---------------------------------------------------------------- Tier A（生产环境使用的词表层）
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

const glossaryData = loadGlossaryData();
const glossary = glossaryData.terms;
const glossaryProblems = validateGlossary(glossary);
const ambiguous = ambiguousSyllables(glossary);
const syllTable = charSyllableTable(glossary);

const applyCurrent = (text) => {
  const r = correctTranscript(text, tierA);
  return { text: r.text, corrections: r.corrections, aborted: r.aborted };
};
const applyRaw = (text) => ({ text, corrections: [] });

/**
 * 纠错层：Tier A ∪ Tier B + 音节/保护/歧义三份数据。
 * 口径必须与 server/api/transcribe.ts 的 currentBundle() 一致，否则测的就不是生产口径。
 */
const mergedEntries = [...tierA, ...glossaryToLexicon(glossary)];
const mergedOpts = { syllables: syllTable, protect: new Set(glossaryData.protect), ambiguous };
const applyMerged = (text) => {
  const r = correctTranscript(text, mergedEntries, mergedOpts);
  return { text: r.text, corrections: r.corrections, aborted: r.aborted };
};

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
    mergedRecall: score(rows, applyMerged).recall,
    mergedPrecision: score(rows, applyMerged).precision
  };
}

// ---------------------------------------------------------------- 缺口量化（Tier B 还需覆盖多少）
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
    glossaryFingerprint: glossaryFingerprint(glossary, glossaryData.protect),
    glossaryTerms: glossary.length,
    glossaryProtect: glossaryData.protect,
    glossaryValidationProblems: glossaryProblems,
    ambiguousSyllableKeys: [...ambiguous],
    charSyllableTableSize: syllTable.size
  },
  metrics: {
    raw: score(termRows, applyRaw),
    current: score(termRows, applyCurrent),
    merged: score(termRows, applyMerged),
    perDomain,
    harmful: harmfulness(controlRows, applyCurrent),
    harmfulMerged: harmfulness(controlRows, applyMerged),
    /** 刻意不纠的豁免是否真的守住了（被改了就是误改实锤） */
    declineAuditMerged: declineAudit(termRows, applyMerged),
    declinedScenarios: termRows.filter((s) => (s.declinedTerms ?? []).length).map((s) => ({ id: s.id, terms: s.declinedTerms, why: s.declineWhy })),
    e2eToolHit: { status: 'not_run', reason: '尚未把识别文本接进 Agent 工具选择；B2 之后补' }
  },
  gap: {
    shortTermTargets: shortTargets.size,
    shortCoveredByGlossary: shortInGlossary.length,
    shortNotInGlossary: shortMissingGlossary,
    note: '2–3 字词在 current 口径（只有 Tier A）下完全不受保护；merged 口径已按完全同音接入，两者之差就是 B3 补上的量。'
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
    result.metrics = { raw: null, current: null, merged: null, perDomain: null, harmful: null, harmfulMerged: null, e2eToolHit: result.metrics.e2eToolHit };
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const absent = manifest.recordings.filter((r) => !fs.existsSync(path.join(audioDir, r.file)));
    if (!flag('execute')) {
      result.live = { status: 'dry_run', reason: '未加 --execute，默认不发请求、不烧每小时配额', recordings: manifest.recordings.length, missingFiles: absent.map((r) => r.file) };
      result.metrics = { raw: null, current: null, merged: null, perDomain: null, harmful: null, harmfulMerged: null, e2eToolHit: result.metrics.e2eToolHit };
    } else if (absent.length) {
      result.live = { status: 'not_run', reason: `清单里 ${absent.length} 个音频文件不存在：${absent.slice(0, 5).map((r) => r.file).join(', ')}` };
      result.metrics = { raw: null, current: null, merged: null, perDomain: null, harmful: null, harmfulMerged: null, e2eToolHit: result.metrics.e2eToolHit };
    } else {
      // 真跑：同一段音频走两遍 —— 一遍不发上下文、一遍发 —— 才把"偏置有没有用"和
      // "事后纠正有没有用"分开。只跑一遍就归功于偏置，两项收益会混在一起。
      const { transcribeAudio } = await import('../server/llm/asr.ts');
      // 产品侧 ASR_CONTEXT_ENABLED 默认关（收益未量化 + 静音输入下模型会回显词表），
      // 但偏置组的请求必须真的发出去：这里只在本次评测进程里把开关打开，
      // 不改 .env、不改产品默认，跑完就消失。
      if (!cfg.contextEnabled) process.env.ASR_CONTEXT_ENABLED = '1';
      const contextText = buildContextText(glossary, {
        maxChars: cfg.contextMaxChars,
        extraTerms: tierA.map((e) => e.canonical)
      }).text;
      // 只有原生协议收 vocabulary；其余协议传了也不会发，applied.hotwords 会如实是 false
      const hotwords = cfg.protocol === 'dashscope_native' ? hotwordVocabulary(glossary, cfg.hotwordsMax) : {};
      const mimeOf = (f) => (f.endsWith('.wav') ? 'audio/wav' : f.endsWith('.mp3') ? 'audio/mpeg' : f.endsWith('.m4a') ? 'audio/mp4' : f.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm');

      /** 一条转写结果的可比字段（targets 显式传入，不靠闭包里的可变状态） */
      const profile = (res, targets) => {
        if (!res.ok) return { ok: false, code: res.code, message: res.message };
        const fixed = correctTranscript(res.text, mergedEntries, mergedOpts);
        return {
          ok: true,
          upstream: res.text,
          corrected: fixed.text,
          upstreamHits: countPresent(res.text, targets).present,
          correctedHits: countPresent(fixed.text, targets).present,
          corrections: fixed.corrections,
          applied: res.applied,
          elapsedMs: res.elapsedMs,
          promptTokens: res.usage?.promptTokens,
          seconds: res.usage?.seconds
        };
      };

      const rows = [];
      for (const r of manifest.recordings) {
        const targets = r.targetTerms ?? [];
        const buf = fs.readFileSync(path.join(audioDir, r.file));
        const base64 = buf.toString('base64');
        const mime = mimeOf(r.file);
        const plain = profile(await transcribeAudio({ base64, mime }), targets);
        const biased = profile(await transcribeAudio({ base64, mime, contextText, hotwords }), targets);
        if (!plain.ok || !biased.ok) {
          rows.push({ id: r.id, status: 'failed', plain, biased });
          continue;
        }
        rows.push({ id: r.id, status: 'ok', reference: r.referenceText, targets: targets.length, plain, biased });
      }

      const done = rows.filter((x) => x.status === 'ok');
      const sum = (side, k) => done.reduce((a, b) => a + (b[side]?.[k] ?? 0), 0);
      const targetTotal = done.reduce((a, b) => a + b.targets, 0);
      const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const tokens = (side) => done.map((x) => x[side]?.promptTokens).filter((v) => typeof v === 'number');
      const result_ = {
        status: 'run',
        model: cfg.model,
        protocol: cfg.protocol,
        contextChars: contextText.length,
        recordings: rows.length,
        succeeded: done.length,
        failed: rows.length - done.length,
        /** 上游原样（不经事后纠错）的术语命中 —— 偏置的作用只体现在这一行 */
        upstreamRecallPlain: targetTotal > 0 ? sum('plain', 'upstreamHits') / targetTotal : null,
        upstreamRecallBiased: targetTotal > 0 ? sum('biased', 'upstreamHits') / targetTotal : null,
        /** 事后纠错之后的命中 —— 两遍都过同一套纠正层 */
        correctedRecallPlain: targetTotal > 0 ? sum('plain', 'correctedHits') / targetTotal : null,
        correctedRecallBiased: targetTotal > 0 ? sum('biased', 'correctedHits') / targetTotal : null,
        degradedBiasedRequests: done.filter((x) => x.biased.applied?.degraded).length,
        contextSentRequests: done.filter((x) => x.biased.applied?.context).length,
        hotwordsSentRequests: done.filter((x) => x.biased.applied?.hotwords).length,
        hotwordCountPerRequest: done[0]?.biased.applied?.hotwordCount ?? 0,
        meanElapsedPlainMs: mean(done.map((x) => x.plain.elapsedMs)),
        meanElapsedBiasedMs: mean(done.map((x) => x.biased.elapsedMs)),
        meanPromptTokensPlain: mean(tokens('plain')),
        meanPromptTokensBiased: mean(tokens('biased')),
        rows
      };
      result.live = result_;
      // live 模式的"误改"口径：上游本来就写对的那些条，事后纠错不得动一个字
      const cleanRows = done.filter((x) => x.biased.upstream === x.reference);
      const chars = cleanRows.reduce((a, b) => a + Array.from(b.biased.upstream).length, 0);
      const edited = cleanRows.reduce((a, b) => a + b.biased.corrections.reduce((s, c) => s + Array.from(c.from).length, 0), 0);
      result.live.controlLikeRows = cleanRows.length;
      result.live.harmfulEditRate = chars > 0 ? edited / chars : null;
      if (result_.upstreamRecallPlain !== null && result_.upstreamRecallBiased !== null) {
        const delta = result_.upstreamRecallBiased - result_.upstreamRecallPlain;
        result.live.upstreamRecallDelta = delta;
        result.notVerified.push(
          delta > 0
            ? `偏置在上游层面带来 +${(delta * 100).toFixed(1)} 个百分点，但样本 ${done.length} 条、口音与环境单一，不能当总体结论。`
            : `偏置没有带来可测的上游提升（Δ=${(delta * 100).toFixed(1)}pp）。本批不宣称它有效，需要更多录音或改走 vocabulary 通道。`
        );
      }
      if (result_.meanPromptTokensPlain === null || result_.meanPromptTokensBiased === null) {
        result.notVerified.push('上游未回传 usage.prompt_tokens，偏置的 token 代价本次无法核对（只记了耗时）。');
      }
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
<tr><td>升级前：只有 Tier A 字符距离</td><td>${pct(result.metrics.current.recall)}</td><td>${pct(result.metrics.current.precision)}</td></tr>
<tr><td><b>现在线上：Tier A ∪ Tier B 同音</b></td><td><b>${pct(result.metrics.merged.recall)}</b></td><td><b>${pct(result.metrics.merged.precision)}</b></td></tr></table>
<h2>分域召回</h2><table><tr><th>域</th><th>场景</th><th>不纠正</th><th>升级前</th><th>现在线上</th></tr>
${Object.entries(result.metrics.perDomain).map(([d, v]) => `<tr><td>${domainNames[d] ?? d}</td><td>${v.scenarios}</td><td>${pct(v.rawRecall)}</td><td>${pct(v.currentRecall)}</td><td><b>${pct(v.mergedRecall)}</b></td></tr>`).join('')}
</table>` : ''}
${result.live ? `<h2>live</h2><table><tr><th>项</th><th>值</th></tr>
${Object.entries(result.live).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `<tr><td>${k}</td><td>${String(v)}</td></tr>`).join('')}</table>` : ''}
<h2>误改率（对照样本 ${result.basis.controlScenarios} 条，<b>必须 0</b>）</h2>
${mode === 'correction' ? `<p class="${result.metrics.harmfulMerged.harmfulEditRate === 0 ? 'ok' : 'bad'}">现在线上口径 harmfulEditRate = ${pct(result.metrics.harmfulMerged.harmfulEditRate)} ｜ 被改动样本 ${result.metrics.harmfulMerged.dirtyRows}/${result.metrics.harmfulMerged.controlCount}</p>
<p>对照：升级前口径 = ${pct(result.metrics.harmful.harmfulEditRate)}（被改动 ${result.metrics.harmful.dirtyRows} 条）</p>
${result.metrics.harmfulMerged.offenders.length ? `<table><tr><th>id</th><th>输入</th><th>输出</th></tr>${result.metrics.harmfulMerged.offenders.map((o) => `<tr><td>${o.id}</td><td>${o.input}</td><td>${o.output}</td></tr>`).join('')}</table>` : '<p class="ok">对照样本逐字未被改动 —— 放宽到 2 字门槛没有换来误改。</p>'}` : ''}
<h2>缺口</h2>
<p>2–3 字目标词 <b>${result.gap.shortTermTargets}</b> 个，术语表已收 ${result.gap.shortCoveredByGlossary} 个；表中仍缺：${result.gap.shortNotInGlossary.join('、') || '（无）'}</p>
<p>保护词（同音常用词，永不替换）：${(result.basis.glossaryProtect || []).join('、')}</p>
<p>歧义音节键（整键跳过）：${result.basis.ambiguousSyllableKeys.length ? result.basis.ambiguousSyllableKeys.join('、') : '当前为 0 —— 空不代表以后也空，匹配器每次都问'}</p>
${result.basis.glossaryValidationProblems.length ? `<h2 class="bad">术语表校验问题</h2><ul>${result.basis.glossaryValidationProblems.map((p) => `<li>${p}</li>`).join('')}</ul>` : '<p class="ok">术语表校验：无问题。</p>'}
<h2>未验证项（只报好消息的报告不可信）</h2><ul>${result.notVerified.map((n) => `<li>${n}</li>`).join('')}</ul>`;
const htmlPath = path.join(outDir, `asr-${mode}-${stamp}.html`);
fs.writeFileSync(htmlPath, html);

if (!quiet) {
  if (mode === 'correction') {
    console.log(`语音术语评测 · correction`);
    console.log(`  场景 ${result.basis.scenarios}（术语 ${result.basis.termScenarios} / 对照 ${result.basis.controlScenarios}）｜ Tier A ${result.basis.tierAEntries} ｜ 术语表 ${result.basis.glossaryTerms} 条 + 保护 ${result.basis.glossaryProtect.length} 条 ${result.basis.glossaryFingerprint}`);
    console.log(`  术语召回   不纠正 ${pct(result.metrics.raw.recall)}  →  升级前 ${pct(result.metrics.current.recall)}  →  现在线上 ${pct(result.metrics.merged.recall)}`);
    console.log(`  术语精确   不纠正 ${pct(result.metrics.raw.precision)}  →  升级前 ${pct(result.metrics.current.precision)}  →  现在线上 ${pct(result.metrics.merged.precision)}`);
    console.log(`  误改率     升级前 ${pct(result.metrics.harmful.harmfulEditRate)}  →  现在线上 ${pct(result.metrics.harmfulMerged.harmfulEditRate)}（对照被改 ${result.metrics.harmfulMerged.dirtyRows}/${result.metrics.harmfulMerged.controlCount} 条）`);
    console.log(`  豁免守住   ${result.metrics.declineAuditMerged.checked - result.metrics.declineAuditMerged.broken.length}/${result.metrics.declineAuditMerged.checked}（刻意不纠的常用词被改了就算误改）`);
    console.log(`  分域召回   ${Object.entries(result.metrics.perDomain).map(([d, v]) => `${domainNames[d] ?? d} ${pct(v.currentRecall)}→${pct(v.mergedRecall)}`).join('  ')}`);
    console.log(`  缺口       2–3 字词 ${result.gap.shortTermTargets} 个，术语表已收 ${result.gap.shortCoveredByGlossary} 个${result.gap.shortNotInGlossary.length ? `，仍缺 ${result.gap.shortNotInGlossary.join('、')}` : ''}`);
    if (result.basis.glossaryValidationProblems.length) console.log(`  ⚠ 术语表校验 ${result.basis.glossaryValidationProblems.length} 项问题`);
    console.log(`  未验证     ${result.notVerified.length} 项（详见报告）`);
  } else {
    console.log(`语音术语评测 · ${mode}：${JSON.stringify(result.live ?? result.e2e ?? {}, null, 2).slice(0, 900)}`);
  }
  console.log(`  报告       ${path.relative(root, jsonPath)}`);
}

fs.rmSync(temp, { recursive: true, force: true });
// 发布硬门槛：两个口径的误改率都必须是 0，尤其是**生产口径这套**
if (mode === 'correction') {
  for (const key of ['harmful', 'harmfulMerged']) {
    if (result.metrics[key].harmfulEditRate !== 0) {
      console.error(`\n${key} 误改率非 0 —— 这是发布硬门槛（宁可不改，也不改错），本批不予验收。`);
      process.exitCode = 1;
    }
  }
  // 豁免必须守住：刻意不纠的常用词（保修/登机/赵明…）被改了，就是把对的改错了
  if (result.metrics.declineAuditMerged.broken.length) {
    console.error('\n豁免被击穿 —— 以下"独立常用词"遭替换：' + result.metrics.declineAuditMerged.broken.map((b) => `${b.id}:${b.surface}`).join(', '));
    process.exitCode = 1;
  }
  // 反向门槛：接了同音路径却一点没提升，说明根本没生效，不接受"静默空转"
  if (result.metrics.merged.recall !== null && result.metrics.current.recall !== null
    && result.metrics.merged.recall <= result.metrics.current.recall) {
    console.error('\nmerged 口径召回没有超过升级前 —— Tier B 要么没接上，要么词表没覆盖到这些场景。');
    process.exitCode = 1;
  }
}
if (result.basis.glossaryValidationProblems.length) process.exitCode = 1;
