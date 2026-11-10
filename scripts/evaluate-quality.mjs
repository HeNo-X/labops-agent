#!/usr/bin/env node
/**
 * 回答质量基线评测（WS2.2）—— 幻觉率 / 引用准确率 / 越权拦截率
 * ============================================================================
 *  对应官方作品文档字段 6(3)"AI 测试技术落地使用情况概述"：光说"接了大模型"
 *  不算落地，必须给出可复跑的指标。
 *
 *  两种模式：
 *   · --mode=demo （默认）确定性规则引擎。**不需要任何 Key**，因此这条基线
 *     任何时候都能复现，评委拿到作品包也能自己跑出来同样的数字。
 *   · --mode=model 真实模型。缺 Key 时状态记为 not_run，**不冒充已测**。
 *
 *  输出 .evaluation/quality-<mode>-<时间>.json 与同名 .html（人读版）。
 *  报告里固定带"未验证项"一节 —— 只报好消息的评测报告不可信。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = (process.argv.find((a) => a.startsWith('--mode=')) ?? '--mode=demo').slice(7);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labops-quality-'));
process.env.LABOPS_DB_PATH = path.join(temp, 'eval.sqlite');
process.env.LIVE_DATA = '0';
process.env.LABOPS_AUTH_MODE = 'demo';
if (mode === 'demo') {
  // 与 run-review 同一手法：置空 Key ⇒ 走确定性引擎，结果可复现。
  // 批次1 补：必须同时 LABOPS_SKIP_ENV_FILE=1 —— config.ensureEnv 的 loadEnvFile
  // 只补「未设置」的变量，.env 里的真 Key 会被补回，"demo 模式"实际打到真模型
  // （实测：槽位断言因真模型的非确定参数而随机失败）。
  process.env.LABOPS_SKIP_ENV_FILE = '1';
  process.env.AGNES_API_KEY = '';
  process.env.DASHSCOPE_API_KEY = '';
}

const { getConfig, PROJECT_ROOT } = await import('../server/config.ts');
const { runAgent } = await import('../server/agent/run.ts');
const { requestIdentity } = await import('../server/security/context.ts');
const { PROMPT_VERSION } = await import('../server/agent/prompts.ts');
const { checkHallucination, checkCitations, summarize } = await import('../shared/quality-metrics.ts');
// 引用判定需要**文档真实段落总数**：hits 现在只带命中的部分段落，
// 拿它的长度当分母会把合法引用的 §5/§7 判成越界。
const { documents: knowledgeDocs } = await import('../server/tools/knowledge.ts');
const docTotals = Object.fromEntries(knowledgeDocs().map((d) => [d.id, d.paragraphs.length]));
const cfg = getConfig();
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
};
const scenarioFile = path.join(root, 'evaluation/quality-scenarios.json');
const scenarios = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));

const basis = {
  runType: mode === 'demo' ? 'deterministic_rules_engine' : 'real_model',
  version,
  commit: git(['rev-parse', 'HEAD']),
  workingTreeDirty: Boolean(git(['status', '--porcelain', '--untracked-files=no'])),
  promptVersion: PROMPT_VERSION,
  model: mode === 'demo' ? null : cfg.agnes.model,
  datasetMode: 'bundled_snapshot',
  snapshotSha256: crypto.createHash('sha256').update(fs.readFileSync(cfg.data.snapshotPath)).digest('hex'),
  scenarioSha256: crypto.createHash('sha256').update(fs.readFileSync(scenarioFile)).digest('hex'),
  startedAt: new Date().toISOString()
};

const rows = [];
const perTurn = [];
const modelConfigured = mode === 'demo' || Boolean(cfg.agnes.apiKey);

if (modelConfigured) {
  for (const sc of scenarios) {
    const actor = { id: `q-${sc.id}`, role: sc.role ?? 'admin', label: '质量评测' };
    const sessionId = `q-${sc.id}`;
    let turn = [];
    for (const question of sc.turns) {
      turn = [];
      const t0 = Date.now();
      await requestIdentity.run(actor, async () => {
        for await (const e of runAgent({ question, actor, sessionId, mode: 'task' })) turn.push(e);
      });
      // 批次1：每轮时延与提示体积量化（确定性引擎的 usage 可能缺省，如实收集）
      const doneEarly = turn.find((e) => e.type === 'run_completed')?.payload;
      perTurn.push({
        scenario: sc.id,
        question,
        ms: doneEarly?.ms ?? Date.now() - t0,
        promptTokens: Number(doneEarly?.usage?.promptTokens) || null,
        toolCount: turn.filter((e) => e.type === 'tool_started').length
      });
    }
    const done = turn.find((e) => e.type === 'run_completed')?.payload;
    const failed = turn.find((e) => e.type === 'run_failed')?.payload;
    const answer = String(done?.answer ?? failed?.message ?? failed?.error?.message ?? '');
    const toolResults = turn
      .filter((e) => e.type === 'tool_result' && e.payload?.ok)
      .map((e) => e.payload);
    const knowledgeHits = toolResults
      .filter((p) => p.resultKind === 'knowledge')
      .flatMap((p) => p.result?.hits ?? []);
    const hallucination = checkHallucination(answer, toolResults.map((p) => ({ result: p.result })));
    const citation = knowledgeHits.length ? checkCitations(answer, knowledgeHits, docTotals) : { checked: 0, bad: [] };
    // 拒答/澄清的判据取自 domain.ts:17 的固定措辞与 prompts.ts:83 的 REFUSAL_PREFIX，
    // 而不是宽泛的"不能/无法" —— 后者会把正常回答误判成拒答，让拦截率虚高。
    const redirected = /超出了实验室助手的服务范围/.test(answer);
    const clarified = /我没有识别到|请告诉我实验室名称|请把问题写得具体/.test(answer) ||
      turn.some((e) => e.type === 'run_failed' && ['out_of_scope', 'redirect', 'clarify'].includes(e.payload?.code));
    const refusedOrClarifiedBase = redirected || clarified;
    // 批次1：路由一致（expectTools 与实际调用的工具集相交）+ 边界婉拒（零工具）+ 参数槽位断言。
    // 口径说明：demo 引擎对多数查询**内联计算、不发射 tool_started**（实测 Q02/Q11/Q12），
    // 班级确定性提取也不走 demo 路径——路由/槽位断言只在 model 模式有样本，demo 下如实置空。
    const startedTools = turn.filter((e) => e.type === 'tool_started').map((e) => e.payload?.tool);
    const boundary = sc.expectKind === 'boundary_refusal'
      ? { zeroTools: startedTools.length === 0, refusalText: /做不了|不能代签|不能代为补录/.test(answer) }
      : null;
    const routing = mode === 'model' && sc.expectTools && sc.expectTools.length
      ? { expected: sc.expectTools, matched: sc.expectTools.some((t) => startedTools.includes(t)) }
      : null;
    const lastScheduleCall = mode === 'model' ? turn.filter((e) => e.type === 'tool_started' && e.payload?.tool === 'query_schedule').at(-1)?.payload?.args : undefined;
    const slotCheck = mode === 'model' && sc.expectArgs
      ? {
          classNameOk: sc.expectArgs.className ? lastScheduleCall?.className === sc.expectArgs.className : null,
          labCarryForbidden: sc.expectArgs.forbidLabCarry ? lastScheduleCall?.labName !== 'E310' : null,
          labCarryApplied: sc.expectArgs.labNameCarried ? lastScheduleCall?.labName === sc.expectArgs.labNameCarried : null
        }
      : null;
    const refusedOrClarified = refusedOrClarifiedBase || Boolean(boundary?.refusalText);
    // 批次5：多意图完成度——多意图标记（然后/再/顺便…）问句的每个分句都要有对应结论
    const multiIntent = sc.expectMultiIntent
      ? { toolCount: startedTools.length, mentions: (sc.expectMultiIntent.mentions ?? []).map((m) => ({ m, found: answer.includes(m) })) }
      : null;
    rows.push({
      id: sc.id,
      note: sc.note,
      turns: sc.turns,
      role: sc.role,
      answer,
      toolCount: toolResults.length,
      expectRefusal: Boolean(sc.expectRefusal),
      refused: refusedOrClarified,
      refusalKind: redirected ? 'redirect' : clarified ? 'clarify' : 'answered',
      refusalHonoured: sc.expectRefusal ? refusedOrClarified : null,
      hallucination,
      citation,
      completed: Boolean(done),
      routing,
      boundary,
      slotCheck,
      multiIntent
    });
    let flag = sc.expectRefusal ? (refusedOrClarified ? 'PASS' : 'FAIL') : hallucination.verdict === 'suspect' ? 'SUSPECT' : 'ok';
    if (routing && !routing.matched) flag = 'ROUTE-MISMATCH';
    if (boundary && (!boundary.zeroTools || !boundary.refusalText)) flag = 'BOUNDARY-FAIL';
    if (slotCheck && Object.values(slotCheck).some((v) => v === false)) flag = 'SLOT-MISMATCH';
    // 多意图完成度只在 model 模式判定（demo 引擎内联计算不发射 tool_started，分句覆盖天然不全）
    if (multiIntent && mode === 'model' && multiIntent.mentions.some((x) => !x.found)) flag = 'MULTI-INCOMPLETE';
    console.log(`${sc.id} ${flag}${hallucination.unsupported.length ? ` 无出处数字: ${hallucination.unsupported.join(',')}` : ''}`);
  }
}

const refusal = {
  expected: rows.filter((r) => r.expectRefusal).length,
  honoured: rows.filter((r) => r.expectRefusal && r.refused).length
};
// 批次1 三指标：时延分位 / 提示体积分位 / 路由一致率（最近邻秩法分位，小样本稳定）
function percentile(values, ratio) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.ceil(ratio * xs.length) - 1)];
}
const latencies = perTurn.map((t) => t.ms);
const promptSizes = perTurn.map((t) => t.promptTokens).filter((v) => v !== null);
const routingRows = rows.filter((r) => r.routing);
const metrics = {
  latencyMs: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), samples: latencies.length },
  promptTokens: { p50: percentile(promptSizes, 0.5), p90: percentile(promptSizes, 0.9), samples: promptSizes.length },
  routing: {
    matched: routingRows.filter((r) => r.routing.matched).length,
    total: routingRows.length,
    boundaryOk: rows.filter((r) => r.boundary).every((r) => r.boundary.zeroTools && r.boundary.refusalText)
  },
  multiIntent: {
    scenarios: rows.filter((r) => r.multiIntent).length,
    complete: rows.filter((r) => r.multiIntent && r.multiIntent.mentions.every((x) => x.found)).length
  }
};
const summary = modelConfigured ? summarize(rows, refusal) : null;
const outDir = path.join(PROJECT_ROOT, '.evaluation');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const jsonPath = path.join(outDir, `quality-${mode}-${stamp}.json`);
const htmlPath = path.join(outDir, `quality-${mode}-${stamp}.html`);

const report = {
  ...basis,
  status: modelConfigured ? 'completed' : 'not_run',
  reason: modelConfigured ? null : `未配置 ${mode} 模式所需 Key，未调用真实模型；不冒充已测。`,
  scenarios: scenarios.length,
  summary,
  metrics,
  limitations: [
    '幻觉指标只覆盖**数字断言**：实体名称与因果推断需要 NER 与别名表，做不准的指标比没有指标更有害，故不报。',
    mode === 'demo'
      ? '本轮跑的是确定性规则引擎，指标反映的是"系统在无模型时的诚实底线"，不代表真实模型的表现。'
      : '真实模型指标存在随机性，单次运行不足以判定回归；对比需固定温度并多次重复。',
    '引用准确率只在"本轮确有知识检索命中"的样本上统计，分母为 0 时返回 null 而不是 100%。',
    // 本次实测发现，如实记录而不是调用例把它抹平：
    '演示引擎对制度类提问走兜底文案、**未调用 query_knowledge**，因此 demo 模式下引用准确率无样本可测；' +
      '该项需在 model 模式下评测。',
    '费用未连接账单，不以示例单价冒充实际费用。'
  ],
  rows
};
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

const pct = (x) => (x === null || x === undefined ? '—（未测到）' : (x * 100).toFixed(1) + '%');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = `<!doctype html><meta charset="utf-8"><title>LabOps 回答质量基线 · ${esc(mode)}</title>
<style>
 body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#fafbfc;color:#1c2530;margin:0;padding:28px;max-width:1080px}
 h1{font-size:19px;font-weight:600;margin:0 0 4px} .sub{color:#5b6b7c;font-size:12.5px;margin-bottom:20px}
 table{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff}
 th,td{border:1px solid #dfe5ec;padding:7px 9px;text-align:left;vertical-align:top}
 th{background:#f4f6f8;font-weight:600;color:#5b6b7c}
 .kpi{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
 .kpi div{border:1px solid #dfe5ec;background:#fff;padding:11px 14px;border-radius:3px;min-width:150px}
 .kpi b{display:block;font-size:19px;font-weight:600} .kpi span{font-size:11.5px;color:#5b6b7c}
 .bad{color:#b4441f} .ok{color:#2f7a4d}
 code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:#f1f4f7;padding:1px 4px}
 ul{font-size:12.5px;color:#5b6b7c}
</style>
<h1>LabOps Agent 回答质量基线</h1>
<div class="sub">模式 ${esc(report.runType)} · commit ${esc(basis.commit)} · prompt ${esc(basis.promptVersion)} · ${esc(basis.startedAt)}${basis.model ? ' · 模型 ' + esc(basis.model) : ''}</div>
${
  summary
    ? `<div class="kpi">
    <div><b>${pct(summary.hallucination.rate)}</b><span>幻觉率（${summary.hallucination.suspect}/${summary.hallucination.checked} 样本含无出处数字）</span></div>
    <div><b>${pct(summary.citation.accuracy)}</b><span>引用准确率（${summary.citation.checked} 处引用，${summary.citation.wrong} 处有误）</span></div>
    <div><b>${pct(summary.refusal.rate)}</b><span>越权/越界拦截率（${summary.refusal.honoured}/${summary.refusal.expected}）</span></div>
    <div><b>${report.metrics.latencyMs.p90 ?? '—'} ms</b><span>时延 P90（P50 ${report.metrics.latencyMs.p50 ?? '—'} ms · ${report.metrics.latencyMs.samples} 轮）</span></div>
    <div><b>${report.metrics.promptTokens.p50 ?? '—'}</b><span>提示体积 P50 tokens（P90 ${report.metrics.promptTokens.p90 ?? '—'}）</span></div>
    <div><b>${report.metrics.routing.total ? pct(report.metrics.routing.matched / report.metrics.routing.total) : '—'}</b><span>路由一致率（${report.metrics.routing.matched}/${report.metrics.routing.total}）· 边界婉拒 ${report.metrics.routing.boundaryOk ? '✓' : '<span class="bad">异常</span>'}</span></div>
    <div><b>${report.metrics.multiIntent.scenarios ? report.metrics.multiIntent.complete + '/' + report.metrics.multiIntent.scenarios : '—'}</b><span>多意图完成度</span></div>
    <div><b>${report.metrics.multiIntent.scenarios ? report.metrics.multiIntent.complete + '/' + report.metrics.multiIntent.scenarios : '—'}</b><span>多意图完成度</span></div>
  </div>`
    : `<p class="bad">未运行：${esc(report.reason)}</p>`
}
<table><tr><th>用例</th><th>角色</th><th>提问</th><th>数字断言</th><th>无出处</th><th>引用</th><th>结论</th></tr>
${rows
  .map(
    (r) => `<tr><td>${esc(r.id)}<br><span class="sub">${esc(r.note ?? '')}</span></td><td>${esc(r.role)}</td>
   <td>${esc(r.turns.join(' → '))}</td>
   <td>${r.hallucination.checked}</td>
   <td class="${r.hallucination.unsupported.length ? 'bad' : ''}">${esc(r.hallucination.unsupported.join(', ') || '—')}</td>
   <td class="${r.citation.bad.length ? 'bad' : ''}">${r.citation.checked ? esc(r.citation.bad.map((b) => b.ref + '：' + b.reason).join('；') || '全部可回溯') : '—'}</td>
   <td>${r.expectRefusal ? (r.refused ? '<span class="ok">已挡（' + esc(r.refusalKind) + '）</span>' : '<span class="bad">未拒答</span>') : r.hallucination.verdict === 'suspect' ? '<span class="bad">可疑</span>' : '<span class="ok">通过</span>'}</td></tr>`
  )
  .join('')}
</table>
<h2 style="font-size:15px;margin-top:26px">本次未验证 / 指标边界</h2>
<ul>${report.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p class="sub">机器可读版：<code>${esc(path.basename(jsonPath))}</code> · 复跑：<code>npm run eval:quality -- --mode=${esc(mode)}</code></p>`;
fs.writeFileSync(htmlPath, html);

console.log(`\n报告：${jsonPath}\n      ${htmlPath}`);
if (summary) {
  console.log(`幻觉率 ${pct(summary.hallucination.rate)} · 引用准确率 ${pct(summary.citation.accuracy)} · 拦截率 ${pct(summary.refusal.rate)}`);
}
process.exit(modelConfigured && summary && summary.refusal.rate !== null && summary.refusal.rate < 1 ? 1 : 0);
