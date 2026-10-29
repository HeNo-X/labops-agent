#!/usr/bin/env node
/**
 * 首屏载荷基线（WS2.7）—— 把"性能"从形容词变成可复跑的数字。
 * ============================================================================
 *  只测两件事，都是能证伪的：
 *   ① 每个 HTML 入口**实际**会拉起的 JS/CSS 体积（gzip），按 <script>/<link>
 *      逐个解析 —— 不估、不按 dist 总量糊；
 *   ② 引用是否存在（缺失即失败，与 check:rules 的 HTML 引用检查互为补位：
 *      那个查 public/ 源文件，这个查构建产物）。
 *
 *  预算是**上限**而非目标：低于它就报通过。数字写进文档，改动了就要重跑。
 *
 *  运行：node scripts/analyze-bundle.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/** 预算（gzip KB）。桌面含更多交互面板，故高于移动。 */
const BUDGET = { 'index.html': { js: 200, css: 40 }, 'mobile.html': { js: 160, css: 20 } };

if (!fs.existsSync(dist)) {
  console.error('dist/ 不存在，先执行 npm run build');
  process.exit(2);
}

const gz = (f) => {
  try {
    return zlib.gzipSync(fs.readFileSync(f)).length;
  } catch {
    return -1;
  }
};
const kb = (n) => n / 1024;

const results = [];
for (const [html, budget] of Object.entries(BUDGET)) {
  const src = fs.readFileSync(path.join(dist, html), 'utf8');
  const refs = [...src.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  let js = 0;
  let css = 0;
  const missing = [];
  const detail = [];
  for (const r of refs) {
    const file = path.join(dist, r.replace(/^\//, '').replace(/^\.\//, ''));
    const bytes = gz(file);
    if (bytes < 0) {
      missing.push(r);
      continue;
    }
    detail.push({ ref: r, kind: r.endsWith('.css') ? 'css' : 'js', gzipKB: +kb(bytes).toFixed(2) });
    if (r.endsWith('.css')) css += bytes;
    else js += bytes;
  }
  const inlineScript = kb([...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('').length);
  results.push({
    entry: html,
    jsKB: +kb(js).toFixed(2),
    cssKB: +kb(css).toFixed(2),
    inlineKB: +inlineScript.toFixed(2),
    totalKB: +kb(js + css).toFixed(2),
    requests: refs.length,
    budgetKB: budget.js + budget.css,
    overBudget: kb(js) > budget.js || kb(css) > budget.css,
    missing,
    heaviest: detail.sort((a, b) => b.gzipKB - a.gzipKB).slice(0, 5)
  });
}

const totalAssets = fs.readdirSync(path.join(dist, 'assets')).filter((f) => /\.(js|css)$/.test(f));
let lazyKB = 0;
for (const f of totalAssets) lazyKB += kb(gz(path.join(dist, 'assets', f)));
// 首屏集合必须**去重**：i18n 等 chunk 被两个入口共享，按入口累加会重复计数，
// 导致"首屏 > 全量"的荒谬结论。
const singleEntryKB = Math.max(...results.map((r) => r.jsKB + r.cssKB));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), entries: results, chunks: totalAssets.length, allAssetsGzipKB: +lazyKB.toFixed(2) }, null, 2));
} else {
  console.log(`构建产物：${totalAssets.length} 个 chunk，合计 ${lazyKB.toFixed(1)} KB gzip\n`);
  for (const r of results) {
    const flag = r.overBudget ? '✗ 超预算' : '✓ 在预算内';
    console.log(`${r.entry.padEnd(13)} 首屏 ${r.totalKB.toFixed(1)} KB gzip（JS ${r.jsKB} + CSS ${r.cssKB} + 内联 ${r.inlineKB}）`);
    console.log(`${' '.repeat(13)} ${r.requests} 个请求 · 预算 ${r.budgetKB} KB · ${flag}`);
    if (r.missing.length) console.log(`${' '.repeat(13)} ⚠ 引用缺失：${r.missing.join(', ')}`);
    console.log(`${' '.repeat(13)} 最重：${r.heaviest.slice(0, 3).map((d) => `${d.ref.split('/').pop()} ${d.gzipKB}KB`).join(' · ')}`);
    console.log();
  }
  console.log(`单入口最重首屏：${singleEntryKB.toFixed(1)} KB / 全量 ${lazyKB.toFixed(1)} KB ⇒ 约 ${((1 - singleEntryKB / lazyKB) * 100).toFixed(0)}% 的代码不在该入口首屏路径上`);
}

const failed = results.some((r) => r.overBudget || r.missing.length);
process.exit(failed ? 1 : 0);
