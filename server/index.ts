/**
 * HTTP 入口 —— API + 静态托管（单文件启动）
 * ============================================================================
 *  为什么用 node:http 而不是 Express：本项目 API 只有 3 个端点，不需要路由树、
 *  中间件生态和 100+ 传递依赖。少一个依赖就少一类供应链风险。
 *
 *  ⚠️ 静态托管用**白名单**（只放行已知安全扩展名）+ **显式禁区**（/server /seed
 *     /docs /node_modules .env）。老系统踩过的坑：静态服务是黑名单式，serve.js
 *     落在站点根且 .js 在放行名单里 → 后端源码被公网直接下载（HTTP 200 / 77,850 B）。
 *     黑名单永远会漏，白名单不会。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeConfig, getConfig, PROJECT_ROOT } from './config.ts';
import { handleAgentChat, readJsonBody } from './api/agent-chat.ts';
import { loadDataset, verifySnapshotIntegrity } from './data/store.ts';
import { runtimeCapabilities } from './agent/run.ts';
import { isAgnesConfigured } from './llm/agnes.ts';
import { loggerFor } from './obs/trace.ts';
import { PROMPT_VERSION } from './agent/prompts.ts';

const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const log = loggerFor('http');

// ---- 静态白名单：不在表里的一律 404 ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/** 显式禁区：即使扩展名在白名单里，这些路径也不许通过静态通道出去 */
const DENY_SEGMENTS = ['server', 'seed', 'docs', 'node_modules', 'tests', 'scripts', '.git', '.workbuddy'];

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  if (!fs.existsSync(DIST_DIR)) {
    json(res, 503, {
      error: 'frontend_not_built',
      message: '未找到 dist/ 目录。开发时请用 `npm run dev`（Vite 提供前端）；生产请先 `npm run build`。'
    });
    return;
  }

  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    json(res, 400, { error: 'bad_url_encoding', message: 'URL 编码非法' });
    return;
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const segments = rel.split('/').filter(Boolean);
  // 隐藏文件（.env / .git/…）一律拒绝
  if (segments.some((s) => s.startsWith('.'))) {
    json(res, 403, { error: 'forbidden', message: '禁止访问隐藏路径' });
    return;
  }
  if (segments.some((s) => DENY_SEGMENTS.includes(s.toLowerCase()))) {
    json(res, 403, { error: 'forbidden', message: '禁止通过静态通道访问该目录' });
    return;
  }

  const target = path.resolve(DIST_DIR, '.' + rel);
  // 目录穿越防护：解析后的绝对路径必须仍在 dist 之内
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + path.sep)) {
    json(res, 403, { error: 'forbidden', message: '路径越界' });
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    json(res, 404, { error: 'not_found', message: `静态资源类型不被允许：${ext || '(无扩展名)'}` });
    return;
  }

  let finalPath = target;
  if (!fs.existsSync(finalPath) || fs.statSync(finalPath).isDirectory()) {
    // SPA 回退：非资源请求交给 index.html
    if (mime === 'text/html' || !path.extname(finalPath)) {
      finalPath = path.join(DIST_DIR, 'index.html');
      if (!fs.existsSync(finalPath)) {
        json(res, 404, { error: 'not_found', message: '未找到 index.html' });
        return;
      }
    } else {
      json(res, 404, { error: 'not_found', message: `静态资源不存在：${rel}` });
      return;
    }
  }

  const data = fs.readFileSync(finalPath);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(finalPath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
    // 带 hash 的资源可长缓存；index.html 必须短缓存，否则发新版用户看不到
    'Cache-Control': /index\.html$/.test(finalPath) ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(data);
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;

  // 健康检查：给运行状态一个可机读的入口，也方便部署后验证
  if (req.method === 'GET' && (p === '/api/agent/health' || p === '/api/health')) {
    const ds = loadDataset();
    json(res, 200, {
      ok: true,
      service: 'labops-agent',
      stage: 1,
      capability: runtimeCapabilities(),
      data: {
        sourceType: ds.sourceType,
        sourceLabel: ds.sourceLabel,
        snapshotAt: ds.meta.snapshotAt ?? null,
        sourceSha256Prefix: ds.meta.sourceSha256Prefix ?? null,
        counts: { labs: ds.labs.length, openLabs: ds.openLabs.length, timetable: ds.timetable.length },
        term: ds.term,
        loadedAt: ds.loadedAt,
        warnings: ds.warnings
      },
      snapshotIntegrity: verifySnapshotIntegrity(),
      promptVersion: PROMPT_VERSION
    });
    return;
  }

  // 只读概览：前端实验室矩阵用（房间 + 学期 + 数据来源 + 当前引擎），不含任何人员数据
  if (req.method === 'GET' && p === '/api/state') {
    const ds = loadDataset();
    json(res, 200, {
      sourceType: ds.sourceType,
      sourceLabel: ds.sourceLabel,
      // 引擎必须在第一次任务之前就能告诉前端 —— 否则页面会默认声称"在用 Agnes"，
      // 而服务端其实处于演示引擎模式（界面上的机制说明就成了假话）。
      engine: isAgnesConfigured() ? 'agnes' : 'demo',
      provenance: {
        snapshotAt: ds.meta.snapshotAt ?? null,
        sourceSha256Prefix: ds.meta.sourceSha256Prefix ?? null,
        loadedAt: ds.loadedAt
      },
      term: ds.term,
      labs: ds.labs,
      openLabs: ds.openLabs,
      timetableCount: ds.timetable.length,
      warnings: ds.warnings
    });
    return;
  }

  if (p === '/api/agent/chat') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed', message: '请用 POST' });
      return;
    }
    await handleAgentChat(req, res);
    return;
  }

  if (p.startsWith('/api/')) {
    // 兜底：把请求体读完再回，避免客户端写 body 时收到 RST
    await readJsonBody(req).catch(() => undefined);
    json(res, 404, { error: 'unknown_endpoint', message: `未实现的接口：${req.method} ${p}` });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'method_not_allowed', message: '静态资源只支持 GET' });
    return;
  }
  serveStatic(res, p);
}

function main(): void {
  const cfg = getConfig();
  let ds;
  try {
    ds = loadDataset(true);
  } catch (err) {
    console.error('[启动失败] 数据层无法初始化：', (err as Error).message);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    // 兜底：路由层任何未捕获异常都不能把进程带崩
    const t0 = Date.now();
    route(req, res)
      .catch((err: unknown) => {
        log.error('route_unhandled_error', { url: req.url, message: (err as Error).message });
        if (!res.headersSent) json(res, 500, { error: 'internal_error', message: '服务端内部错误' });
        else res.end();
      })
      .finally(() => {
        log.debug('request_done', { method: req.method, url: req.url, ms: Date.now() - t0, status: res.statusCode });
      });
  });

  server.listen(cfg.port, () => {
    console.log('────────────────────────────────────────────────────────────');
    console.log(' LabOps Agent · 实验室任务画布（第一阶段） 服务端已启动');
    console.log('────────────────────────────────────────────────────────────');
    for (const line of describeConfig(cfg)) console.log(' ' + line);
    console.log(' 数据来源        : ' + ds!.sourceLabel + '（' + ds!.sourceType + '）');
    console.log(' 规模            : labs ' + ds!.labs.length + ' / openLabs ' + ds!.openLabs.length + ' / timetable ' + ds!.timetable.length);
    console.log(' 学期            : ' + ds!.term.term + '，起始日 ' + (ds!.term.termStart ?? '未配置'));
    console.log(' 快照完整性      : ' + verifySnapshotIntegrity());
    console.log(' Prompt 版本     : ' + PROMPT_VERSION);
    console.log(' 监听            : http://127.0.0.1:' + cfg.port);
    console.log(' API             : GET  /api/agent/health   GET /api/state   POST /api/agent/chat (SSE)');
    if (ds!.warnings.length) {
      console.log(' 载入告警:');
      for (const w of ds!.warnings) console.log('   - ' + w);
    }
    if (!cfg.agnes.apiKey) {
      console.log(' ');
      console.log(' ⚠️  未配置 AGNES_API_KEY → 当前运行在【演示引擎】模式（服务端规则解析）。');
      console.log('    界面与回答都会明确标注；数据来源不受影响。');
      console.log('    配置 .env 后重启即可切换到 Agnes 3.0 Flash。');
    }
    console.log('────────────────────────────────────────────────────────────');
  });

  const shutdown = (sig: string): void => {
    console.log(`\n[${sig}] 正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 只在直接执行时启动（被 import 时只导出路由，便于测试复用）
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

export { route as handleRequest, main as startServer };
