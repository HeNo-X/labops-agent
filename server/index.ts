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
import { documents } from './tools/knowledge.ts';
import { currentActor } from './security/context.ts';
import {importHistory} from './api/history-import.ts';
import {handleNativeAuth,authMode} from './security/native-auth.ts';
import { effectiveRole, handleBusinessApi, loadAuthorizedDataset } from './business/bridge.ts';
import { withHttpIdentity } from './security/http.ts';
import { CLIENT_API_REVISION } from './security/client-cors.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeConfig, getConfig, PROJECT_ROOT } from './config.ts';
import { handleAgentChat, readJsonBody } from './api/agent-chat.ts';
import { handleTranscribe } from './api/transcribe.ts';
import { handleAsrLexiconCheck } from './api/asr-lexicon-report.ts';
import { handleVisionApi } from './api/vision-api.ts';
import { handleServiceAgent } from './api/service-agent.ts';
import { handleConversations } from './api/conversations.ts';
import { handleKnowledgeApi } from './api/knowledge-api.ts';
import { handleTasksApi } from './api/tasks.ts';
import { loadDataset, verifySnapshotIntegrity } from './data/store.ts';
import { runtimeCapabilities } from './agent/run.ts';
import { engineForMode, modelPlan, circuitHealth } from './llm/router.ts';
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
  '.webmanifest':'application/manifest+json; charset=utf-8',
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
  // 缓存策略：只有 Vite 产出的 /assets/<name>-<hash>.<ext> 才能长缓存 —— 它的内容变了名字必变。
  // 判据用"是否在 assets/ 目录下"，**不要猜文件名里有没有哈希**：
  //   login-characters.js 里的 "-characters" 长得完全像哈希，猜文件名会误判成可长缓存，
  //   于是 public/ 拷进来的固定名文件被永久缓存，用户侧永远看不到新版本
  //   （2026-10-04 实际踩过：修了登录页 bug，用户"没反应"）
  // 其余（public/ 拷来的、favicon、index.html）一律 no-cache：每次带条件请求回来校验，成本极低。
  const relToDist = path.relative(DIST_DIR, finalPath).split(path.sep).join('/');
  const cacheControl = relToDist.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(finalPath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(data);
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;
  if(await handleNativeAuth(req,res,p))return;
  if(p==='/api/shared-chat/history-import'||p==='/api/chat/history-import'){await importHistory(req,res);return;}
  if(p.startsWith('/api/shared-chat/conversations')){await handleConversations(req,res,p.replace('/api/shared-chat/','/api/'));return;}

  // RAG 批次2：向量索引管理端点（reindex/vec-status）——必须排在下面的
  // 「/api/knowledge/:id 文档读取」之前，否则 reindex 会被当成文档 id
  if (p.startsWith('/api/knowledge/') && (p === '/api/knowledge/reindex' || p === '/api/knowledge/vec-status')) { await handleKnowledgeApi(req, res, p); return; }
  if (p.startsWith('/api/knowledge/') && req.method === 'GET') { const doc=documents().find(d=>d.id===p.slice('/api/knowledge/'.length)&&d.roles.includes(effectiveRole(currentActor()?.role||'student'))); json(res,doc?200:404,doc||{error:'document_not_found'}); return; }
  if (p.startsWith('/api/business/')) { await handleBusinessApi(req,res,p); return; }

  // 健康检查：给运行状态一个可机读的入口，也方便部署后验证
  if (req.method === 'GET' && (p === '/api/agent/health' || p === '/api/health')) {
    const ds = authMode()==='native'?null:loadDataset();
    json(res, 200, {
      ok: true,
      service: 'labops-agent',
      version:'1.0.5.0',build:process.env.BUILD_ID||'20261027-ux-overhaul',contractVersion:3,
      clientProtocol:1,clientApiRevision:CLIENT_API_REVISION,
      stage:'unified-chat-persistent-scheduler',
      capability: runtimeCapabilities(),
      authMode:authMode(),
      // 熔断现状：哪个模型正被暂时跳过、还剩多久。放在 health 而非 state，
      // 因为它描述的是**上游健康**，与当前账号能看到什么数据无关，也不需要授权。
      circuitByMode: { chat: circuitHealth('chat').providers, task: circuitHealth('task').providers },
      data: ds?{
        sourceType: ds.sourceType,
        sourceLabel: ds.sourceLabel,
        snapshotAt: ds.meta.snapshotAt ?? null,
        sourceSha256Prefix: ds.meta.sourceSha256Prefix ?? null,
        counts: { labs: ds.labs.length, openLabs: ds.openLabs.length, timetable: ds.timetable.length },
        term: ds.term,
        loadedAt: ds.loadedAt,
        warnings: ds.warnings
      }:{sourceType:'authorized_api',sourceLabel:'登录后按实际账号查询主系统',authorized:false,connected:null},
      snapshotIntegrity: ds?verifySnapshotIntegrity():null,
      promptVersion: PROMPT_VERSION
    });
    return;
  }

  // 只读概览：前端实验室矩阵用（房间 + 学期 + 数据来源 + 当前引擎），不含任何人员数据
  if (req.method === 'GET' && p === '/api/state') {
    const ds = await loadAuthorizedDataset();
    json(res, 200, {
      sourceType: ds.sourceType,
      sourceLabel: ds.sourceLabel,
      // 引擎必须在第一次任务之前就能告诉前端 —— 否则页面会默认声称"在用 Agnes"，
      // 而服务端其实处于演示引擎模式（界面上的机制说明就成了假话）。
      engine: engineForMode('task'),
      engineByMode: { chat: engineForMode('chat'), task: engineForMode('task') },
      // 分模式的**模型清单**（只有模型 id，绝不含任何密钥）：运维与界面据此核对
      //「聊天走 DashScope 链 / 任务走 Agnes」是否真的生效，而不是只看服务端自述。
      modelsByMode: modelPlan(),
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

  // 语音输入：录音 → 文本（模型只接在 server/llm/asr.ts；未配置 Key 时如实 503）
  if (p === '/api/agent/transcribe') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed', message: '请用 POST' });
      return;
    }
    await handleTranscribe(req, res);
    return;
  }

  // 语音词汇体检：只读地回答"我登记的词到底落在哪条链路上"，不写文件、不写库、不打上游
  if (p === '/api/agent/asr-lexicon-check') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method_not_allowed', message: '请用 POST' });
      return;
    }
    await handleAsrLexiconCheck(req, res);
    return;
  }

  // 视觉边缘上报与查询：report 由 HMAC 自鉴权（security/http.ts 豁免登录），
  // 其余子路径沿用统一登录身份。数据面见 server/vision/monitor.ts。
  if (p.startsWith('/api/vision/')) {
    await handleVisionApi(req, res, p, url.searchParams);
    return;
  }

  // 主系统调度器的机器到机器通道：到点让 Agent 真跑一轮（HMAC 自鉴权，见 security/http.ts 豁免）
  if (p.startsWith('/api/service/')) {
    await handleServiceAgent(req, res, p);
    return;
  }

  // ops.v1（阶段 2B）：任务 / 提案决策 / 回执 / 能力协商
  if (
    p === '/api/capabilities' ||
    p.startsWith('/api/tasks') ||
    p.startsWith('/api/proposals') ||
    p.startsWith('/api/operations')
  ) {
    if (await handleTasksApi(req, res, p)) return;
    await readJsonBody(req).catch(() => undefined);
    json(res, 405, { error: 'method_not_allowed', message: `不支持的操作：${req.method} ${p}` });
    return;
  }

  // 会话 API（M1 持久化）：列表/创建/详情/改名/软删除 + 带落库的消息 SSE
  if (p.startsWith('/api/conversations') || /^\/api\/runs\/[^/]+(\/cancel)?$/.test(p)) {
    if (await handleConversations(req, res, p)) return;
    await readJsonBody(req).catch(() => undefined);
    json(res, 405, { error: 'method_not_allowed', message: `不支持的操作：${req.method} ${p}` });
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
    ds = authMode()==='native'?null:loadDataset(true);
  } catch (err) {
    console.error('[启动失败] 数据层无法初始化：', (err as Error).message);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    // 兜底：路由层任何未捕获异常都不能把进程带崩
    const t0 = Date.now();
    withHttpIdentity(req, res, () => route(req, res))
      .catch((err: unknown) => {
        log.error('route_unhandled_error', { url: req.url, message: (err as Error).message });
        if (!res.headersSent) json(res, 500, { error: 'internal_error', message: '服务端内部错误' });
        else res.end();
      })
      .finally(() => {
        log.debug('request_done', { method: req.method, url: req.url, ms: Date.now() - t0, status: res.statusCode });
      });
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log('────────────────────────────────────────────────────────────');
    console.log(' LabOps Agent · 可靠任务助手与业务工作台 服务端已启动');
    console.log('────────────────────────────────────────────────────────────');
    for (const line of describeConfig(cfg)) console.log(' ' + line);
    if(ds){
      console.log(' 数据来源        : ' + ds.sourceLabel + '（' + ds.sourceType + '）');
      console.log(' 规模            : labs ' + ds.labs.length + ' / openLabs ' + ds.openLabs.length + ' / timetable ' + ds.timetable.length);
      console.log(' 学期            : ' + ds.term.term + '，起始日 ' + (ds.term.termStart ?? '未配置'));
      console.log(' 快照完整性      : ' + verifySnapshotIntegrity());
    }else console.log(' 数据来源        : 登录后按实际主系统账号授权实时查询；健康检查不代表用户已授权');
    console.log(' Prompt 版本     : ' + PROMPT_VERSION);
    console.log(' 监听            : http://' + cfg.host + ':' + cfg.port);
    console.log(' API             : GET  /api/agent/health   GET /api/state   POST /api/agent/chat (SSE)');
    console.log('                   GET /api/capabilities  GET /api/tasks  POST /api/tasks/:id/decisions');
    if (ds?.warnings.length) {
      console.log(' 载入告警:');
      for (const w of ds.warnings) console.log('   - ' + w);
    }
    if (!cfg.agnes.apiKey) {
      console.log(' ');
      console.log(authMode()==='native'?' 未配置 AGNES_API_KEY → 使用确定性事实与固定规则引擎，未调用大模型。':' 未配置 AGNES_API_KEY → 使用隔离演示引擎。');
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
